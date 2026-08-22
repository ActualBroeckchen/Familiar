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

/**
 * Persist a session log. `data.sessionId` names the file; the rest is written
 * as-is. Returns { ok } and never throws — a failed log write must never sink a
 * call teardown or a chat turn.
 */
export async function writeSessionLog(data, { logsDir } = {}) {
  if (!data?.sessionId || !logsDir) return { ok: false, reason: 'missing sessionId or logsDir' };
  try {
    await fsp.mkdir(logsDir, { recursive: true });
    const file = path.join(logsDir, `${data.sessionId}.json`);
    const tmp  = `${file}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fsp.rename(tmp, file);
    return { ok: true, file };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
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
