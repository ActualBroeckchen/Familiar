---
title: Unified Ward Sessions
topics: [architecture, sessions, multi-embodiment]
sources:
  - id: session-bindings-js
    type: file
    path: src/sessions/session-bindings.js
  - id: discord-gateway-js
    type: file
    path: src/discord/discord-gateway.js
  - id: app-js
    type: file
    path: public/app.js
  - id: server-js
    type: file
    path: server.js
  - id: session-log-js
    type: file
    path: src/sessions/session-log.js
  - id: proactive-session-js
    type: file
    path: src/sessions/proactive-session.js
  - id: proactive-session-test
    type: file
    path: tests/proactive-session.test.mjs
---

# Unified Ward Sessions

As of 0.11.47, the ward's web private chat and their Discord DM are one continuous
conversation instead of two independently-logged sessions: a message sent on Discord shows
up in the web app's open chat, and vice versa, because both surfaces resolve the same
session id rather than each minting its own [@session-bindings-js]. This auto-unify behavior
is on by default and can be turned off with `PROTO_FAMILIAR_SESSION_UNIFY_DISABLED=1` or the
ward's `sessionUnifyEnabled` setting ("One conversation across web & Discord")
[@discord-gateway-js]. Unification is scoped narrowly: only the ward's own DM and the
ward's own web chat ever share a session. A registered villager's DM and any guild room keep
their own per-location session regardless of the toggle, because merging a villager's
conversation into the ward's would leak it across a privacy boundary
[@discord-gateway-js]. This is a session-identity analog of the
[multi-embodiment](../concepts/multi-embodiment) stance — one continuous thing accessed
through several interfaces — applied to a chat session's turn history rather than to
Phylactery's identity and memory graph; the two mechanisms are unrelated at the code level
(no MCP call is involved here), but solve the same shape of problem for a different kind of
state.

## The shared pointer: `session-bindings.js`

`session-bindings.js` is a small, file-backed pointer: a canonical key, `ward-private`, maps
to `{ sessionId, lastTurnAt }` in `tomes/.session-bindings.json`, an in-process-locked JSON
store with the same never-throw, degrade-to-null discipline as the rest of the Tomes file
storage [@session-bindings-js]. `getSessionBinding(key)` reads it; `setSessionBinding(key,
sessionId)` claims or touches it, stamping `lastTurnAt`. Both the web server and the Discord
gateway run in the same Node process, so the module's lock is a simple in-process promise
chain rather than a cross-process file lock [@session-bindings-js]. This one pointer is the
entire mechanism: there is no separate "unify" service, just an agreement that both surfaces
read and write the same key instead of each keeping a private map.

## Discord side: binding resolution and privacy scope

`discord-gateway.js`'s `sessionForLocation(locationKey, locationLabel, kind, { bindKey })`
decides whether to resolve the shared binding or the ordinary per-location session map: it
reads the binding when a `bindKey` is passed, and reads `map[locationKey]` (the pre-existing
per-DM/per-channel store) otherwise [@discord-gateway-js]. The caller only ever passes a
`bindKey` when `decision.kind === 'ward-dm'` (the message is a DM from the ward) and
`sessionUnifyEnabled()` is true; a villager DM or a guild room's `decision.kind` is never
`'ward-dm'`, so those paths can never accidentally resolve the shared pointer
[@discord-gateway-js]. `touchLocation(locationKey, sessionId, { bindKey })` updates whichever
store `sessionForLocation` used, on every turn, so `lastTurnAt` keeps advancing for idle-gap
detection. A session's `location` field for a unified conversation still records `platform:
'discord'` if the session was born from a Discord message — see
[Session location labels](#session-location-labels) below for how the "set-once" write rule
that follows from this interacts with the web's own writes.

## Web side: claiming and adopting the pointer

`public/app.js` claims the binding whenever the ward sends a message or starts a new chat:
`claimActiveSession(sessionId)` posts to `POST /api/session/active`, a thin wrapper around
`setSessionBinding(WARD_PRIVATE_KEY, sessionId)`, gated on the unify toggle so it is a no-op
when unification is off [@app-js] [@server-js]. On load, `autoResumeMostRecentSession()`
prefers `GET /api/session/active` — the scoped pointer, which can only ever resolve to the
ward's own private conversation, never a villager DM or guild room — and falls back to the
older unscoped `GET /api/active-session` only when unification is off or no pointer has been
set yet [@app-js] [@server-js]. This is what makes opening the web app after a Discord
exchange show that exchange already in place, instead of an empty new session.

## Multi-writer safety: merging one log from two writers

Because the web server and the Discord gateway can now append to the *same* session log file
from the same process, a naive full-array `POST /api/log` write from the web could race a
Discord append and silently drop a turn. `session-log.js`'s `writeSessionLog(data, {
merge: true })` closes that gap: writes are serialized per-session by an in-process
promise-chain lock (`withSessionLock`), and with `merge: true` the on-disk log is read first
and unioned with the incoming write via `mergeMessages`, which keeps every id-carrying
message from both sides in timestamp order and treats id-less legacy messages as a stable,
earliest shared prefix [@session-log-js]. The merge also enforces set-once ownership of two
fields: `location` and `startedAt` come from whichever write created the file, so a later
writer from the other surface cannot relabel a Discord-born unified session as `Web chat`, or
vice versa; `endedAt` still flows through from whichever call passes it [@session-log-js].
Both `POST /api/log` (web) and the Discord gateway's own session-log write go through this
same function with `merge: true`, so the reconciliation logic lives in exactly one place
[@server-js] [@session-log-js]. This is a narrower, already-shipped counterpart to
[Tome multi-writer merge policy](../decisions/tome-multi-writer-merge-policy) — that page
designs reconciliation for competing Tome-entry writers (user, sifter, agent) and remains
unimplemented; this session-log merge solves the same *shape* of problem (two writers, one
record) for chat session logs specifically, with a much simpler union-by-id policy rather
than the tiered field-ownership scheme proposed there.

## Proactive messages land in the unified session (0.11.87-alpha)

Autonomous proactive messages — reminders, event and weather alerts, reachouts, and triage
check-ins — are now recorded as ASSISTANT turns in the unified ward-private session, not just
pushed to the ward as banners or Discord DMs [@proactive-session-js]. Before this fix, proactive
messages were delivered but never logged, causing two problems: the Familiar had no record it
had already sent a reminder (so the same one re-sent), and a Discord DM reply arrived
context-less — the next turn saw the ward's reply but not the Familiar's own preceding message
that prompted it.

`appendWardProactiveTurn` (in `src/sessions/proactive-session.js`) records the outgoing message
by writing it to whichever session is currently bound to `WARD_PRIVATE_KEY`, the same pointer
both the web and Discord use for unified conversation [@proactive-session-js]. It is wired
at the single seam every proactive item passes through: `cerebellum.enqueueAndDispatch`, after
a successful non-deduped enqueue+dispatch, and gated by message kind via `isWardConversationalKind`
— only `WARD_CONVERSATIONAL_KINDS = {reminder, event_alert, weather_alert, reachout, triage}`
qualify [@proactive-session-js]. Relays (a villager's words passed through the Familiar),
page-watch notices, crisis-resource links, and outbound alerts are deliberately excluded —
they are notifications, not the Familiar speaking as itself, so the Familiar must not read them
back as its own turns [@proactive-session-js].

When a proactive turn lands, if no session is currently bound or the bound session has idled
past `SESSION_IDLE_ROTATE_MS`, the function mints and binds a fresh session so the ward's
reply threads to the proactive message rather than a stale session [@proactive-session-js].
The append itself uses merge-write semantics (the same `withSessionLock` and `mergeMessages`
as the web/Discord multi-writer path) to reconcile safely with any concurrent appends from a
live surface; the write never throws, because a failure in session logging cannot be allowed
to sink the actual delivery [@proactive-session-js] [@session-log-js]. An off-switch
`PROTO_FAMILIAR_PROACTIVE_SESSION_DISABLED=1` disables logging without affecting delivery
[@proactive-session-js].

`SESSION_IDLE_ROTATE_MS` was moved from a private constant in `discord-gateway.js` to an
export of `session-bindings.js` so both the Discord gateway's ward-DM session rollover and
this proactive-append path use the same idle threshold and cannot drift apart
[@proactive-session-js] [@session-bindings-js].

### Exactly-once reconciliation with the web renderer (0.11.90-alpha)

The web display has two surfaces for proactive items: `injectOutboxAsChatMessage` (the
outbox-banner path, which renders a rich bubble and ping) and `pollSessionDelta` (which polls
the session log every few seconds and appends new turns) [@app-js]. Both paths run concurrently
when the ward has a web tab open while a proactive item fires. Before 0.11.90, the server and
browser used different ID schemes for the same reminder — `appendWardProactiveTurn` used one
id on the server, while `injectOutboxAsChatMessage` generated another via `generateId()` — so
`POST /api/log` kept two copies (merging by id, but with different ids), and the reminder
rendered twice on web (once from each path) and landed twice in Discord context (both copies
in the session log).

The fix is a **shared stable id** format `outbox:<id>` [@proactive-session-js] [@app-js]:

- **Server side:** `appendWardProactiveTurn` now accepts a `messageId` parameter (passed from
  `enqueueAndDispatch` as `proactiveMessageId(enq.id)`) and stamps it onto the message
  [@proactive-session-js]. `proactiveMessageId(outboxId)` returns the stable `outbox:<id>` format
  [@proactive-session-js].
- **Browser side:** `injectOutboxAsChatMessage` mints ids the same way, prefixing each
  `item.id` with `outbox:` [@app-js]. It checks if the id is already in `state.messages`
  (loaded from the log on open, or a prior inject); if present, it NO-OPs on rendering but
  still settles bookkeeping — acknowledging non-triage items — so reloading a still-pending
  item doesn't double either [@app-js].
- **Deduplication in the poller:** `pollSessionDelta` explicitly skips `outbox:`-prefixed
  turns when filtering incoming messages [@app-js]. Because the outbox-injection path owns
  their web display (it already does the ping and ack), the poller does not re-render them
  even when they arrive from the server [@app-js].

The net result: a proactive turn shows **once** on web and is in context **once** on both
surfaces (matching the correct pre-0.11.87 behavior). The `outbox:<id>` format is hand-mirrored
in `proactive-session.js` and `public/app.js` with sync comments on both sides — the same
discipline the macro-name parity applies elsewhere [@proactive-session-js] [@app-js]. The
server<->browser id contract is pinned by the `proactiveMessageId` test and the
`messageId`-stamping test in `tests/proactive-session.test.mjs`, not by an end-to-end browser
test (public/app.js is a classic script with no unit harness) [@proactive-session-js] [@proactive-session-test]. Live
verification: fire a reminder with a web tab open and confirm it appears exactly once
[@proactive-session-js].

## Live sync without disturbing the composer

A unified session needs the open web tab to pick up turns that arrive over Discord without
the ward doing anything. `pollSessionDelta()` in `public/app.js` polls
`GET /api/logs/:id?afterCount=N` roughly every few seconds — only while the tab is visible
and only when not mid-send (the typing indicator is the in-flight signal) — and appends any
messages past `N` [@app-js] [@server-js]. The delta endpoint itself is cheap: given
`?afterCount`, `GET /api/logs/:id` returns just `{ total, newMessages }` sliced from the
stored array instead of the whole log [@server-js].

The invariant this poller must never violate, stated directly from the feature's design
concern, is that it must never re-render or touch `#user-input`, focus, caret position, or
text selection — it may only append new bubbles to `#messages`, and only re-render the full
message list for the rare tool-carrying turn that needs the tool-block layout (still never
the composer) [@app-js]. `appendMessageEl` was extracted out of `renderAllMessages` so an
appended turn renders pixel-identical to one that was present on load, rather than the
poller needing its own separate rendering path [@app-js]. The invariant exists because the
whole point of the poller is to surface the other surface's turns while the ward may be
mid-thought typing a reply on web; a poller that stole focus or reset the caret would make
unification actively worse than two separate sessions.

## Continue on Discord: explicit handoff

Aside from the automatic unify-by-default behavior, the ward can explicitly bind any one of
their own past sessions (Knowledge → Sessions) as the ward-private pointer via a "Continue on
Discord" button, so their next DM picks it up [@app-js]. The button is gated on two
conditions from `GET /api/logs`: `wardPrivate` (derived server-side as `!audienceTag ||
audienceTag === 'ward-private'`, so a session is considered the ward's own only when it
carries no audience tag or an explicit ward-private one) and the unify toggle being on
[@server-js] [@app-js]. This closes off the one gap automatic unification alone would leave:
without it, a villager's logged conversation could never be bound as the ward-private
pointer even by mistake, but there would be no way for the ward to deliberately resume an
*older* one of their own sessions from Discord — the automatic path only ever tracks the most
recently active one.

## Session location labels

Every session log carries a `location` object (`{ platform, label, kind }`, set once per the
merge rule above), and `GET /api/logs` derives a human `locationLabel` from it via
`sessionLocationLabel()`: `Web chat` for a web-born session, `Discord DM` / a channel label
for Discord, `Voice call` for a voice session, falling back to inferring from a legacy `origin:
'voice-call'` field for logs that predate the `location` field [@server-js]. The sessions list
renders this as a chip per session plus a "Sort: recent / location" control, and (per the merge
rule above) `POST /api/log` now preserves whatever `location` and other fields a different
writer already set instead of blanking them on every web write [@server-js] [@app-js]. This
labeling is what lets a ward reviewing Knowledge → Sessions tell which of their unified
sessions started on which surface, and is a prerequisite for "Continue on Discord" showing a
sensible session picker.

## Related

- [Multi-embodiment](../concepts/multi-embodiment) — the broader canonical-store model this
  page's session-identity unification echoes for a different kind of state.
- [Session lifecycle](session-lifecycle) — session creation, normal endings, and the manual
  close-out feature for sessions that never received an `endedAt`.
- [Session memorization](session-memorization) — the pipeline that eventually turns a unified
  (or any other) session into durable Tome entries; unrelated to how the session's live turns
  are unified, but shares `memory-coverage.js` machinery with a companion fix recorded there.
- [Tome multi-writer merge policy](../decisions/tome-multi-writer-merge-policy) — a broader,
  unimplemented multi-writer design for Tome entries; this page's `mergeMessages` union is the
  much simpler, already-shipped answer to the same class of problem for session logs.
- [Ward Discord console](ward-console) — the other ward-only Discord-side machinery
  (`!queue`, `!connection`) that, like this feature, is intercepted only in the ward's own DM.
