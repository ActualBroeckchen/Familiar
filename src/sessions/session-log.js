/**
 * session-log.js — write a conversation to logs/ so the ward can review it in
 * the Sessions tab, exactly like a web-chat log.
 *
 * Extracted when voice calls needed the same "land as a reviewable session"
 * behaviour the Discord gateway already had (the no-copy-paste rule: a second
 * consumer is the signal to share). Transport-neutral: the caller owns the log
 * SHAPE (sessionId, messages, audienceTag, provider, timestamps); this only
 * persists it, atomically (tmp + rename, so a crash mid-write never leaves a
 * half-file that would read as a corrupt session).
 *
 * The message shape a reviewable log wants: `{ id, role, content, timestamp }`
 * per message. `stampMessages` fills id/timestamp on plain `{role, content}`
 * turns (voice calls accumulate those) without disturbing ones that already
 * carry them (Discord turns do).
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// ── Per-session write serialization ──────────────────────────────
// Web (server.js) and Discord (discord-gateway.js) run in the SAME node process
// and can both write the ward's unified session. An in-process promise-chain
// lock per sessionId serializes those writes so a read-merge-write from one
// surface can't interleave with the other's and drop a turn.
const _locks = new Map();
async function withSessionLock(sessionId, fn) {
  const prev = _locks.get(sessionId) ?? Promise.resolve();
  let release;
  const next = prev.then(() => new Promise((r) => { release = r; }));
  _locks.set(sessionId, next);
  await prev.catch(() => {});
  try { return await fn(); }
  finally {
    release();
    if (_locks.get(sessionId) === next) _locks.delete(sessionId);
  }
}

/**
 * Union two message arrays by `id`, preserving timestamp order. `incoming` is
 * the writer's intended view; any id-carrying message that exists on disk but
 * not in `incoming` (a turn the OTHER surface appended since this writer last
 * read) is spliced back in at its timestamp position. Legacy id-less messages
 * form a stable shared prefix and are never diffed. Pure — unit-tested.
 */
export function mergeMessages(existing = [], incoming = []) {
  const inc = Array.isArray(incoming) ? incoming : [];
  const ex  = Array.isArray(existing) ? existing : [];
  const incomingIds = new Set(inc.filter((m) => m?.id).map((m) => m.id));
  const extras = ex.filter((m) => m?.id && !incomingIds.has(m.id));
  if (extras.length === 0) return inc;
  // A missing timestamp sorts EARLIEST: id-less legacy messages are the oldest
  // prefix of a session, so a timestamped extra must land after them, not before.
  const merged = [...inc];
  for (const m of extras) {
    const ts = m.timestamp ? new Date(m.timestamp).getTime() : -Infinity;
    let at = merged.length;
    for (let i = merged.length - 1; i >= 0; i--) {
      const mt = merged[i].timestamp ? new Date(merged[i].timestamp).getTime() : -Infinity;
      if (mt <= ts) break;
      at = i;
    }
    merged.splice(at, 0, m);
  }
  return merged;
}

/**
 * Persist a session log. `data.sessionId` names the file. Serialized per-session
 * and written atomically (tmp+rename). With `merge:true`, the on-disk log is
 * read first and its id-carrying messages are unioned into `data.messages`
 * (`mergeMessages`) and its other fields preserved under `data` — so a second
 * writer never clobbers the first's turns or metadata (the ward's unified web +
 * Discord session). Returns { ok } and never throws — a failed log write must
 * never sink a call teardown or a chat turn.
 */
export async function writeSessionLog(data, { logsDir, merge = false } = {}) {
  if (!data?.sessionId || !logsDir) return { ok: false, reason: 'missing sessionId or logsDir' };
  return withSessionLock(data.sessionId, async () => {
    try {
      await fsp.mkdir(logsDir, { recursive: true });
      const file = path.join(logsDir, `${data.sessionId}.json`);
      let final = data;
      if (merge) {
        try {
          const existing = JSON.parse(await fsp.readFile(file, 'utf8'));
          if (existing && typeof existing === 'object') {
            final = {
              ...existing,
              ...data,
              messages: mergeMessages(existing.messages, data.messages ?? []),
              // Set-once identity: whoever CREATED the session owns these, so a
              // later writer from another surface can't relabel it (a Discord-born
              // unified session stays Discord's location; startedAt stays the
              // earliest). `endedAt` still flows through from `data`.
              location:  existing.location  ?? data.location  ?? null,
              startedAt: existing.startedAt ?? data.startedAt ?? null,
            };
          }
        } catch { /* no existing / corrupt — write data as-is */ }
      }
      const tmp = `${file}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(final, null, 2), 'utf8');
      await fsp.rename(tmp, file);
      return { ok: true, file, merged: merge };
    } catch (err) {
      return { ok: false, reason: err?.message ?? String(err) };
    }
  });
}

/**
 * A human-readable label for where a session happened (web chat, a Discord DM /
 * channel, a voice call), from a log's `location` (and legacy `origin`). One
 * place so the Sessions listing, session search, and any future consumer read it
 * the same way. Never throws.
 */
export function sessionLocationLabel(location, origin) {
  if (!location || typeof location !== 'object') {
    // Older logs predate the `location` field — infer from `origin` when we can.
    if (origin === 'voice-call-discord') return 'Discord voice call';
    if (origin === 'voice-call') return 'Voice call';
    return 'Web chat';
  }
  const { platform, label, kind } = location;
  if (platform === 'web')   return label || 'Web chat';
  if (platform === 'voice') return label || 'Voice call';
  if (platform === 'discord') {
    if (label) return label;
    return kind === 'dm' ? 'Discord DM' : 'Discord';
  }
  return label || 'Web chat';
}

/**
 * Ensure every turn has the `id` + `timestamp` a reviewable log renders from,
 * leaving all other fields (speaker, targets, attachments, …) intact. A safety
 * net: turns are now stamped at accumulation time (`turnMessages`), so this is
 * usually a no-op — but a turn that reached a log without them still renders.
 */
export function stampMessages(messages, stampIso = new Date().toISOString()) {
  return (Array.isArray(messages) ? messages : []).map((m) => ({
    ...m,
    id:        m?.id || randomUUID(),
    timestamp: m?.timestamp || stampIso,
  }));
}

/**
 * Build a stamped user+assistant turn pair for a call's session transcript. One
 * place so every transport records the same shape — `id` + real accumulation
 * `timestamp`, and a `speaker` on the user turn when known (the group-call case:
 * a room session mixes several villagers, so a bare "user" would lose who said
 * what — matching how Discord text attributes each turn). The ward speaks
 * unattributed (`speaker` omitted), exactly like Discord text's ward turns.
 */
export function turnMessages(userMsg, assistantMsg, { speaker = null, at = new Date().toISOString() } = {}) {
  return [
    { id: randomUUID(), role: 'user', content: userMsg, timestamp: at, ...(speaker ? { speaker } : {}) },
    { id: randomUUID(), role: 'assistant', content: assistantMsg, timestamp: at },
  ];
}
