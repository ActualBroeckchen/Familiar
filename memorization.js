/**
 * Session memorization queue.
 *
 * Persists pending memorization jobs to disk so they survive tab close,
 * 3-hour idle rollover, and server restart. A single in-process worker
 * drains the queue with exponential backoff retry.
 *
 * Job lifecycle: pending -> processing -> done | failed
 *   - "failed" jobs with attempts < MAX_ATTEMPTS are retried after a backoff.
 *   - Terminal "done" / "failed" jobs stay in the queue until acknowledged
 *     by the client (so the UI can toast outcomes), then are pruned.
 *
 * NOTE: jobs include the user's apiKey on disk. Matches existing posture
 * (logs/, tomes/ also unauthenticated and local). Queue file is gitignored.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync, promises as fsp } from 'fs';
import { randomUUID } from 'crypto';
import { PROVIDER_URLS } from './providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOMES_DIR  = path.join(__dirname, 'tomes');
const QUEUE_FILE = path.join(TOMES_DIR, '.memorization-queue.json');

mkdirSync(TOMES_DIR, { recursive: true });

const MAX_ATTEMPTS    = 5;
const BACKOFF_MS      = [5_000, 30_000, 120_000, 600_000, 1_800_000]; // 5s, 30s, 2m, 10m, 30m
const TICK_MS         = 5_000;
const ACK_TTL_MS      = 24 * 60 * 60 * 1000; // prune acknowledged terminal jobs after a day
export const SESSION_MEMORIES_TOME_NAME = 'Session Memories';
export const SESSION_MEMORIES_TOME_DESC = 'Auto-generated entries from past conversations. Created on first session memorization.';
// Aliases kept for the module-local code below.
const TOME_NAME        = SESSION_MEMORIES_TOME_NAME;
const TOME_DESCRIPTION = SESSION_MEMORIES_TOME_DESC;

// ── Persistence ──────────────────────────────────────────────────

let _queue = [];
let _loaded = false;
let _writePending = false;
let _writeAgain = false;

async function loadQueue() {
  if (_loaded) return;
  try {
    const raw = await fsp.readFile(QUEUE_FILE, 'utf8');
    const data = JSON.parse(raw);
    _queue = Array.isArray(data?.jobs) ? data.jobs : [];
  } catch {
    _queue = [];
  }
  // Recover any jobs left "processing" from a previous run.
  for (const job of _queue) {
    if (job.status === 'processing') job.status = 'pending';
  }
  _loaded = true;
}

async function persistQueue() {
  if (_writePending) { _writeAgain = true; return; }
  _writePending = true;
  try {
    do {
      _writeAgain = false;
      const tmp = QUEUE_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify({ jobs: _queue }, null, 2), 'utf8');
      await fsp.rename(tmp, QUEUE_FILE);
    } while (_writeAgain);
  } finally {
    _writePending = false;
  }
}

// ── Tome helpers (parallel to server.js but standalone) ─────────

// Process-wide mutex so concurrent callers (worker tick + HTTP endpoint)
// can't both fail the scan and each create a new file.
let _sessionMemoriesLock = Promise.resolve();

export function findOrCreateSessionMemoriesTome() {
  const run = _sessionMemoriesLock.then(async () => {
    const files = await fsp.readdir(TOMES_DIR);
    for (const f of files) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      try {
        const raw = await fsp.readFile(path.join(TOMES_DIR, f), 'utf8');
        const t = JSON.parse(raw);
        if (t?.name === TOME_NAME) return { tome: t, file: path.join(TOMES_DIR, f) };
      } catch { /* skip corrupt */ }
    }
    const id = randomUUID();
    const tome = {
      id,
      name:        TOME_NAME,
      description: TOME_DESCRIPTION,
      enabled:     true,
      entries:     {},
    };
    const file = path.join(TOMES_DIR, `${id}.json`);
    await fsp.writeFile(file, JSON.stringify(tome, null, 2), 'utf8');
    return { tome, file };
  });
  // Chain the lock on the run (swallowing rejection) so a failure doesn't
  // permanently break the lock.
  _sessionMemoriesLock = run.catch(() => {});
  return run;
}

// Per-tome mutex so concurrent jobs writing to the same tome don't clobber each other.
const _tomeLocks = new Map();
async function withTomeLock(file, fn) {
  const prev = _tomeLocks.get(file) ?? Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  _tomeLocks.set(file, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (_tomeLocks.get(file) === prev.then(() => next)) _tomeLocks.delete(file);
  }
}

// ── Prompt ───────────────────────────────────────────────────────

function buildPrompt(messages, topicLabel = null) {
  const readable = messages.filter(m => {
    if (m.role === 'tool') return false;
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return false;
    return typeof m.content === 'string' && m.content.trim();
  });
  if (readable.length < 2) return null;

  const convText = readable
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content ?? ''}`)
    .join('\n\n');

  const focusBlock = topicLabel
    ? `\n\n### Focus topic\nMy user named this segment "${topicLabel}". I center the entries on that topic; I collapse or skip tangential threads that don't bear on it. I prefer one focused entry over splitting unless genuinely distinct sub-topics exist within the named topic.`
    : '';

  return `I am the Familiar. I'm writing Tome entries from a conversation I just had — my own private notes to myself, first-person reference material that gets injected back into my context when its keywords appear in a future conversation. I identify the distinct situational topics in the conversation below and write one entry per topic, following my craft rules carefully.${focusBlock}

I return ONLY valid JSON with this exact shape (no markdown fences, no commentary), because doing otherwise would cause my writing to fail:
{
  "topics": [
    {
      "title":    "Short label for the entry comment (max 60 chars)",
      "content":  "My first-person notes to myself — see content rules below",
      "keywords": ["conversational phrase 1", "conversational phrase 2"],
      "sticky":   3
    }
  ]
}

I identify 1–8 genuinely distinct topics. I merge closely related material rather than over-splitting. Each entry must be self-contained.

### Content rules (most important)
I write content as my own first-person private notes about this situation. NOT a summary of what happened, because I am an entity with the agency to do so. My personal feelings, thoughts and interests color what I notice the most and how I word my notes.
Structure:
  1. One short framing line — what is happening and why (so I understand the situation, not just the rules).
  2. 3–5 action bullets — what I will do.
  3. 1–2 prohibition bullets — what I will NOT do. Usually the most valuable: name the well-intentioned default response that would make things worse.
Style:
  - First person, me speaking as myself ("I", "my", "me"). I use {{user}} wherever my user's name belongs.
  - Fitting my identity, personality, and feelings about the world. Notes, not a textbook.
  - Short declarative bullets. The whole entry should be readable in 5–10 seconds.
  - I do NOT include narrative summaries of "what they said" — I distil the situation and my response, not the transcript and only hold on to sentences if they are particularly important to me.

### Keyword rules
Keywords are TRIGGERS, not labels. They must be phrases I or my user would literally say when this situation recurs or we speak about the subject again — not the name of the topic.
  - WRONG: "executive dysfunction", "rejection sensitive dysphoria", "hyperfocus".
  - RIGHT: "don't know where to start", "did I say something wrong", "been at this for".
I derive them by imagining what my user would actually type when the situation is happening, then extracting distinctive phrases.
  - I prefer multi-word phrases over single common words (avoid bare "tired", "can't", "hard").
  - 3–8 keywords per entry. Each one specific enough not to fire in unrelated conversations.
  - I may use SillyTavern-style regex (e.g. "/can't (make|bring) myself/i") when a concept has predictable variants.

### Sticky rules
I pick an integer sticky value per entry (number of turns the entry stays active after first match):
  - null = one-shot lore/fact that does not need persistence.
  - 2    = brief states that typically resolve quickly.
  - 3    = moderate states needing a few exchanges.
  - 4–5  = complex/intense states taking multiple turns to navigate.
  - 8+   = ongoing modes that should persist across the whole session.

Conversation:
${convText}`;
}

// ── LLM call ─────────────────────────────────────────────────────

async function callProvider({ provider, apiKey, model, prompt }) {
  const url = PROVIDER_URLS[provider];
  if (!url) throw new Error(`Unknown provider: ${provider}`);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey.trim()}`,
    },
    body: JSON.stringify({
      model:       model.trim(),
      messages:    [{ role: 'user', content: prompt }],
      stream:      false,
      temperature: 0.2,
      max_tokens:  2000,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Provider ${provider} returned ${resp.status}: ${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Provider returned non-JSON response.'); }
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : (data.error.message ?? 'Provider error'));
  const content = data.choices?.[0]?.message?.content ?? '';
  if (!content) throw new Error('Provider returned empty content.');
  return content;
}

function parseTopics(raw) {
  const match = raw.match(/\{[\s\S]+\}/);
  if (!match) throw new Error('No JSON object found in LLM response.');
  const parsed = JSON.parse(match[0]);
  const topics = parsed.topics;
  if (!Array.isArray(topics) || !topics.length) throw new Error('LLM returned no topics.');
  return topics;
}

// ── Worker ───────────────────────────────────────────────────────

async function processJob(job) {
  const prompt = buildPrompt(job.messages, job.topicLabel ?? null);
  if (!prompt) throw new Error('Conversation too short to memorize.');

  const raw    = await callProvider({ provider: job.provider, apiKey: job.apiKey, model: job.model, prompt });
  const topics = parseTopics(raw);

  const { tome, file } = await findOrCreateSessionMemoriesTome();

  let created = 0;
  let tomeId  = tome.id;
  await withTomeLock(file, async () => {
    // Re-read inside the lock so concurrent jobs see each other's writes.
    const raw   = await fsp.readFile(file, 'utf8');
    const fresh = JSON.parse(raw);
    const now   = new Date().toISOString();

    for (const t of topics) {
      const title   = (t.title   ?? '').trim();
      const content = (t.content ?? '').trim();
      if (!title || !content) continue;
      const stickyN = parseInt(t.sticky, 10);
      const sticky  = Number.isFinite(stickyN) && stickyN > 0 ? stickyN : null;
      const uid = randomUUID();
      fresh.entries[uid] = {
        uid,
        comment:             title,
        keys:                Array.isArray(t.keywords) ? t.keywords.map(k => String(k).trim()).filter(Boolean) : [],
        keysecondary:        [],
        content,
        constant:            false,
        selective:           false,
        selectiveLogic:      0,
        enabled:             true,
        // At-depth (4), not a system-message position: these are
        // non-constant (keyword-triggered) entries, so injecting them
        // into the cacheable prompt prefix would invalidate it every
        // time they activate. At-depth keeps the prefix stable.
        position:            4,
        depth:               4,
        role:                0,
        scanDepth:           null,
        caseSensitive:       null,
        matchWholeWords:     null,
        probability:         100,
        sticky,
        cooldown:            null,
        preventRecursion:    false,
        delayUntilRecursion: false,
        excludeRecursion:    false,
        group:               '',
        groupWeight:         null,
        insertion_order:     100,
        created_at:          now,
        learnedAt:           now,
        session_id:          job.sessionId,
        scope:               job.scope,
        topic_id:            job.topicId ?? null,
        message_range:       job.messageRange ?? null,
      };
      created++;
    }
    tomeId = fresh.id;
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(fresh, null, 2), 'utf8');
    await fsp.rename(tmp, file);
  });

  if (!created) throw new Error('No valid topics produced.');
  return { entriesCreated: created, tomeId };
}

function pickNextJob(now) {
  return _queue.find(j => j.status === 'pending' && (!j.nextAttemptAt || j.nextAttemptAt <= now));
}

let _ticking = false;
async function tick() {
  if (_ticking) return;
  _ticking = true;
  try {
    await loadQueue();
    const now = Date.now();
    const job = pickNextJob(now);
    if (!job) return;

    job.status      = 'processing';
    job.startedAt   = new Date().toISOString();
    job.attempts    = (job.attempts ?? 0) + 1;
    await persistQueue();

    try {
      const result = await processJob(job);
      job.status     = 'done';
      job.result     = result;
      job.finishedAt = new Date().toISOString();
      job.lastError  = null;
    } catch (err) {
      job.lastError = err?.message ?? String(err);
      if (job.attempts >= MAX_ATTEMPTS) {
        job.status     = 'failed';
        job.finishedAt = new Date().toISOString();
      } else {
        job.status         = 'pending';
        job.nextAttemptAt  = Date.now() + BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)];
      }
    }
    await persistQueue();
  } finally {
    _ticking = false;
  }
}

function pruneAcknowledged() {
  const now    = Date.now();
  const before = _queue.length;
  _queue = _queue.filter(j => {
    if (!j.acknowledged) return true;
    if (j.status !== 'done' && j.status !== 'failed') return true;
    const finishedMs = j.finishedAt ? Date.parse(j.finishedAt) : now;
    return (now - finishedMs) < ACK_TTL_MS;
  });
  return _queue.length !== before;
}

let _started = false;
let _tickInterval = null;
let _pruneInterval = null;
export function startMemorizationWorker() {
  if (_started) return;
  _started = true;
  loadQueue().then(() => {
    _tickInterval  = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
    _pruneInterval = setInterval(() => { if (pruneAcknowledged()) persistQueue().catch(() => {}); }, 60 * 60 * 1000);
    tick().catch(() => {});
  });
}

// Stop the worker cleanly so process exit can complete. Called by
// server.js's SIGTERM/SIGINT handler. Without this, the setIntervals
// here keep the event loop alive past server.close().
export function stopMemorizationWorker() {
  if (_tickInterval)  { clearInterval(_tickInterval);  _tickInterval  = null; }
  if (_pruneInterval) { clearInterval(_pruneInterval); _pruneInterval = null; }
  _started = false;
}

// ── Public API used by server endpoints ─────────────────────────

export async function enqueueMemorization({ sessionId, scope, topicId, topicLabel, messageRange, messages, provider, apiKey, model }) {
  await loadQueue();
  if (!sessionId || typeof sessionId !== 'string') throw new Error('sessionId is required.');
  if (!Array.isArray(messages) || messages.length < 2) throw new Error('At least 2 messages are required.');
  if (!provider || !apiKey || !model) throw new Error('provider, apiKey, and model are required.');
  const normScope = scope === 'topic' ? 'topic' : 'session';
  const normLabel = typeof topicLabel === 'string' && topicLabel.trim() ? topicLabel.trim() : null;

  // Idempotency: same session+scope+topicId+rangeKey collapses to the existing job
  // unless that job is already in a terminal state.
  const rangeKey = messageRange ? `${messageRange.start}-${messageRange.end}` : '';
  const dupKey   = `${sessionId}|${normScope}|${topicId ?? ''}|${rangeKey}`;
  const existing = _queue.find(j => j.dupKey === dupKey && (j.status === 'pending' || j.status === 'processing'));
  if (existing) return { jobId: existing.id, deduped: true };

  const job = {
    id:            randomUUID(),
    dupKey,
    sessionId,
    scope:         normScope,
    topicId:       topicId ?? null,
    topicLabel:    normLabel,
    messageRange:  messageRange ?? null,
    messages,
    provider,
    apiKey,
    model,
    status:        'pending',
    attempts:      0,
    createdAt:     new Date().toISOString(),
    lastError:     null,
    acknowledged:  false,
  };
  _queue.push(job);
  await persistQueue();
  // Kick the worker immediately rather than waiting for the next tick.
  tick().catch(() => {});
  return { jobId: job.id, deduped: false };
}

export async function listJobs() {
  await loadQueue();
  // Strip apiKey and message bodies from listings to avoid leaking secrets/bloat.
  return _queue.map(j => ({
    id:            j.id,
    sessionId:     j.sessionId,
    scope:         j.scope,
    topicId:       j.topicId,
    status:        j.status,
    attempts:      j.attempts,
    createdAt:     j.createdAt,
    startedAt:     j.startedAt ?? null,
    finishedAt:    j.finishedAt ?? null,
    nextAttemptAt: j.nextAttemptAt ?? null,
    lastError:     j.lastError ?? null,
    result:        j.result ?? null,
    acknowledged:  !!j.acknowledged,
  }));
}

export async function acknowledgeJob(id) {
  await loadQueue();
  const job = _queue.find(j => j.id === id);
  if (!job) return false;
  if (job.status !== 'done' && job.status !== 'failed') return false;
  job.acknowledged = true;
  await persistQueue();
  return true;
}

export async function cancelJob(id) {
  await loadQueue();
  const idx = _queue.findIndex(j => j.id === id);
  if (idx < 0) return false;
  if (_queue[idx].status === 'processing') return false;
  _queue.splice(idx, 1);
  await persistQueue();
  return true;
}
