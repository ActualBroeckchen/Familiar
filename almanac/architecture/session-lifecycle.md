---
title: Session Lifecycle
topics: [architecture, sessions]
sources:
  - id: server-js
    type: file
    path: server.js
  - id: app-js
    type: file
    path: public/app.js
  - id: session-log-js
    type: file
    path: src/sessions/session-log.js
---

# Session Lifecycle

A session is the ward's continuous chat thread on one surface. The ward has one active session at a time per surface (web chat, Discord DM, voice call), and that session remains active until explicitly ended. Sessions are logged to disk, can be resumed, and are the unit of memory extraction. This page explains when sessions begin, how they end, and the manual close-out mechanism for sessions that never received an `endedAt` timestamp.

## Session creation and active state

A session begins with the ward's first message on a surface. The session persists in memory while the ward is actively chatting — the active session is the one currently open on the web, the one the ward is DMing, or the one in progress during a voice call. On the web, `state.sessionId` tracks the current session; switching to a new chat creates a new `sessionId` and shifts the previous one to inactive status [@app-js].

Every session is logged to a JSON file on disk (`logs/{sessionId}.json`). The log carries metadata about the session: `startedAt` (ISO timestamp of the first message), `endedAt` (ISO timestamp when the session closed, or null if still open), `location` (which platform/channel the session belongs to), `provider` and `model` (LLM provider and model used), and `messages` (the full turn history) [@server-js] [@session-log-js].

## Normal session endings

Sessions end in three normal ways:

**New chat**: When the ward clicks "New chat" (the web UI) or explicitly starts a new conversation, `setCurrentSession()` stamps the previous session's `endedAt` with the current time and saves it [@app-js]. This is the most common explicit ending.

**Idle timeout**: When the ward goes inactive for 3 hours, `idleCheckTimer` fires and the session is ended automatically — a toast says "Session ended after 3 hours of inactivity. A new session has started." [@app-js].

**Tab close or process exit**: When the web tab closes, the browser fires `beforeunload` and `sendBeacon` enqueues a memorization job for the session, but historically did not reliably stamp `endedAt` on the session itself. Similarly, if a Discord conversation or voice call ends without explicit closure, the session persists with `endedAt: null` and reads as "open" in the sessions list forever.

## Sessions stuck without an endedAt

Sessions that never received an `endedAt` timestamp show up in the Knowledge → Sessions list as open indefinitely. This happens when:

- A tab closes before a `saveToServer()` call completes
- A session is never idle-rolled (the 3-hour timeout never fires)
- A Discord DM or voice call is not explicitly closed by server-side code

These sessions are not lost — the messages are safely saved — but they confuse the timeline. A session last active in April that is never closed will still appear "open" when the ward views their sessions in September.

## Manual close-out: POST /api/logs/:id/close

As of version 0.11.48, the ward can manually finalize these open sessions via a "Close out" button on each unfinished non-active session in the Knowledge → Sessions list [@app-js]. A toolbar action, "Close all open (N)", closes multiple open sessions at once when more than one is still open. The active session is never offered for close-out because it genuinely is ongoing; ending it is "new chat" [@app-js].

The server endpoint `POST /api/logs/:id/close` (in `server.js`) reads the session log and:

1. Returns immediately if `endedAt` is already set (a no-op for already-closed sessions) [@server-js].
2. Otherwise, stamps `endedAt` at the **LAST message's real timestamp** — when the conversation actually stopped — not the current time [@server-js]. This preserves the timeline: a session last active in April should read as ending in April, not today.
3. Falls back to `log.updatedAt` or current time if there are no messages [@server-js].
4. Writes the updated log through the shared merge writer (`persistSessionLog` with `merge: true`) so a concurrent turn from another surface cannot race and drop a message [@server-js] [@session-log-js].

The merge-writer safety is important because an open session on the web could theoretically receive a late Discord message at the same moment the ward is closing it via the UI. The merge ensures every message from both sides is preserved in timestamp order, `location` and `startedAt` remain set-once owned by whoever created the file, and only `endedAt` is overwritten [@session-log-js].

## Why endedAt timestamp matters

The `endedAt` field is more than just metadata. It drives:

- **Timeline honesty**: The sessions list sorts by time. An `endedAt` in April versus September changes what the ward sees and the narrative they build about their conversation history.
- **Memory extraction scope**: [Session memorization](session-memorization) uses `endedAt` to decide when a session ends and should be summarized.
- **Active session UI state**: The Knowledge → Sessions list only offers the "Close out" button on sessions where `!s.endedAt && s.sessionId !== state.sessionId` — sessions without a time they ended are the stale ones [@app-js].

## Related

- [Unified Ward Sessions](session-unification) — how the ward's web chat and Discord DM can be one continuous session when unification is enabled.
- [Session memorization](session-memorization) — the pipeline that turns a session into Tome entries once it ends.
- [Memory and Knowledge](memory-and-knowledge) — the broader memory architecture and how sessions feed into it.
