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

// ── Tome helpers (delegated to thalamus's coordination layer) ────
//
// Both findOrCreateSessionMemoriesTome and the per-tome lock used to
// live here as private helpers. They now route through thalamus —
// findOrCreateTomeByName for the dir-scope find-or-create, and
// modifyTomeFile (used in processJob below) for the per-file
// RMW. This means a concurrent HTTP /api/tomes/:id edit and a
// memorization tick serialise against each other through the same
// per-path key, which they couldn't before.

import { findOrCreateTomeByName, modifyTomeFile } from './thalamus.js';

export function findOrCreateSessionMemoriesTome() {
  return findOrCreateTomeByName(TOMES_DIR, TOME_NAME, {
    name:        TOME_NAME,
    description: TOME_DESCRIPTION,
    enabled:     true,
    entries:     {},
  });
}

// withTomeLock removed — callers below now use modifyTomeFile() from
// thalamus directly, which encapsulates lock + atomic write in one
// helper.

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
    ? `\n\n### Focus topic\nMy human named this segment "${topicLabel}". I center the entries on that topic; I collapse or skip tangential threads that don't bear on it. I prefer one focused entry over splitting unless genuinely distinct sub-topics exist within the named topic.`
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
  - First person, me speaking as myself ("I", "my", "me"). I use {{user}} wherever my human's name belongs.
  - Fitting my identity, personality, and feelings about the world. Notes, not a textbook.
  - Short declarative bullets. The whole entry should be readable in 5–10 seconds.
  - I do NOT include narrative summaries of "what they said" — I distil the situation and my response, not the transcript and only hold on to sentences if they are particularly important to me.

### Keyword rules
Keywords are TRIGGERS, not labels. They must be phrases I or my human would literally say when this situation recurs or we speak about the subject again — not the name of the topic.
  - WRONG: "executive dysfunction", "rejection sensitive dysphoria", "hyperfocus".
  - RIGHT: "don't know where to start", "did I say something wrong", "been at this for".
I derive them by imagining what my human would actually type when the situation is happening, then extracting distinctive phrases.
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
      // Long sessions produce several topics with substantial content;
      // 2000 used to truncate the JSON mid-object and every retry hit
      // the same deterministic wall. Truncation is now also DETECTED
      // (finish_reason) instead of surfacing as a confusing parse error.
      max_tokens:  8000,
    }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Provider ${provider} returned ${resp.status}: ${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Provider returned non-JSON response.'); }
  if (data.error) throw new Error(typeof data.error === 'string' ? data.error : (data.error.message ?? 'Provider error'));
  const choice  = data.choices?.[0];
  const content = choice?.message?.content ?? '';
  if (!content) throw new Error('Provider returned empty content.');
  return { content, finishReason: choice?.finish_reason ?? null };
}

/**
 * Salvage complete topic objects from a truncated/malformed response.
 * Walks the "topics" array with a string-aware brace counter and
 * individually parses each complete object — a session that produced
 * four whole entries and one cut-off one keeps the four.
 */
export function salvageTopics(raw) {
  const topicsKey = raw.indexOf('"topics"');
  if (topicsKey < 0) return [];
  const arrStart = raw.indexOf('[', topicsKey);
  if (arrStart < 0) return [];
  const topics = [];
  let i = arrStart + 1;
  while (i < raw.length) {
    while (i < raw.length && raw[i] !== '{' && raw[i] !== ']') i++;
    if (i >= raw.length || raw[i] === ']') break;
    const start = i;
    let depth = 0, inStr = false, esc = false, complete = false;
    for (; i < raw.length; i++) {
      const ch = raw[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { i++; complete = true; break; }
      }
    }
    if (!complete) break; // truncated mid-object — nothing further is whole
    try {
      const obj = JSON.parse(raw.slice(start, i));
      if (obj && typeof obj === 'object') topics.push(obj);
    } catch { /* malformed object — skip, keep scanning */ }
  }
  return topics;
}

export function parseTopics(raw, finishReason = null) {
  // Models sometimes wrap the JSON in markdown fences despite the prompt.
  const cleaned = String(raw).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const match = cleaned.match(/\{[\s\S]+\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      const topics = parsed.topics;
      if (Array.isArray(topics) && topics.length) return topics;
      throw new Error('LLM returned no topics.');
    } catch (err) {
      if (err.message === 'LLM returned no topics.') throw err;
      // SyntaxError — truncated or malformed. Fall through to salvage.
    }
  }
  const salvaged = salvageTopics(cleaned)
    .filter(t => (t?.title ?? '').toString().trim() && (t?.content ?? '').toString().trim());
  if (salvaged.length) {
    if (finishReason === 'length') {
      console.warn(`[memorization] LLM output truncated by token limit — salvaged ${salvaged.length} complete entr${salvaged.length === 1 ? 'y' : 'ies'} from partial JSON`);
    }
    return salvaged;
  }
  if (finishReason === 'length') {
    throw new Error('LLM output was cut off by the token limit before the JSON completed, and no complete entries could be salvaged.');
  }
  if (!match) throw new Error('No JSON object found in LLM response.');
  throw new Error('Could not parse JSON from LLM response.');
}

// ── Worker ───────────────────────────────────────────────────────

async function processJob(job) {
  const prompt = buildPrompt(job.messages, job.topicLabel ?? null);
  if (!prompt) throw new Error('Conversation too short to memorize.');

  const { content: raw, finishReason } = await callProvider({ provider: job.provider, apiKey: job.apiKey, model: job.model, prompt });
  const topics = parseTopics(raw, finishReason);

  const { tome, file } = await findOrCreateSessionMemoriesTome();

  let created = 0;
  let tomeId  = tome.id;
  // Thalamus's modifyTomeFile holds the per-file lock across read +
  // write so a concurrent HTTP /api/tomes/:id edit or any other
  // writer on the same file serialises against this — fixes the
  // cross-loop race where memorization's own withTomeLock and
  // server.js writeTome held different keys.
  await modifyTomeFile(file, (fresh) => {
    const now = new Date().toISOString();
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
  });

  if (!created) throw new Error('No valid topics produced.');
  return { entriesCreated: created, tomeId };
}

function pickNextJob(now) {
  return _queue.find(j => j.status === 'pending' && (!j.nextAttemptAt || j.nextAttemptAt <= now));
}

// Track the in-flight tick promise so stopMemorizationWorker can
// await it on shutdown. Mirrors the pattern in pondering-loop.js,
// reminders-loop.js, silence-triage-loop.js — without this, a
// SIGTERM during a processJob can leave the tome write half-done
// and the queue file out of sync with what actually persisted.
let _activeTick = null;
async function tick() {
  if (_activeTick) return _activeTick;
  _activeTick = (async () => {
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
  })();
  try {
    return await _activeTick;
  } finally {
    _activeTick = null;
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
//
// Awaits any in-flight tick so a processJob mid-tome-write isn't
// left torn between persistQueue calls — matches the pattern in
// pondering-loop / reminders-loop / silence-triage-loop.
export async function stopMemorizationWorker() {
  if (_tickInterval)  { clearInterval(_tickInterval);  _tickInterval  = null; }
  if (_pruneInterval) { clearInterval(_pruneInterval); _pruneInterval = null; }
  const pending = _activeTick;
  _started = false;
  if (pending) { try { await pending; } catch { /* surfaced via job.lastError already */ } }
}

// ── Public API used by server endpoints ─────────────────────────

// L4 (audit, deferred): the load → dedup-check → push → persist
// sequence below is not wrapped in a lock. If two POST /api/memorize
// arrive within the same microtask window — say both fire from a
// chat-turn-end (server-side) and a sendBeacon (browser-side) for
// the same session — they can both see "not present yet" before
// either persistQueue runs, and we end up with two near-duplicate
// jobs. The originId-style dedup that exists on outbox isn't here.
//
// Symptom to watch for: same session getting memorized twice with
// slightly different message ranges, or two parallel "processing"
// jobs of the same scope showing up in the queue.
//
// If this turns up in live testing, fix is: wrap the body in
// withLock(QUEUE_FILE, ...) from thalamus so the load + dedup +
// push + persist run as one atomic unit.

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
