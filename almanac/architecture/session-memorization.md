---
title: Session Memorization
topics: [architecture, memorization]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: memorization-js
    type: file
    path: memorization.js
  - id: server-js
    type: file
    path: server.js
  - id: app-js
    type: file
    path: public/app.js
  - id: sessions-doc
    type: file
    path: docs/sessions.md
  - id: tomes-doc
    type: file
    path: docs/tomes.md
  - id: naming-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/6ad1c817-Naming_a_new_entitycore_module.txt
    note: "Founding conversation whose closing Copilot prompt (a 'Manage Tomes' button offering Auto-summarize vs. Manual-topics into an auto-created Session Memories tome) is the literal origin of the two logs-modal triggers below."
---

# Session Memorization

Session memorization is the pipeline that turns a chat session (or a piece of one) into
durable lorebook entries the Familiar can be reminded of later. It is a server-side job
queue owned by `memorization.js`, not a synchronous save: the browser enqueues a job, and a
single in-process worker calls the configured LLM, parses the response, and writes the
resulting entries into a dedicated Tome [@memorization-js] [@sessions-doc]. This subsystem is
one of the two places long-running memory lives in Familiar — the other is
[Phylactery](phylactery), which owns the Familiar's canonical, autonomously-retrieved memory.
Tomes are explicitly the other kind: human-editable, keyword-triggered lorebook entries, and
memorization is the automated writer that populates one particular Tome with that shape of
entry [@tomes-doc]. The queue design and its trigger set were a deliberate rewrite to close a
data-loss bug; see [Session memorization: durable queue](../decisions/session-memorization-queue)
for why the shape is what it is.

## The queue and its worker

Jobs persist to `tomes/.memorization-queue.json`, a git-ignored JSON file, so a job survives
tab close, the 3-hour idle rollover, and a server restart [@memorization-js] [@sessions-doc].
A single in-process worker ticks every 5 seconds, picks up jobs whose `nextAttemptAt` has
passed, and drains them one at a time [@memorization-js]. A job's lifecycle is
`pending -> processing -> done | failed`; a failed job with attempts remaining goes back to
`pending` with a new `nextAttemptAt` rather than terminating, following a fixed exponential
backoff of 5s, 30s, 2m, 10m, 30m across a maximum of 5 attempts [@memorization-js]. Any job
still marked `processing` when the server restarts — meaning the previous process died
mid-job — is automatically requeued rather than lost [@memorization-js] [@sessions-doc].
Terminal (`done`/`failed`) jobs stay in the queue until the client acknowledges them via
`POST /api/memorize/:id/ack`, so the UI can toast the outcome exactly once, and are pruned 24
hours after acknowledgment [@memorization-js].

Jobs are deduplicated by a key built from `sessionId + scope + topicId + messageRange` (plus,
for day-scoped jobs, the already-memorized offset) — a matching pending or processing job
short-circuits a re-enqueue instead of creating a duplicate [@memorization-js]. This is what
makes it safe for a terminal event to fire both a server-side enqueue and a client-side
`sendBeacon` enqueue for the same slice of conversation.

## The Session Memories tome

Every memorization job writes into one fixed target: a system Tome named `Session Memories`,
auto-created on first use [@memorization-js] [@tomes-doc]. The find-or-create routine is
shared, behind a process-wide mutex, between the worker and the `GET /api/tomes/session-memories`
endpoint, so a client asking "does this tome exist yet" and the worker's own write path can
never race each other into creating two tomes with the same name [@memorization-js]
[@sessions-doc]. Entries the worker writes are ordinary lorebook entries — editable, disable-able,
deletable through the same Tome UI as any hand-authored entry — carrying `scope`, `topic_id`,
`message_range`, and `session_id` provenance fields that are not part of normal World Info
entries [@sessions-doc]. A per-Tome mutex around the underlying read-modify-write also
serializes concurrent job writes so two jobs finishing close together cannot clobber each
other's entries [@memorization-js] [@sessions-doc].

## Triggers

`public/app.js` enqueues a job from several independent points in the session lifecycle, not
just at session end [@app-js] [@sessions-doc]:

| Trigger | Delivery | Scope |
|---|---|---|
| 3-hour idle timeout | `navigator.sendBeacon` | Whole session |
| Manual **Clear** | `navigator.sendBeacon` | Whole session |
| **Memorize now** button | `fetch` | Whole current session, on demand, without ending it |
| `beforeunload` (tab close) | `navigator.sendBeacon` | Current session, if unbeaconed and non-empty |
| **Topic end** | `fetch` | Just that topic's message range |
| Logs modal: Memorize -> Auto-summarize | `fetch` | Any historical session |
| Logs modal: Memorize -> Manual topics | `fetch`, per topic | Each topic range closed in the read-only viewer |

The Auto-summarize/Manual-topics split and the auto-created Session Memories tome both trace to
the exact wording of the Copilot prompt that first specified a "Manage Tomes" button offering
those two choices, from the same founding conversation that named
[Thalamus](../decisions/thalamus-naming) [@naming-conversation].

`sendBeacon` is used specifically for the terminal, page-may-be-gone events (idle timeout,
Clear, `beforeunload`) because the enqueue call itself has to survive the page unloading;
`fetch` is used everywhere the page is known to still be alive [@app-js] [@sessions-doc]. A
30-second poller (plus a poll on window focus) checks `GET /api/memorize`, toasts `done` or
`failed` jobs to the user, and ACKs them so they do not re-toast [@app-js] [@sessions-doc].

## Endpoints

`server.js` exposes the queue over five routes [@server-js]:

| Endpoint | Purpose |
|---|---|
| `POST /api/memorize` | Enqueue a job. Accepts `application/json` (fetch) or `text/plain` (sendBeacon's body type). |
| `GET /api/memorize` | List jobs, sanitized — no API keys or message bodies. |
| `POST /api/memorize-day` | Re-feed a calendar date's sessions (day-anchored path, below). |
| `POST /api/memorize/:id/ack` | Mark a terminal job as seen by the UI. |
| `DELETE /api/memorize/:id` | Cancel a pending job; 409 if it is already processing. |
| `GET /api/tomes/session-memories` | Find-or-create the Session Memories tome and return its metadata. |

## What was layered on afterward

`memorization.js` has grown two capabilities beyond the original session/topic queue: a
day-anchored path (`enqueueSessionByDay`, using `day-segments.js` to slice a session by local
calendar date and `memory-coverage.js` to ingest only the un-memorized tail of each day so
re-runs don't duplicate facts) and a source-aware consent gate (`resolveRememberGate`,
which resolves a per-category `true`/`false`/`ask` decision based on WHO a fact is about and
WHETHER the ward told the Familiar directly) [@memorization-js].

The consent gate (`resolveRememberGate`) is source-aware and takes `{direct, hasNamedSubjects}` as inputs [@memorization-js]:

- **Direct channel + fact about the ward** (ward DM or web chat with `audienceTag==='ward-private'`, and the memory is about the ward themselves) → **implied consent: kept without asking** [@claude-md]. The ward told the Familiar on purpose. This only fills the UNSET default; an explicit ward `ask`/`false` in the remember map still wins (explicit settings override implied consent).
- **Third-party subjects** (a registered villager subject, OR a named-but-unregistered person → `hasNamedSubjects`) → **asks for sensitive categories in any channel** [@claude-md]. A stranger's sensitive fact is never swept in without asking.
- **Indirect channels** (group room, shared surface) → **still asks** [@claude-md]. Even ward-private content surfaced indirectly needs explicit consent.

This design killed the confusing flood of date-less consent asks for things the ward said directly. Rationale: memories are what the Familiar *experienced*; being told something directly IS the consent. The `[PENDING MEMORY CONSENT]` block now carries each item's `date` + `reason` (`shared-room`/`third-party`) so asks are explained and time-anchored [@claude-md]. Outcomes are tracked in `.consent-pending.json` for `thalamus.js` to surface.

Both paths (day-anchored segmentation and consent gating) extend the same queue and retry mechanics described above rather than replacing them.

## Related

- [Session memorization: durable queue](../decisions/session-memorization-queue) — why the
  queue, the dedicated tome, and the trigger set are shaped the way they are.
- [Phylactery](phylactery) — the canonical, autonomously-retrieved memory store that Tomes are
  deliberately kept separate from.
- [Engineering conventions](../reference/engineering-conventions) — the repo-wide "robust over
  cheap" and graceful-degradation rules this subsystem's shape follows.
- [Per-feature model routing](../decisions/per-feature-model-routing) — how the memorization
  worker resolves which connection to call, independent of whichever connection the ward
  chats on.
- [Tome multi-writer merge policy](../decisions/tome-multi-writer-merge-policy) — a broader,
  not-yet-implemented design for reconciling writes when more than one process can write to the
  same Tome entry; this subsystem's single-writer, mutex-serialized model is the simpler thing
  that shipped instead.
