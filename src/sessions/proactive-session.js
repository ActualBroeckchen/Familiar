/**
 * proactive-session.js — record what I say to my human UNPROMPTED in our shared
 * conversation, so it lands in context on every surface.
 *
 * The gap this closes: a reminder, an event alert, or "a thought from me" was
 * pushed to my human (a web banner, a Discord DM) but written to NO session log.
 * So two things broke — I had no record I'd already said it (and re-said it), and
 * when my human replied in a Discord DM my next turn saw their reply with no
 * antecedent, context-less. The unified-session groundwork (session-bindings +
 * the merge-by-id writer) is exactly what makes the fix a small one: append the
 * message as an assistant turn to the ward-private session both surfaces share.
 *
 * Discord reads history straight from this log each turn, so a DM reply now
 * continues a real thread. (The web browser drives its own live message state, so
 * the immediate next web turn won't see a server-side append — but the banner
 * already shows it there, and web memorization reads the log.)
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import {
  getSessionBinding, setSessionBinding, WARD_PRIVATE_KEY, SESSION_IDLE_ROTATE_MS,
} from './session-bindings.js';
import { writeSessionLog, stampMessages } from './session-log.js';
import { sessionSlugId } from '../../slug-ids.js';
import { stripLlmTimestamps } from '../../message-sanitize.mjs';

// Which proactive outbox kinds are the Familiar's OWN voice to my human — the
// ones that belong in our conversation record. Relays (a villager's words passed
// through me), page-watch notices, and crisis-resource lists are deliberately
// excluded: they're notifications, not me speaking as myself.
export const WARD_CONVERSATIONAL_KINDS = new Set([
  'reminder', 'event_alert', 'weather_alert', 'reachout', 'triage',
]);

export function isWardConversationalKind(kind) {
  return WARD_CONVERSATIONAL_KINDS.has(String(kind ?? ''));
}

// The stable message id for a proactive turn, derived from its outbox item id.
// The server append and the browser's outbox-injection BOTH use this, so the two
// never show the same message twice (the log merges by id; pollSessionDelta skips
// the `outbox:` prefix). Mirrored verbatim in public/app.js — keep them in sync.
export function proactiveMessageId(outboxId) {
  return `outbox:${outboxId}`;
}

/**
 * Append a proactive message I sent my human as an assistant turn in our UNIFIED
 * ward session (the pointer the web chat and the Discord DM share). Lands in the
 * currently-bound session when it's still live; if there's none or it has idled
 * past the rollover, mints and binds a fresh one so my human's reply continues
 * THIS message rather than a stale thread. Merge-writes by id, so it reconciles
 * with whatever a live surface appended meanwhile. Never throws — a failure here
 * must never sink the actual delivery.
 *
 * @returns {{ok:boolean, sessionId?:string, reason?:string}}
 */
export function proactiveSessionDisabled() {
  return process.env.PROTO_FAMILIAR_PROACTIVE_SESSION_DISABLED === '1';
}

export async function appendWardProactiveTurn({ text, kind = null, messageId = null, logsDir, bindingsFile, now = Date.now } = {}) {
  try {
    if (proactiveSessionDisabled()) return { ok: false, reason: 'disabled' };
    const content = stripLlmTimestamps(String(text ?? '').trim());
    if (!content || !logsDir) return { ok: false, reason: 'empty' };
    const nowMs = now();
    const iso = new Date(nowMs).toISOString();
    const bindOpts = bindingsFile ? { bindingsFile } : {};

    const b = await getSessionBinding(WARD_PRIVATE_KEY, bindOpts).catch(() => null);
    let sessionId = b?.sessionId || null;
    let existing = null;
    if (sessionId) {
      try { existing = JSON.parse(await fsp.readFile(path.join(logsDir, `${sessionId}.json`), 'utf8')); }
      catch { existing = null; }
      const lastAt = new Date(b?.lastTurnAt ?? existing?.updatedAt ?? 0).getTime();
      if (!Number.isFinite(lastAt) || (nowMs - lastAt) >= SESSION_IDLE_ROTATE_MS) {
        sessionId = null; existing = null;   // idled → fresh session, so the reply threads to THIS message
      }
    }
    if (!sessionId) sessionId = sessionSlugId();

    // A caller-supplied id (derived from the outbox item) is what lets the web's
    // own outbox-injection recognise this as the SAME message rather than a
    // second copy — the log merges by id, and the browser's pollSessionDelta
    // skips it, so the proactive turn lands exactly once across both surfaces.
    const [msg] = stampMessages([{
      ...(messageId ? { id: messageId } : {}),
      role: 'assistant', content, meta: { proactive: true, ...(kind ? { kind } : {}) },
    }], iso);

    const data = existing ?? {
      sessionId, startedAt: iso, endedAt: null, provider: null, model: null,
      audienceTag: 'ward-private',
      location: { platform: 'proactive', kind: 'reachout', label: 'From my Familiar' },
      participants: [], messages: [],
    };
    data.sessionId = sessionId;
    data.messages = [...(Array.isArray(data.messages) ? data.messages : []), msg];
    data.updatedAt = iso;

    const r = await writeSessionLog(data, { logsDir, merge: true });
    if (!r.ok) return { ok: false, reason: r.reason };
    // Make this the live ward session so the reply (web or DM) continues it.
    await setSessionBinding(WARD_PRIVATE_KEY, sessionId, { at: iso, ...bindOpts });
    return { ok: true, sessionId };
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) };
  }
}
