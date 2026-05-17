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
import {
  enrich, createMemory, appendIdentity, updateIdentitySection,
  // Reads for the Knowledge editor UI
  listMemories, readMemory, getIdentityAll, listGraphNodes, searchGraphNodes, getGraphSubgraph, getFullGraph,
  listSnapshots,
  // Writes (each auto-snapshots before the destructive op)
  updateMemory, deleteMemory, rewriteIdentitySection,
  updateGraphNode, deleteGraphNode, updateGraphEdge, deleteGraphEdge,
  createGraphNode, createGraphEdge,
  createSnapshot, restoreSnapshot,
} from './thalamus.js';
import {
  enqueueMemorization,
  listJobs as listMemorizationJobs,
  acknowledgeJob as acknowledgeMemorizationJob,
  cancelJob as cancelMemorizationJob,
  startMemorizationWorker,
  findOrCreateSessionMemoriesTome,
} from './memorization.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure the logs directory exists next to server.js
const LOGS_DIR = path.join(__dirname, 'logs');
mkdirSync(LOGS_DIR, { recursive: true });

// Only allow UUID-shaped IDs to prevent path traversal and bound input size.
// Used for session IDs, tome IDs, entry UIDs, and memorization job IDs — all
// of which are generated via crypto.randomUUID() and share the same shape.
function isValidUUID(id) {
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

// Simple in-memory rate limiter for /api/chat: max 20 requests per minute per IP.
// Protects against accidental public exposure and runaway tool-call loops.
const _chatRateCounts = new Map();
function chatRateLimit(req, res, next) {
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  const now = Date.now();
  const WINDOW_MS = 60_000;
  const MAX_REQ   = 20;
  const entry = _chatRateCounts.get(ip) ?? { count: 0, resetAt: now + WINDOW_MS };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + WINDOW_MS; }
  entry.count++;
  _chatRateCounts.set(ip, entry);
  if (entry.count > MAX_REQ) {
    return res.status(429).json({ error: 'Too many requests. Please wait a moment before sending another message.' });
  }
  next();
}

/**
 * POST /api/chat
 * Body: { provider, apiKey, model, messages, stream, temperature?, max_tokens? }
 * Proxies to the chosen provider and streams or returns the response.
 */
app.post('/api/chat', chatRateLimit, async (req, res) => {
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
    // Attach the actual entity-core block that thalamus injected, so the
    // client's prompt inspector can show what was sent verbatim (without
    // re-running enrich() and risking drift). On parse failure or upstream
    // error, fall through to a raw passthrough.
    if (entityContext && upstream.ok) {
      try {
        const parsed = JSON.parse(text);
        parsed._thalamus = { entityContext };
        return res.send(JSON.stringify(parsed));
      } catch { /* upstream returned non-JSON — pass through unchanged */ }
    }
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

  // Emit the thalamus envelope as the first SSE data event, BEFORE the
  // upstream stream, so the client has it by the time the prompt inspector
  // could be opened. Uses the same `data: ` line format as the upstream
  // SSE stream; the client routes on the presence of `_thalamus` instead
  // of `choices`.
  if (entityContext) {
    res.write(`data: ${JSON.stringify({ _thalamus: { entityContext } })}\n\n`);
  }

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
 *
 * WARNING: This endpoint returns entity-core enriched context (personal memory /
 * identity data) with no authentication. Keep it disabled or firewalled in any
 * deployment outside localhost.
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
  if (!isValidUUID(sessionId))
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
  if (!isValidUUID(id))
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
  if (!isValidUUID(id))
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


// True for filenames that look like a tome file (i.e. not the memorization
// queue dotfile or any other hidden bookkeeping file we drop in TOMES_DIR).
function isTomeFile(f) {
  return f.endsWith('.json') && !f.startsWith('.');
}

// Returns the absolute path for a tome file, falling back to a directory scan
// so that pre-existing tomes with non-UUID filenames (e.g. "ADHD-Tome.json") are found.
async function findTomeFile(id) {
  const direct = path.join(TOMES_DIR, `${id}.json`);
  try {
    await fsp.access(direct);
    return direct;
  } catch { /* not found by UUID filename — scan */ }
  const files = await fsp.readdir(TOMES_DIR);
  for (const f of files) {
    if (!isTomeFile(f)) continue;
    try {
      const raw = await fsp.readFile(path.join(TOMES_DIR, f), 'utf8');
      const data = JSON.parse(raw);
      if (data.id === id) return path.join(TOMES_DIR, f);
    } catch { /* skip corrupt */ }
  }
  return direct; // default path for newly created tomes
}

async function readTome(id) {
  try {
    const filePath = await findTomeFile(id);
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeTome(tome) {
  const filePath = await findTomeFile(tome.id);
  await fsp.writeFile(filePath, JSON.stringify(tome, null, 2), 'utf8');
}

// GET /api/tomes — list all tomes (metadata + entry count)
app.get('/api/tomes', async (_req, res) => {
  try {
    const files = await fsp.readdir(TOMES_DIR);
    const tomes = [];
    for (const f of files) {
      if (!isTomeFile(f)) continue;
      try {
        const raw = await fsp.readFile(path.join(TOMES_DIR, f), 'utf8');
        const { id, name, description, enabled, entries } = JSON.parse(raw);
        if (!id) continue; // not a tome (no id) — skip rather than poison the registry
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

// GET /api/tomes/session-memories — find or create the special Session
// Memories tome (the system tome that receives all session memorization
// output, auto-summarized or manually marked). Always present: created on
// first lookup. Shares find-or-create logic with the memorization worker
// via memorization.js so concurrent calls can't produce duplicates.
// Must be registered BEFORE GET /api/tomes/:id so it isn't shadowed.
app.get('/api/tomes/session-memories', async (_req, res) => {
  try {
    const { tome } = await findOrCreateSessionMemoriesTome();
    res.json({
      id:          tome.id,
      name:        tome.name,
      description: tome.description ?? '',
      enabled:     tome.enabled !== false,
      entryCount:  Object.keys(tome.entries ?? {}).length,
    });
  } catch {
    res.status(500).json({ error: 'Failed to find or create Session Memories tome.' });
  }
});

// GET /api/tomes/:id — get a full tome with entries
app.get('/api/tomes/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
  const tome = await readTome(id);
  if (!tome) return res.status(404).json({ error: 'Tome not found.' });
  res.json(tome);
});

// PUT /api/tomes/:id — save full tome (entries + optional metadata)
app.put('/api/tomes/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
  const { name, description, enabled, entries } = req.body;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries))
    return res.status(400).json({ error: 'entries object required.' });
  const existing = await readTome(id);
  if (!existing) return res.status(404).json({ error: 'Tome not found.' });
  const safe = {};
  for (const [uid, entry] of Object.entries(entries)) {
    if (!isValidUUID(uid)) continue;
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
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
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
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
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
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid tome ID.' });
  if (!isValidUUID(uid)) return res.status(400).json({ error: 'Invalid entry UID.' });
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

// ── Memorization queue endpoints ────────────────────────────────

// POST /api/memorize — enqueue a memorization job.
// Accepts JSON body OR sendBeacon's text/plain JSON for beforeunload.
app.post('/api/memorize', express.text({ type: ['text/plain', 'application/json'], limit: '4mb' }), async (req, res) => {
  // express.json() above this route already consumed application/json bodies
  // into req.body. For sendBeacon (text/plain), parse it here.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON.' }); }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Request body required.' });
  }
  const { sessionId, scope, topicId, topicLabel, messageRange, messages, provider, apiKey, model } = body;
  if (!isValidUUID(sessionId))
    return res.status(400).json({ error: 'Invalid session ID.' });
  try {
    const { jobId, deduped } = await enqueueMemorization({
      sessionId, scope, topicId, topicLabel, messageRange, messages, provider, apiKey, model,
    });
    res.status(202).json({ jobId, deduped });
  } catch (err) {
    res.status(400).json({ error: err.message ?? 'Failed to enqueue memorization.' });
  }
});

// GET /api/memorize — list all jobs (sanitized, no apiKey or messages)
app.get('/api/memorize', async (_req, res) => {
  try {
    res.json(await listMemorizationJobs());
  } catch {
    res.json([]);
  }
});

// POST /api/memorize/:id/ack — mark a terminal job as seen by the UI
app.post('/api/memorize/:id/ack', async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid job ID.' });
  const ok = await acknowledgeMemorizationJob(id);
  if (!ok) return res.status(404).json({ error: 'Job not found or not terminal.' });
  res.json({ ok: true });
});

// DELETE /api/memorize/:id — cancel a pending job
app.delete('/api/memorize/:id', async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid job ID.' });
  const ok = await cancelMemorizationJob(id);
  if (!ok) return res.status(409).json({ error: 'Job not found or already running.' });
  res.json({ ok: true });
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

// ── Entity-core editing endpoints (Knowledge editor UI + LLM write tools) ──
//
// All destructive ops auto-snapshot on the thalamus side via snapshot_create
// before calling the entity-core tool, so the Snapshots tab in the UI lets
// the user roll back if something goes sideways.

const VALID_MEMORY_DATE_RE = /^\d{4}(-W\d{2}|(-\d{2})?(-\d{2})?)$/;
const VALID_GRAPH_ID_RE    = /^[\w-]{1,128}$/;
const VALID_SECTION_RE     = /^[\w\s\-()&'?!,.:/]{1,200}$/; // markdown headings — permissive but bounded
const VALID_SNAPSHOT_ID_RE = /^[\w.\-:]{1,200}$/;

function badRequest(res, message) { return res.status(400).json({ error: message }); }
function gatewayDown(res, err)    { return res.status(502).json({ error: err ?? 'entity-core unavailable' }); }

// ── Memory ────────────────────────────────────────────────────────────────
app.get('/api/entity/memories', async (req, res) => {
  const { granularity, limit } = req.query;
  if (granularity && !VALID_MEMORY_GRANULARITIES.has(granularity))
    return badRequest(res, `granularity must be one of: ${[...VALID_MEMORY_GRANULARITIES].join(', ')}.`);
  const n = limit !== undefined ? Math.max(1, Math.min(100, parseInt(limit, 10) || 50)) : 50;
  try { res.json(await listMemories({ granularity, limit: n })); }
  catch (err) { gatewayDown(res, err.message); }
});

app.get('/api/entity/memories/:granularity/:date', async (req, res) => {
  const { granularity, date } = req.params;
  if (!VALID_MEMORY_GRANULARITIES.has(granularity)) return badRequest(res, 'invalid granularity');
  if (!VALID_MEMORY_DATE_RE.test(date))             return badRequest(res, 'invalid date format');
  try { res.json(await readMemory({ granularity, date })); }
  catch (err) { gatewayDown(res, err.message); }
});

app.put('/api/entity/memories/:granularity/:date', async (req, res) => {
  const { granularity, date } = req.params;
  const { content, editedBy } = req.body;
  if (!VALID_MEMORY_GRANULARITIES.has(granularity)) return badRequest(res, 'invalid granularity');
  if (!VALID_MEMORY_DATE_RE.test(date))             return badRequest(res, 'invalid date format');
  if (typeof content !== 'string' || !content.trim()) return badRequest(res, 'content required');
  if (content.length > 16384)                       return badRequest(res, 'content exceeds 16 KB limit');
  const result = await updateMemory({ granularity, date, content: content.trim(), editedBy });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.delete('/api/entity/memories/:granularity/:date', async (req, res) => {
  const { granularity, date } = req.params;
  if (!VALID_MEMORY_GRANULARITIES.has(granularity)) return badRequest(res, 'invalid granularity');
  if (!VALID_MEMORY_DATE_RE.test(date))             return badRequest(res, 'invalid date format');
  const result = await deleteMemory({ granularity, date, instanceId: req.query.instanceId, slug: req.query.slug });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

// "Supersede" — write a new memory contradicting an old one. Doesn't delete
// the original; the recency-decay scoring will demote it naturally over
// time while preserving the audit trail.
app.post('/api/entity/memories/supersede', async (req, res) => {
  const { content, granularity = 'daily', supersedes } = req.body;
  if (typeof content !== 'string' || !content.trim()) return badRequest(res, 'content required');
  if (!VALID_MEMORY_GRANULARITIES.has(granularity))   return badRequest(res, 'invalid granularity');
  const today = new Date().toISOString().slice(0, 10);
  const body  = supersedes
    ? `[supersedes ${supersedes.granularity ?? 'memory'}/${supersedes.date ?? '?'}]\n${content.trim()}`
    : content.trim();
  const result = await createMemory({ content: body, granularity, date: today });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json({ ok: true, date: today });
});

// ── Identity ──────────────────────────────────────────────────────────────
app.get('/api/entity/identity', async (_req, res) => {
  try { res.json(await getIdentityAll()); }
  catch (err) { gatewayDown(res, err.message); }
});

app.put('/api/entity/identity/:category/:filename/sections/:section', async (req, res) => {
  const { category, filename, section } = req.params;
  const { content } = req.body;
  if (!VALID_IDENTITY_CATEGORIES.has(category)) return badRequest(res, 'invalid category');
  if (!VALID_FILENAME_RE.test(filename))        return badRequest(res, 'invalid filename');
  if (!VALID_SECTION_RE.test(section))          return badRequest(res, 'invalid section heading');
  if (typeof content !== 'string')              return badRequest(res, 'content required');
  if (content.length > 16384)                   return badRequest(res, 'content exceeds 16 KB limit');
  const result = await rewriteIdentitySection({ category, filename, section, content });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

// ── Graph ─────────────────────────────────────────────────────────────────
app.get('/api/entity/graph/nodes', async (req, res) => {
  const { type, limit, offset } = req.query;
  const n = limit  !== undefined ? Math.max(1, Math.min(500, parseInt(limit, 10)  || 200)) : 200;
  const o = offset !== undefined ? Math.max(0, parseInt(offset, 10) || 0) : 0;
  try { res.json(await listGraphNodes({ type, limit: n, offset: o })); }
  catch (err) { gatewayDown(res, err.message); }
});

// Text search across graph nodes — backs the find_graph_node LLM tool so
// the Familiar can resolve a name ("Eury", "Chen") to a graph id without
// loading the full node list.
app.get('/api/entity/graph/search', async (req, res) => {
  const { q, type, limit } = req.query;
  if (!q || typeof q !== 'string' || !q.trim()) return badRequest(res, 'q (query) is required');
  const n = limit !== undefined ? Math.max(1, Math.min(100, parseInt(limit, 10) || 10)) : 10;
  try { res.json(await searchGraphNodes({ query: q.trim(), type, limit: n })); }
  catch (err) { gatewayDown(res, err.message); }
});

// Full-graph dump for the Map view: every node + every deduplicated edge.
// O(N) subgraph calls under the hood; capped via the limit param.
app.get('/api/entity/graph/full', async (req, res) => {
  const { type, limit } = req.query;
  const n = limit !== undefined ? Math.max(1, Math.min(500, parseInt(limit, 10) || 500)) : 500;
  try { res.json(await getFullGraph({ type, limit: n })); }
  catch (err) { gatewayDown(res, err.message); }
});

app.get('/api/entity/graph/nodes/:id/subgraph', async (req, res) => {
  const { id } = req.params;
  if (!VALID_GRAPH_ID_RE.test(id)) return badRequest(res, 'invalid id');
  const depth = Math.max(1, Math.min(3, parseInt(req.query.depth, 10) || 1));
  try { res.json(await getGraphSubgraph({ nodeId: id, depth })); }
  catch (err) { gatewayDown(res, err.message); }
});

app.post('/api/entity/graph/nodes', async (req, res) => {
  const { label, type, description } = req.body ?? {};
  if (label       !== undefined && typeof label       !== 'string') return badRequest(res, 'label must be string');
  if (type        !== undefined && typeof type        !== 'string') return badRequest(res, 'type must be string');
  if (description !== undefined && typeof description !== 'string') return badRequest(res, 'description must be string');
  if (!label && !type && !description) return badRequest(res, 'at least one of label / type / description is required');
  const result = await createGraphNode({ label, type, description });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.post('/api/entity/graph/edges', async (req, res) => {
  const { fromId, toId, type, weight } = req.body ?? {};
  if (!fromId || !VALID_GRAPH_ID_RE.test(fromId)) return badRequest(res, 'valid fromId is required');
  if (!toId   || !VALID_GRAPH_ID_RE.test(toId))   return badRequest(res, 'valid toId is required');
  if (fromId === toId) return badRequest(res, 'fromId and toId must differ');
  if (type !== undefined && typeof type !== 'string') return badRequest(res, 'type must be string');
  if (weight !== undefined && (typeof weight !== 'number' || weight < 0 || weight > 1))
    return badRequest(res, 'weight must be a number in [0, 1]');
  const result = await createGraphEdge({ fromId, toId, type, weight });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.patch('/api/entity/graph/nodes/:id', async (req, res) => {
  const { id } = req.params;
  if (!VALID_GRAPH_ID_RE.test(id)) return badRequest(res, 'invalid id');
  const { label, description, type } = req.body;
  if (label !== undefined && typeof label !== 'string')             return badRequest(res, 'label must be string');
  if (description !== undefined && typeof description !== 'string') return badRequest(res, 'description must be string');
  if (type !== undefined && typeof type !== 'string')               return badRequest(res, 'type must be string');
  const result = await updateGraphNode({ id, label, description, type });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.delete('/api/entity/graph/nodes/:id', async (req, res) => {
  const { id } = req.params;
  if (!VALID_GRAPH_ID_RE.test(id)) return badRequest(res, 'invalid id');
  const permanent = req.query.permanent === '1' || req.query.permanent === 'true';
  const result = await deleteGraphNode({ id, permanent });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.patch('/api/entity/graph/edges/:id', async (req, res) => {
  const { id } = req.params;
  if (!VALID_GRAPH_ID_RE.test(id)) return badRequest(res, 'invalid id');
  const { type, weight } = req.body;
  if (type !== undefined && typeof type !== 'string') return badRequest(res, 'type must be string');
  if (weight !== undefined && (typeof weight !== 'number' || weight < 0 || weight > 1))
    return badRequest(res, 'weight must be a number in [0, 1]');
  const result = await updateGraphEdge({ id, type, weight });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.delete('/api/entity/graph/edges/:id', async (req, res) => {
  const { id } = req.params;
  if (!VALID_GRAPH_ID_RE.test(id)) return badRequest(res, 'invalid id');
  const result = await deleteGraphEdge({ id });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

// ── Snapshots ─────────────────────────────────────────────────────────────
app.get('/api/entity/snapshots', async (_req, res) => {
  try { res.json(await listSnapshots()); }
  catch (err) { gatewayDown(res, err.message); }
});

app.post('/api/entity/snapshots', async (_req, res) => {
  const result = await createSnapshot();
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

app.post('/api/entity/snapshots/:id/restore', async (req, res) => {
  const { id } = req.params;
  if (!VALID_SNAPSHOT_ID_RE.test(id)) return badRequest(res, 'invalid snapshot id');
  const result = await restoreSnapshot({ snapshotId: id });
  if (!result.ok) return gatewayDown(res, result.error);
  res.json(result.result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nProto-Familiar running at http://localhost:${PORT}\n`);
  startMemorizationWorker();
});
