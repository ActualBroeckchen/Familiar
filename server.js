/**
 * Proto-Familiar — lightweight LLM frontend server
 * Proxies chat requests to z.ai and NanoGPT, avoiding CORS issues.
 * Requires Node.js 18+ (uses built-in fetch).
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, promises as fsp } from 'fs';
import { randomUUID } from 'crypto';
import { enrich, createMemory, appendIdentity, updateIdentitySection } from './thalamus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure the logs directory exists next to server.js
const LOGS_DIR = path.join(__dirname, 'logs');
mkdirSync(LOGS_DIR, { recursive: true });

// Only allow UUID-shaped session IDs to prevent path traversal
function isValidSessionId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Provider base URLs — all use OpenAI-compatible chat completions format
// zai-coding uses the Coding Plan endpoint (separate quota from the standard API)
const PROVIDER_URLS = {
  nanogpt:     'https://nano-gpt.com/api/v1/chat/completions',
  zai:         'https://api.z.ai/api/paas/v4/chat/completions',
  'zai-coding': 'https://api.z.ai/api/coding/paas/v4/chat/completions',
};

/**
 * POST /api/chat
 * Body: { provider, apiKey, model, messages, stream, temperature?, max_tokens? }
 * Proxies to the chosen provider and streams or returns the response.
 */
app.post('/api/chat', async (req, res) => {
  const { provider, apiKey, model, messages, stream, temperature, max_tokens, tools, tool_choice } = req.body;

  const url = PROVIDER_URLS[provider];
  if (!url) {
    return res.status(400).json({ error: `Unknown provider: "${provider}". Expected "nanogpt", "zai", or "zai-coding".` });
  }
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    return res.status(400).json({ error: 'API key is required.' });
  }
  if (!model || typeof model !== 'string' || !model.trim()) {
    return res.status(400).json({ error: 'Model name is required.' });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required and must not be empty.' });
  }

  // Enrich with entity-core context (memories + identity). Degrades gracefully.
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : ((lastUser?.content ?? []).find(c => c.type === 'text')?.text ?? '');
  const entityContext = await enrich(userText);

  let enrichedMessages = messages;
  if (entityContext) {
    const sysIdx = messages.findIndex(m => m.role === 'system');
    if (sysIdx >= 0) {
      enrichedMessages = messages.map((m, i) =>
        i === sysIdx ? { ...m, content: entityContext + '\n\n' + m.content } : m,
      );
    } else {
      enrichedMessages = [{ role: 'system', content: entityContext }, ...messages];
    }
  }

  const payload = { model: model.trim(), messages: enrichedMessages, stream: !!stream };
  if (typeof temperature === 'number') payload.temperature = temperature;
  if (typeof max_tokens === 'number' && max_tokens > 0) payload.max_tokens = max_tokens;
  if (Array.isArray(tools) && tools.length > 0) payload.tools = tools;
  if (tool_choice !== undefined) payload.tool_choice = tool_choice;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return res.status(502).json({ error: `Network error reaching ${provider}: ${err.message}` });
  }

  // Non-streaming path
  if (!stream) {
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    return res.send(text);
  }

  // Streaming path — detect if provider returned a JSON error instead of SSE
  const ct = upstream.headers.get('content-type') || '';
  if (!upstream.ok || ct.includes('application/json')) {
    const text = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', 'application/json');
    return res.send(text);
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if behind a proxy

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      res.write(Buffer.from(value));
    }
  } catch (err) {
    if (!res.writableEnded) res.end();
  }
});

/**
 * POST /api/debug-prompt
 * Body: { messages }
 * Returns the full message array that would be sent to the LLM for a given
 * messages payload — including entity-core enrichment prepended to the system
 * message. Does NOT call any upstream LLM.
 */
app.post('/api/debug-prompt', async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required.' });
  }

  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const userText = typeof lastUser?.content === 'string'
    ? lastUser.content
    : ((lastUser?.content ?? []).find(c => c.type === 'text')?.text ?? '');
  const entityContext = await enrich(userText);

  let enrichedMessages = messages;
  if (entityContext) {
    const sysIdx = messages.findIndex(m => m.role === 'system');
    if (sysIdx >= 0) {
      enrichedMessages = messages.map((m, i) =>
        i === sysIdx ? { ...m, content: entityContext + '\n\n' + m.content } : m,
      );
    } else {
      enrichedMessages = [{ role: 'system', content: entityContext }, ...messages];
    }
  }

  res.json({ messages: enrichedMessages });
});

// ── Log endpoints ───────────────────────────────────────────────

// POST /api/log — create or overwrite a session log file
app.post('/api/log', async (req, res) => {
  const { sessionId, startedAt, endedAt, provider, model, messages } = req.body;
  if (!isValidSessionId(sessionId))
    return res.status(400).json({ error: 'Invalid session ID.' });
  if (!Array.isArray(messages))
    return res.status(400).json({ error: 'messages must be an array.' });

  const logPath = path.join(LOGS_DIR, `${sessionId}.json`);
  const data = {
    sessionId, startedAt, endedAt: endedAt || null, provider, model, messages,
    updatedAt: new Date().toISOString(),
  };
  try {
    await fsp.writeFile(logPath, JSON.stringify(data, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to write log.' });
  }
});

// GET /api/logs — list all sessions (metadata only)
app.get('/api/logs', async (_req, res) => {
  try {
    const files = await fsp.readdir(LOGS_DIR);
    const sessions = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(LOGS_DIR, f), 'utf8');
        const { sessionId, startedAt, endedAt, updatedAt, provider, model, messages } = JSON.parse(raw);
        sessions.push({ sessionId, startedAt, endedAt, updatedAt, provider, model,
          messageCount: Array.isArray(messages) ? messages.length : 0 });
      } catch { /* skip corrupt files */ }
    }
    sessions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
    res.json(sessions);
  } catch {
    res.json([]);
  }
});

// GET /api/logs/:id — retrieve a full session log
app.get('/api/logs/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id))
    return res.status(400).json({ error: 'Invalid session ID.' });
  try {
    const raw = await fsp.readFile(path.join(LOGS_DIR, `${id}.json`), 'utf8');
    res.setHeader('Content-Type', 'application/json');
    res.send(raw);
  } catch {
    res.status(404).json({ error: 'Session not found.' });
  }
});

// DELETE /api/logs/:id — remove a session log
app.delete('/api/logs/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidSessionId(id))
    return res.status(400).json({ error: 'Invalid session ID.' });
  try {
    await fsp.unlink(path.join(LOGS_DIR, `${id}.json`));
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Session not found.' });
  }
});

// Health check
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── Tome endpoints ──────────────────────────────────────────────
const TOMES_DIR = path.join(__dirname, 'tomes');
mkdirSync(TOMES_DIR, { recursive: true });

function isValidTomeId(id) {
  return typeof id === 'string' && /^[0-9a-f\-]{8,64}$/i.test(id) && !id.includes('..');
}

function isValidEntryUid(uid) {
  return typeof uid === 'string' && /^[0-9a-f\-]{8,64}$/i.test(uid) && !uid.includes('..');
}

async function readTome(id) {
  try {
    const raw = await fsp.readFile(path.join(TOMES_DIR, `${id}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeTome(tome) {
  await fsp.writeFile(path.join(TOMES_DIR, `${tome.id}.json`), JSON.stringify(tome, null, 2), 'utf8');
}

// GET /api/tomes — list all tomes (metadata + entry count)
app.get('/api/tomes', async (_req, res) => {
  try {
    const files = await fsp.readdir(TOMES_DIR);
    const tomes = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(TOMES_DIR, f), 'utf8');
        const { id, name, description, enabled, entries } = JSON.parse(raw);
        tomes.push({ id, name, description, enabled, entryCount: Object.keys(entries ?? {}).length });
      } catch { /* skip corrupt */ }
    }
    tomes.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    res.json(tomes);
  } catch {
    res.json([]);
  }
});

// POST /api/tomes — create a new tome
app.post('/api/tomes', async (req, res) => {
  const { name, description } = req.body;
  if (!name || typeof name !== 'string' || !name.trim())
    return res.status(400).json({ error: 'name is required.' });
  const id = randomUUID();
  const tome = { id, name: name.trim(), description: (description ?? '').trim(), enabled: true, entries: {} };
  try {
    await writeTome(tome);
    res.json({ id });
  } catch {
    res.status(500).json({ error: 'Failed to create tome.' });
  }
});

// GET /api/tomes/:id — get a full tome with entries
app.get('/api/tomes/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidTomeId(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
  const tome = await readTome(id);
  if (!tome) return res.status(404).json({ error: 'Tome not found.' });
  res.json(tome);
});

// PUT /api/tomes/:id — save full tome (entries + optional metadata)
app.put('/api/tomes/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidTomeId(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
  const { name, description, enabled, entries } = req.body;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries))
    return res.status(400).json({ error: 'entries object required.' });
  const existing = await readTome(id);
  if (!existing) return res.status(404).json({ error: 'Tome not found.' });
  const safe = {};
  for (const [uid, entry] of Object.entries(entries)) {
    if (!isValidEntryUid(uid)) continue;
    safe[uid] = entry;
  }
  const updated = {
    ...existing,
    name:        name !== undefined ? (String(name).trim() || existing.name) : existing.name,
    description: description !== undefined ? String(description ?? '').trim() : (existing.description ?? ''),
    enabled:     enabled !== undefined ? !!enabled : existing.enabled,
    entries:     safe,
  };
  try {
    await writeTome(updated);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to save tome.' });
  }
});

// PATCH /api/tomes/:id — update metadata only (name, description, enabled)
app.patch('/api/tomes/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidTomeId(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
  const tome = await readTome(id);
  if (!tome) return res.status(404).json({ error: 'Tome not found.' });
  if (req.body.name !== undefined) tome.name = String(req.body.name).trim() || tome.name;
  if (req.body.description !== undefined) tome.description = String(req.body.description ?? '').trim();
  if (req.body.enabled !== undefined) tome.enabled = !!req.body.enabled;
  try {
    await writeTome(tome);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to update tome.' });
  }
});

// DELETE /api/tomes/:id — delete a tome
app.delete('/api/tomes/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidTomeId(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
  try {
    await fsp.unlink(path.join(TOMES_DIR, `${id}.json`));
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Tome not found.' });
  }
});

// DELETE /api/tomes/:id/entries/:uid — remove a single entry
app.delete('/api/tomes/:id/entries/:uid', async (req, res) => {
  const { id, uid } = req.params;
  if (!isValidTomeId(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
  if (!isValidEntryUid(uid)) return res.status(400).json({ error: 'Invalid entry UID.' });
  const tome = await readTome(id);
  if (!tome) return res.status(404).json({ error: 'Tome not found.' });
  if (!tome.entries?.[uid]) return res.status(404).json({ error: 'Entry not found.' });
  delete tome.entries[uid];
  try {
    await writeTome(tome);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to save tome.' });
  }
});

// POST /api/tomes/default/entries — add a single entry to the default (first enabled) tome.
// Used by the save_to_tome LLM tool so the model can write knowledge back mid-conversation.
app.post('/api/tomes/default/entries', async (req, res) => {
  const { comment, content, keys, learnedAt } = req.body;
  if (!content || typeof content !== 'string' || !content.trim())
    return res.status(400).json({ error: 'content is required.' });
  if (content.length > 16384)
    return res.status(400).json({ error: 'content exceeds 16 KB limit.' });
  if (comment !== undefined && typeof comment !== 'string')
    return res.status(400).json({ error: 'comment must be a string.' });

  // Accept keys as string[] or comma-separated string
  let normKeys = [];
  if (Array.isArray(keys)) {
    normKeys = keys.map(k => String(k).trim()).filter(Boolean);
  } else if (typeof keys === 'string') {
    normKeys = keys.split(',').map(k => k.trim()).filter(Boolean);
  }

  try {
    // Find first enabled tome, or create "General"
    const files = await fsp.readdir(TOMES_DIR);
    let targetTome = null;
    for (const f of files.sort()) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(TOMES_DIR, f), 'utf8');
        const t = JSON.parse(raw);
        if (t.enabled) { targetTome = t; break; }
      } catch { /* skip corrupt */ }
    }
    if (!targetTome) {
      const newId = randomUUID();
      targetTome = { id: newId, name: 'General', description: '', enabled: true, entries: {} };
      await writeTome(targetTome);
    } else {
      // Re-read a fresh copy so we merge correctly
      const fresh = await readTome(targetTome.id);
      if (fresh) targetTome = fresh;
    }

    const uid  = randomUUID();
    const now  = new Date().toISOString();
    targetTome.entries[uid] = {
      uid,
      comment:             typeof comment === 'string' ? comment.trim() || 'Auto-saved entry' : 'Auto-saved entry',
      keys:                normKeys,
      keysecondary:        [],
      content:             content.trim(),
      constant:            false,
      selective:           false,
      selectiveLogic:      0,
      enabled:             true,
      position:            0,
      depth:               4,
      role:                0,
      scanDepth:           null,
      caseSensitive:       null,
      matchWholeWords:     null,
      probability:         100,
      sticky:              null,
      cooldown:            null,
      preventRecursion:    false,
      delayUntilRecursion: false,
      excludeRecursion:    false,
      group:               '',
      groupWeight:         null,
      insertion_order:     100,
      created_at:          now,
      learnedAt:           (typeof learnedAt === 'string' && learnedAt) ? learnedAt : now,
    };
    await writeTome(targetTome);
    res.json({ ok: true, tomeId: targetTome.id, uid });
  } catch {
    res.status(500).json({ error: 'Failed to save entry.' });
  }
});

// ── Entity-core write endpoints ─────────────────────────────────

const VALID_MEMORY_GRANULARITIES = new Set(['daily', 'weekly', 'monthly', 'yearly', 'significant']);
const VALID_IDENTITY_CATEGORIES  = new Set(['self', 'user', 'relationship', 'custom']);
const VALID_FILENAME_RE           = /^[\w]+\.md$/;

// POST /api/entity/memory — write a new memory entry to entity-core
app.post('/api/entity/memory', async (req, res) => {
  const { content, granularity = 'daily', date } = req.body;
  if (!content || typeof content !== 'string' || !content.trim())
    return res.status(400).json({ error: 'content is required.' });
  if (content.length > 8192)
    return res.status(400).json({ error: 'content exceeds 8 KB limit.' });
  if (!VALID_MEMORY_GRANULARITIES.has(granularity))
    return res.status(400).json({ error: `granularity must be one of: ${[...VALID_MEMORY_GRANULARITIES].join(', ')}.` });

  const result = await createMemory({ content: content.trim(), granularity, date });
  if (!result.ok) return res.status(502).json({ error: result.error ?? 'entity-core unavailable' });
  res.json({ ok: true });
});

// POST /api/entity/identity — append to or update a section of an entity-core identity file
app.post('/api/entity/identity', async (req, res) => {
  const { category, filename, heading, content, mode = 'append' } = req.body;
  if (!VALID_IDENTITY_CATEGORIES.has(category))
    return res.status(400).json({ error: `category must be one of: ${[...VALID_IDENTITY_CATEGORIES].join(', ')}.` });
  if (!filename || !VALID_FILENAME_RE.test(filename))
    return res.status(400).json({ error: 'filename must be a simple .md filename (letters, numbers, underscores).' });
  if (!content || typeof content !== 'string' || !content.trim())
    return res.status(400).json({ error: 'content is required.' });
  if (content.length > 8192)
    return res.status(400).json({ error: 'content exceeds 8 KB limit.' });

  let result;
  if (mode === 'update_section') {
    if (!heading || typeof heading !== 'string' || !heading.trim())
      return res.status(400).json({ error: 'heading is required for update_section mode.' });
    result = await updateIdentitySection({ category, filename, heading: heading.trim(), content: content.trim() });
  } else {
    result = await appendIdentity({ category, filename, content: content.trim() });
  }

  if (!result.ok) return res.status(502).json({ error: result.error ?? 'entity-core unavailable' });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nProto-Familiar running at http://localhost:${PORT}\n`);
});
