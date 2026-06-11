# Architecture

> **Keep this current.** When component responsibilities, data flow,
> or the prompt-assembly order changes in code, update this doc in
> the same commit. CLAUDE.md mandates it because architecture
> drift is a top driver of "future-me has no idea why X" bugs.

## Overview

Proto-Familiar is a Node.js application — a thin Express server +
vanilla-JS single-page frontend — that surfaces a persistent AI
companion (the Familiar) bonded to one human. It is an **embodiment**
of the same entity Psycheros holds in `entity-core`; see
[CLAUDE.md](../CLAUDE.md#entity-as-subject--the-design-value-under-everything)
and the [Psycheros PHILOSOPHY.md](https://github.com/PsycherosAI/Psycheros/blob/main/PHILOSOPHY.md)
for the design value that everything below descends from.

The server's responsibilities:

1. **Proxy LLM requests** so the user's API key never leaves localhost.
2. **Enrich every request** with cognitive-module context: identity +
   memory + graph from entity-core, temporal context + ponderings +
   care-check framing from Unruh + the caring-spine modules.
3. **Run autonomous loops** for the proactive surfaces — pondering,
   reminders, silence-triage — that fire without a human request.
4. **Persist** session logs, Tomes, ponderings, outbox items,
   threat state, last-activity.

```
Browser (public/)
    │
    │  HTTP + SSE  + /api/outbox polling for proactive deliveries
    ▼
server.js  (Express, Node 18+, ESM)
    │
    │  ── cognitive bridge (per-request enrichment, INWARD) ──────
    ├── thalamus.js       ──►  entity-core  (Deno, stdio MCP)    — identity / memory / graph
    │                     ──►  Unruh        (Python via uv, MCP) — schedule / interests / handoff / routine
    │
    │  ── motor module (action + delivery, OUTWARD) ───────────────
    ├── cerebellum.js       ── tool registry + executors + tool-call loop,
    │                          triage deliberation, trusted-contact delivery,
    │                          escalation deadlines (uses thalamus's wrappers
    │                          for every MCP write — never its own connection)
    │
    │  ── caring spine (per-request + autonomous) ─────────────────
    ├── crisis-signals.js   ── pattern detector run on each user msg
    ├── threat-tracker.js   ── decaying scalar, persistent, audit history
    ├── recent-ponderings.js── read recent free-cycle thoughts into chat
    ├── pondering.js        ── one-shot ponder primitive (LLM call → tome entry)
    ├── pondering-loop.js   ── autonomous: wakes on cadence, ponders
    ├── reminders-loop.js   ── autonomous: fires due reminders into outbox
    ├── silence-triage-loop.js ── autonomous: LLM-deliberated check-ins
    ├── outbox.js           ── persistent delivery queue (reminders, triage, alerts)
    ├── last-activity.js    ── timestamps user activity for the silence loop
    │
    │  ── classical infrastructure ──────────────────────────────
    ├── memorization.js     ── per-session memorization queue + worker
    ├── temporal-format.js  ── pure renderer for Unruh's payload
    ├── providers.js        ── shared chat-completions URL map
    │
    ├── logs/               session JSON files (git-ignored)
    └── tomes/              per-Tome JSON files + state caches
        ├── .memorization-queue.json   (git-ignored)
        ├── .threat-state.json{,.tmp}  (git-ignored)
        ├── .outbox.json{,.tmp}        (git-ignored)
        └── .last-activity.json{,.tmp} (git-ignored)
```

Thalamus is a **plural-peer mediator**: each cognitive module is a
separate stdio MCP child spawned at boot. Failures degrade
independently — entity-core down doesn't take Unruh out, and vice
versa — and `enrich()` fans out across whichever peers are connected
via `Promise.allSettled`. Empty sub-blocks render as nothing in the
prompt; the LLM only sees scaffolding when there's content.

The **caring spine** modules are not MCP children — they are
Node-side modules that read from / write to Unruh and the local
state files. They run alongside the chat path (detection,
ponderings injection, care-check framing) and as background loops
(pondering, reminders, triage).

## File Structure

```
/
├── server.js                Express server — chat proxy, all HTTP endpoints, autonomous-loop boot
├── thalamus.js              MCP bridge — entity-core + Unruh, plus all the helper wrappers
├── cerebellum.js            Motor module — tool registry + executors + tool loop, triage deliberation, trusted-contact delivery, escalation deadlines
├── crisis-signals.js        Pattern-based detector — 5 tiers, ~13 signal categories, damping
├── threat-tracker.js        Decaying scalar with audit history, off-switches, file persistence
├── pondering.js             Pure `ponderOnce()` primitive — LLM call + tome write
├── pondering-cadence.js     Tiered interval formula + threat multiplier + user-stretch scale
├── pondering-loop.js        Autonomous singleton loop; integrates with cadence + isEnabled gate
├── reminders-loop.js        Autonomous singleton loop; polls Unruh for due reminders
├── silence-triage-loop.js   Autonomous singleton loop; LLM-deliberated proactive check-ins
├── outbox.js                Delivery queue (reminders / triage / outbound_alert), dedup on originId
├── last-activity.js         Tiny persistent "user last typed at" timestamp
├── recent-ponderings.js     Read recent pondering tome entries for in-chat reference
├── interest-picker.js       Weight-proportional sampler for the pondering loop
├── relative-time.js         Natural-English relative phrasing for every timestamped surface (memories, ponderings, schedule, handoff, "Now")
├── recurrence.js            Recurrence-rule expansion — turns one "weekly cleaning" anchor into occurrences within the temporal window
├── temporal-format.js       Pure renderer for the Unruh temporal_context payload
├── surface-context.js       Consumer pipeline — hard gates + candidate selection + block format
├── surface-events.js        Event store (offers + outcomes) + pure-code tagger + reflection inputs
├── village.js               Village registry (V1) — categories/grant sets, villagers/aliases, locations; local mirror + entity-core write-through sync (see docs/village-support-design.md)
├── injection-guard.js       Prompt injection immunization — pattern scanner + sanitizer applied at every external-data boundary
├── memorization.js          Persistent per-session memorization queue + worker
├── providers.js             Shared chat-completions URL map (used by server.js + thalamus.js)
├── entity-ref.js            Validate entity-core:self/file.md#section refs (M7 standing-value bridge)
├── package.json
├── .gitignore
│
├── logs/                    Session JSON files (auto-created, git-ignored)
├── tomes/                   Per-Tome JSON files (auto-created, git-ignored on UUID names)
│
├── unruh/                   In-tree Python module (Unruh — temporal context)
│   ├── pyproject.toml       uv-managed Python project, deps locked in uv.lock
│   ├── src/unruh/server.py  MCP server exposing every temporal tool
│   ├── src/unruh/schedule.py + interest.py + handoff.py
│   ├── data/                SQLite + state (auto-created, git-ignored)
│   └── tests/               pytest contract tests
│
├── scripts/
│   ├── import-entity.js     Import an entity-core data directory
│   ├── import-tome.js       Convert SillyTavern lorebook export → Proto-Familiar tome
│   ├── ensure-unruh-deps.mjs npm prestart hook: materialise unruh/.venv if missing
│   ├── ensure-port-free.mjs  npm prestart hook: auto-recycle stale Proto-Familiar
│   ├── ponder-once.mjs       CLI: one-shot ponder via TEMP_KEY
│   ├── ponder-from-interests.mjs CLI: live demo of the pondering loop
│   ├── pondering-loop-demo.mjs   CLI: autonomous loop demo (fast-forward cadence)
│   ├── chat-with-ponderings.mjs  CLI: demo of pondering reference in chat
│   ├── threat-demo.mjs            CLI: end-to-end detection + care-check rendering
│   ├── seed-test-interests.mjs    CLI: seed Unruh interests for the pondering demo
│   └── _unruh-mcp.mjs             Shared MCP-client helper for the CLI scripts
│
├── tests/                   Node test suite (`npm test`)
│
├── public/
│   ├── index.html           App shell — sidebar, chat pane, Temporal editor modal, all modals
│   ├── style.css            All styling — dark/light themes, modal/tab styles
│   └── app.js               All frontend logic — state, API calls, rendering, topics, Tomes,
│                            temporal editor, outbox delivery polling (tool registry + execution
│                            moved server-side to cerebellum.js in 0.4.0-alpha)
│
└── docs/                    This documentation (incl. research/ for design-input notes)
    ├── architecture.md      You are here
    ├── consequence-priors.md Generic curves for what lapsing costs (read by surface-context.js)
    └── research/            Design-input notes (task-handling, personalization-and-tracking)
```

## Component responsibilities

### `server.js` — the HTTP surface + autonomous-loop boot

The Express server handles every external request and manages the
lifecycle of the autonomous loops:

**Chat / enrichment:**
- `POST /api/chat` — validates request, fires `recordUserActivity()`
  (fire-and-forget timestamp) + `scoreMessage()` → `recordThreat()`
  on the user text, then `thalamus.enrich()` to assemble static +
  dynamic context. Returns the `_thalamus` envelope so the prompt
  inspector can show what was actually injected. With
  `runToolLoop: true` (sent by the app when tools are enabled) the
  server also runs the multi-round tool-call loop here, executing via
  cerebellum and emitting `_toolRound` SSE events / a `_toolRounds`
  response array — see "Data flow" below.
- `POST /api/debug-prompt` — offline preview (no upstream call).
- `POST /api/interest/engage` — fire-and-forget engagement bump.
- `POST /api/session/handoff` — store session-end intent for the
  next session.

**Logs / Tomes:** familiar endpoints for session JSON and Tome CRUD.

**Memorization:** `POST /api/memorize` + `GET /api/memorize` +
ack/cancel — see `memorization.js`.

**Temporal editor (M9):**
- `GET /api/temporal/interests` — live + standing with decay metadata
- `POST /api/temporal/interests/bump` — manual engagement bump
- `POST /api/temporal/interests/:id/demote` — demote standing value
- `POST /api/temporal/interests/set-standing` — promote topic to standing
- `GET /api/temporal/schedule[?from&to&limit]` — windowed events/tasks
- `POST /api/temporal/schedule` — add event/task/state/phase/reminder
- `PATCH /api/temporal/schedule/:id` — partial update
- `POST /api/temporal/schedule/:id/resolve` — mark done/cancelled/etc.
- `POST /api/temporal/schedule/:id/resolve_occurrence` — resolve ONE occurrence of a recurring node (leaves the series alive)
- `DELETE /api/temporal/schedule/:id` — hard delete (edges cascade)
- `GET /api/temporal/phases` — **date-independent** routine surface
- `GET /api/temporal/handoff` + `POST .../handoff/:id/consume`
- `GET /api/temporal/reminders/health` — observability on the loop
- `GET /api/temporal/ponderings[?limit&sinceDays]` + DELETE
- `POST /api/ponderings/intents/acted-on` — mark a deferred intent as filed (body: `{ uid, index }`); called by the `acknowledge_deferred_intent` LLM tool

**Village surface (V1 — registry only; gating lands in V3):**
- `GET /api/village` — full registry (categories + villagers + locations, normalized)
- `POST /api/village/categories` + `PATCH /api/village/categories/:id` + `DELETE /api/village/categories/:id?reassignTo=` — built-ins not deletable; Strangers locked
- `POST /api/village/villagers` + `PATCH /api/village/villagers/:id` + `DELETE /api/village/villagers/:id`
- `POST|PATCH|DELETE /api/village/locations` — keyed by body `key` (location keys contain `:`)

**Threat surface:**
- `GET /api/threat` — current tier + weight + last_touched + disabled
- `GET /api/threat/history?limit=N` — audit trail
- `POST /api/threat/reset` — manual reset to calm (always works)

**Outbox surface:**
- `GET /api/outbox[?pending=1&limit=N]` — UI polls this; pending items are injected as assistant chat messages in the active session (since 0.3.9-alpha; before, they rendered as banners)
- `POST /api/outbox/:id/acknowledge` — fired automatically by the client after each item is rendered into chat
- `POST /api/outbox/clear-acknowledged`
- Since 0.4.0-alpha every user-facing enqueue goes through
  `cerebellum.enqueueAndDispatch`, which ALSO pushes the item to each
  configured push channel (today: the human's own Discord webhook,
  Settings → Trusted contacts → "My Discord webhook") and records the
  per-channel outcome on the item as
  `delivery: { 'discord-dm': { status, at, error? } }`. The browser
  stays pull-based; its confirmation signal is the acknowledge.

**Settings + Tailscale gate:** as before.

**Autonomous-loop boot** (`app.listen()` callback):
- `startMemorizationWorker()`
- `startAutonomousPondering()` — Settings-toggleable + env-var off-switch
- `startRemindersScheduler()`
- `startSilenceTriage()`

Each loop has a `stop*()` function called from the SIGTERM /
SIGINT / SIGHUP handler so clean shutdown awaits any in-flight tick.

### `thalamus.js` — the cognitive-module mediator

Spawns and reconnects entity-core (Deno) + Unruh (Python via uv) as
stdio MCP children. Exposes:

- **`enrich(userMessage, { liveTurn, staticOnly })`** — the central
  per-request call. Fans out to identity + memory + graph (entity-core)
  + temporal_context (Unruh) + local-disk reads (recent ponderings,
  threat state). Returns `{ static, dynamic }`. See [Prompt
  assembly](#prompt-assembly) below for what goes where.
- **Interest helpers:** `recordInterest`, `bumpInterest`, `demoteStanding`,
  `setStandingInterest`, `listLiveInterests`, `listInterests`.
- **Schedule helpers:** `getScheduleWindow`, `addScheduleNode`,
  `updateScheduleNode`, `resolveScheduleNode`, `deleteScheduleNode`,
  `getDueReminders`, `getRemindersHealth`, `listPhases`.
- **Handoff helpers:** `recordHandoff`, `getHandoff`,
  `markHandoffConsumed`.
- **Entity-core spawn / reconnect:** auto re-spawns when settings
  change the entity-core connection.
- **Standing-value bridge (M7):** on every liveTurn, reconciles
  standing values whose `value_ref` points at a now-gone entity-core
  identity fact (demotes them to live interests).

### `cerebellum.js` — the motor module (outbound counterpart to Thalamus)

Thalamus owns everything flowing inward; cerebellum owns everything
flowing outward — the Familiar's actions and deliveries. The boundary
is strict: Thalamus assembles context and never executes actions;
cerebellum executes actions and never assembles prompt context.
Cerebellum never opens its own MCP connections — every write to
identity / memory / temporal state goes through thalamus.js's exported
wrappers (the single enforcement point for "writes go through
entity-core's MCP").

Currently owns:

- **Tool dispatch** — `BUILTIN_TOOLS` (the full registry of tool
  definitions, first-person descriptions, raw `{{user}}`/`{{char}}`
  macros) + `TOOL_EXECUTORS` (server-side implementations; writes ride
  thalamus's wrappers) + `executeToolCall()` (never throws — failures
  become structured strings into the loop) + `composeActiveTools()`
  (built-ins + the user's advertise-only custom tools) +
  `runToolCallLoop()` (the non-streaming multi-round loop; the
  streaming variant lives in /api/chat because it is SSE transport).
  `initCerebellumTools()` receives the tome-storage capability from
  server.js at boot so `save_to_tome` works without cerebellum ever
  importing server.js.
- **`decideTriageViaLLM({threat, silenceMs, signals})`** — the triage
  deliberation: assembles the [Now]-anchored prompt (identity context,
  recent conversation with relative times, threat signals, trusted
  contacts, candidate tasks), calls the primary connection, parses the
  `wait` / `reach_out` / `contactHuman` decision.
- **Channel adapters (push delivery)** — `activePushAdapters()` returns
  the configured push channels (today: `discord-dm` from the human's
  own webhook); `dispatchOutboxPush()` runs every adapter (a failing
  one never blocks the rest) and records per-channel
  `delivery: { status, at, error? }` on the item;
  `enqueueAndDispatch()` is the default enqueuer for everything
  user-facing. `formatDeliveryNote()` renders one line of delivery
  state into the prompts the Familiar reads — a failed push is visible
  to it, so "they never saw me" and "they're ignoring me" are
  distinguishable signals. `sendDiscordWebhook()` is the shared
  primitive under both the user push channel and trusted-contact
  delivery.
- **`deliverToTrustedContact({name, message, channel})`** — Discord
  webhook delivery with the "no covert contact" invariant enforced
  structurally: every outbound to a third party mirrors an
  `outbound_alert` into the user's outbox (and out the push channel),
  even on delivery failure.
- **`checkAndFirePendingContacts()` + `contactDeadlineFor()`** —
  escalation deadlines. The acknowledgement clock starts at FIRST
  CONFIRMED push delivery of the check-in (the human can only veto
  what they could have seen), falling back to the enqueue time when no
  push channel is configured, the push failed, or no delivery record
  lands within `DISPATCH_GRACE_MS` — a dead adapter can never block
  escalation forever. Pre-0.4.0 items with a precomputed
  `contactDeadlineTs` are honored as-is. Marks `delivered` *before*
  the async fire (double-delivery guard). All I/O injectable; covered
  by deterministic clock tests in `tests/cerebellum.test.mjs`.
- **`CONTACT_ESCALATION_DELAY_MS`** — the per-tier acknowledgement
  window (severe 30min / high 2h / moderate 6h).
- **Triage event log** — `appendTriageEventLog` / `readTriageEvents`
  on `logs/triage-events.jsonl`.
- **`readSettingsSync` / `primaryConnectionFrom`** — the single
  settings-reader implementation, imported by server.js.

These are the highest-stakes code paths in the system. Behavioral
changes here (not relocations) require explicitly asking the human
before shipping — see CLAUDE.md.

### Caring-spine modules

**`crisis-signals.js`** — auditable, pattern-based detector. Returns
`{ level, signals[] }` per message. 5 tiers (severe / high / moderate /
mild / safety). Damping for negation / hypothetical / others-speech /
hyperbolic context. The patterns are tuned for high precision on
SEVERE (the "cut me off" / "I want to die from embarrassment" false
positives are the regression cases the test suite watches).

**`threat-tracker.js`** — persistent decaying scalar at
`tomes/.threat-state.json` with 3-day half-life. Cap MAX=10, floor 0,
FIFO audit history (50). Off-switches: `PROTO_FAMILIAR_THREAT_DISABLED=1`
silences recording; `resetThreat()` always works regardless.

**`pondering.js`** — pure `ponderOnce({topic, provider, apiKey, model})`
that calls the LLM as the Familiar and writes a real first-person tome
entry to "Familiar's Ponderings" (entries are `enabled: false` so they
don't auto-fire as RAG lore — they're inspectable artifacts).

**`recent-ponderings.js`** — reads the N most recent pondering entries
within sinceDays and formats them as a prompt-injection block. Also
owns the deferred-intent consumer (Pillar B): `getUnactedIntents()`
returns unacted `wants_to_save` entries oldest-first; `markIntentActedOn()`
flips one `acted_on` flag under the per-file lock after the chat-turn
Familiar files it; `formatDeferredIntentsBlock()` renders the [Deferred
intents] block for enrich().

**`pondering-cadence.js`** — pure tiered formula:
`computeRequiredInterval(topWeight, threatLevel, { scale })`. Tiers:
high=30min / mid=60min / low=2h / idle=6h. Threat multiplies (severe
0.15× → calm 1.0×). User scale stretches (≥1×).

**`pondering-loop.js`** — autonomous singleton.
`runOneTick({getInterests, runPonder, getThreat, isEnabled,
getIntervalScale})` is the pure-ish surface; `startPonderingLoop`
wraps it with setInterval + lifecycle. Reentrancy-guarded; stop awaits
in-flight ticks.

**`reminders-loop.js`** — autonomous singleton. Every 30s, calls
Unruh's `reminders_due` MCP tool, enqueues each into the outbox
(idempotent on origin id so retries don't double-fire), then marks
the schedule node `resolution='fired'`. The frontend's outbox poller
turns each item into an assistant chat message in the active session.
Health-watch warns when `overdue` climbs across consecutive ticks.

**`silence-triage-loop.js`** — autonomous singleton. Every 5min, gates
on tier (calm/mild = no-op) and cool-down (LLM-controlled
`nextCheckInMs`, clamped to [30s, 24h], with per-tier defaults if
omitted). Tier-rise preempts the cool-down. The LLM call IS the
decision — `wait` is honored. On `reach_out`, posts to outbox (and out
the push channel via `enqueueAndDispatch`); if `contactHuman` is
included AND the name matches a configured trusted contact, schedules
a deferred Discord-webhook delivery (held until the user acknowledges
or `CONTACT_ESCALATION_DELAY_MS` elapses — counted from confirmed push
delivery; see cerebellum's `contactDeadlineFor`). The deliberation
prompt includes the Familiar's still-unacknowledged check-ins with
their delivery state, so a failed push reads as "they may never have
seen me," not as silence.

**`outbox.js`** — `tomes/.outbox.json` persistent queue. `enqueueOutbox`
dedups on `(kind, originId)` while unacknowledged. `listOutbox`
newest-first. `acknowledgeOutbox` / `clearAcknowledged`. `updateOutboxMeta`
for the triage loop's pending-contact deferral.

**`last-activity.js`** — single timestamp in `tomes/.last-activity.json`
stamped from the chat path; consumed by the silence-triage loop.

### `memorization.js` — session memorization

Unchanged from the original design. Persistent queue at
`tomes/.memorization-queue.json`, 5-second tick, exponential backoff,
per-Tome write mutex, idempotent enqueue on
`sessionId+scope+topicId+messageRange`.

### `public/app.js` — frontend (one file)

- **State + persistence** as before.
- **Tool rendering only** (since 0.4.0-alpha) — the registry and the
  executors live server-side in cerebellum.js. The app sends
  `runToolLoop: true` + custom tools + session metadata, renders the
  `_toolRound` / `_toolRounds` records as collapsible blocks, and
  persists the same assistant-tool_calls / tool message shapes in
  history as before, so old sessions render identically.
- **buildApiMessages** — assembles the request. Sends an explicit
  `userMessage` field (avoids the "post-history prompt shadows the
  actual user input" bug); post-history prompt is `role: 'system'`
  not `'user'`. One /api/chat request per user message — the server
  runs all tool rounds inside it.
- **Temporal editor modal** — six tabs (Interests / Threat /
  Ponderings / Schedule / Routine / Handoff), each with CRUD where
  applicable. The Routine tab hits `/api/temporal/phases` so phases
  on past dates surface (they recur). The Schedule tab has a **view
  toggle** (mirrors the Knowledge-Editor graph List/Map pattern):
  - **List** — the existing linear schedule view with windowed
    look-ahead (default 48h, configurable).
  - **Calendar** — month-grid view, Monday-start, 6×7 cells.
    Clicking a day opens the create form pre-filled to that date.
    Recurring nodes expand server-side so occurrences render on
    their actual dates; phases stay in the Routine tab to avoid
    cluttering daily-recurring rows. Iconography: recurring
    occurrences prefix with ↻, resolved ones strike through.
- **Local-time helpers** for the time pickers: convert between
  `<input type="time">` + `<input type="datetime-local">` and ISO UTC
  via real local-time semantics, not string-slicing.
- **Outbox delivery polling** — `startOutboxPolling()` polls
  `/api/outbox` every 30s; reminder / triage / outbound_alert items
  are injected as ordinary assistant chat messages in the active
  session (with `proactive: true` + `outboxKind` flags persisted on
  the message). Auto-acked after injection. Per-poll cap of 5 items
  so an upgrade-day backlog doesn't dump a wall of historical
  messages all at once.
  - **Design note (future):** The `#outbox-banners` div is still in
    `index.html` as an inert host. If pondering activity or the
    Familiar's in-progress thinking is ever made visible, the banner
    surface is the right place for it — ephemeral, non-intrusive,
    doesn't pollute the chat log. Reminders and triage stay as chat
    messages; pondering/thinking visibility would use banners.
- **Trusted contacts** UI for M12c (Discord webhook list).
- **Topic system** — gutter bars, "▷ Topic start" / "■ Topic end"
  buttons per-message, summarizer modal.
- **Tome engine** unchanged from the original SillyTavern-compatible
  implementation.

## Data flow — single chat request

```
User types message
       │
       ▼
buildApiMessages(userInput, userTimestamp)
   ├── activateTomeEntries()    ← keyword scan across all enabled Tomes
   ├── applyNameVars()           ← {{user}} / {{char}} / {{elapsedTime}}
   ├── pushes role:'user' content: userInput
   └── pushes role:'system' content: postHistoryPrompt   (was 'user' — fixed)
       │
       ▼
POST /api/chat  { messages, userMessage: userInput, … }
       │                                  ↑ explicit field — server uses this for
       │                                    detection + RAG query, not "last role:'user'"
       ▼  server.js
recordUserActivity()                     (fire-and-forget)
scoreMessage(userMessage)                ← crisis-signals.js
   if level ≠ 0 → recordThreat(level, signals)   ← threat-tracker.js (logged: "[threat] scored ±N")
       │
       ▼
thalamus.enrich(userMessage, { liveTurn: true })
   ├── identity_get_all     ──►  entity-core (MCP)        → static block
   ├── memory_search        ──►  entity-core (MCP)        ┐
   ├── graph_node_search    ──►  entity-core (MCP)        │
   ├── temporal_context     ──►  Unruh (MCP)              │ dynamic block:
   │     ├── current phase                                │  - RAG memory matches
   │     ├── full routine (live phases, date-independent) │  - graph excerpt
   │     ├── schedule window (events/tasks/reminders)     │  - "Today's rhythm"
   │     ├── interests (standing + live with weights)     │  - schedule sections
   │     └── handoff (session-end note)                   │  - interests
   ├── getRecentPonderings() ──► local tome read          │  - [CARE CHECK]
   └── getThreat()           ──► local file read          ┘  - [Temporal Context]
       │
       │  injection-guard.js is available but NOT applied to entity-core /
       │  Unruh content — those are trusted first-party systems. The guard
       │  is reserved for genuinely external ingestion points (web search
       │  results, Discord / channel-adapter messages) that do not yet exist.
       │  When those are built, sanitizeExternal() goes on the inbound
       │  boundary of each adapter, not on the recall path of own memory.
       │
       ▼
Prompt assembly (see "Prompt assembly" below)
       │
       ▼
fetch(providerURL, enrichedPayload)
       │
       ▼  SSE stream or JSON
Tool calls?  (server-side loop since 0.4.0-alpha)
   ├── YES → cerebellum.executeToolCall() per call → append results →
   │         re-call provider (up to 5 rounds, all inside the one
   │         /api/chat request; the [Now] time anchor is re-appended
   │         as the LAST message every round). Each round is streamed
   │         to the client as a `_toolRound` SSE event (or returned as
   │         the `_toolRounds` array when non-streaming) so the chat
   │         renders the collapsible tool blocks without executing
   │         anything.
   └── NO  → render assistant message → save to localStorage + server
```

The browser opts in by sending `runToolLoop: true` plus its custom
tools and session metadata; the built-in registry is composed
server-side (`cerebellum.composeActiveTools`). Direct `/api/chat`
callers that pass their own `tools` array keep the legacy passthrough
(single round, results handled by the caller). Enrichment runs ONCE
per user message — tool rounds reuse it — and the internal provider
re-calls never count against the 20 req/min chat rate limit.

### Custom tools — advertise-only (needs addressing post-MVP)

The Settings → Custom tools JSON array is appended to the advertised
tool list, but **no executor exists**: calls return a structured
"not implemented" notice into the loop. This is a deliberate pre-MVP
posture — useful for prototyping what the Familiar *would* do with a
tool — and it is flagged in the Settings UI. A real extension point
needs a decision about where user-supplied executors run (server-side
JS modules? declarative HTTP templates?) and what their security
boundary is. Until then: keep them advertised, keep the disclaimer,
don't silently drop the feature.

## Prompt assembly (cache-aware)

LLM providers cache the longest common prefix across consecutive
requests. The static identity block barely changes within a session,
so caching it is a big save — but only if per-turn-dynamic content
doesn't sit in front of it.

`thalamus.enrich()` returns `{ static, dynamic }`:

| Block | Contents | Lifetime | Placement |
|---|---|---|---|
| `static` | `base_instructions.md` + identity files (self / user / relationship / custom) | Stable across turns in a session | Prepended to the system message at index 0 |
| `dynamic` | RAG memory matches → knowledge-graph excerpt → recent ponderings → deferred intents → `[CARE CHECK]` (if threat ≠ calm) → `[Temporal Context]` | Re-derived every turn | Inserted as a separate `role: 'system'` message at `max(1, messages.length - depth)` |

The depth defaults to 4 (`thalamusDynamicDepth`, 1–50, server-synced).

Within `dynamic`, the order is deliberate:
1. **`[Now]`** — wall-clock + weekday + date + relative phrasing of "my human last sent a message" (see "Time perception" below). Always first so every other block reads against a consistent present.
2. **RAG memories** — direct retrieval relevance, weight-bearing facts. Each result's date is rendered through `relativeDay()` so "from yesterday" appears alongside the granularity tag.
3. **Graph excerpt** — entity-relationship context
4. **Recent ponderings** — the Familiar's own quiet thoughts (honesty loop). Each entry's `created_at` is rendered via `relativeTime()`.
5. **Deferred intents** — only on live turns. Up to 5 `wants_to_save` entries the Familiar flagged during free cycles but hasn't acted on yet. Shows the kind (tome/memory/identity), the summary, the routing tool, and the (uid, index) pair for `acknowledge_deferred_intent`. See "Deferred-action pattern" below.
6. **`[CARE CHECK]`** — only present when threat tier ≠ calm; carries identity-anchored guidance per tier
6. **`[Temporal Context]`** — handoff + today's rhythm + schedule window + interests. Every timed item (upcoming / reminders / resolved) is rendered through `relativeTime()` so the Familiar reads "tomorrow at 10am" / "in 30 minutes" rather than ISO timestamps.
7. **`[Surface candidates]`** — open schedule items that survived the hard gates (threat tier, routine phase, dedup window), packaged with consequence priors + person-model excerpt so the Familiar can decide in voice whether to mention any. See "Surface pipeline" below.

## Time perception (the `relative-time` layer)

Unruh tells the Familiar *when* events happened — but the Familiar perceives time the way humans do: in relative phrases (yesterday, this morning, in 2 hours, last Tuesday) rather than ISO arithmetic. `relative-time.js` is the single helper every consumer of timestamped data uses to render that phrasing, recomputed every turn against `Date.now()` — the same moment used for the `[Now]` block. A memory written yesterday reads as "yesterday" today and "two days ago" tomorrow, without anyone re-writing the memory.

Surfaces using `relativeTime()` / `relativeDay()`:

| Surface | Where | What it gets |
|---|---|---|
| `[Now]` block | thalamus.js enrich() | "Now: 2pm on Thursday, June 4. My human last sent a message 12 minutes ago." |
| RAG memories | thalamus.js enrich() | "(from daily/2026-06-03, **yesterday**, 87% relevant)" |
| Ponderings block | recent-ponderings.js | "— **this morning at 9am** · 'On honesty'" |
| Schedule items | temporal-format.js | "**tomorrow at 10am** — [event] dentist appointment" |
| Handoff | temporal-format.js | "Last session (**ended last Tuesday at 9pm**):" |
| Chat-turn messages | public/app.js buildApiMessages | "[14:30] hi" (every user + assistant message in history) |

The chat-turn message stamps use a compact `⫸HH:MM⫷` tag (U+2AF8 / U+2AF7) rather than full relative phrasing — the relative anchor is in the `[Now]` block, so each message just needs a marker the Familiar can correlate. The uncommon bracket chars matter: the earlier `[HH:MM]` format was common enough in natural text that the LLM started mimicking it back into its own responses, which then *accumulated* turn-over-turn when `toApiMessage` re-stamped the content (pile grew by one stamp per turn). Two defenses make accumulation impossible:

1. `stampContent` strips ALL existing `⫸HH:MM⫷` patterns from the content before prepending the fresh canonical tag. The authoritative source is the message's `timestamp` field — the content's tag is treated as disposable LLM-echo, never preserved.
2. UI render sites globally strip the same pattern so the user never sees them in chat. A small backward-compat sweep iteratively strips leading legacy `[HH:MM]` tags from pre-fix-era history (leading-only there, so mid-content references the user may have written stay intact).

Result: the LLM always sees exactly one canonical stamp per message every turn; the user sees none.

## Recurrence (events / tasks / reminders / phases that repeat)

Schedule nodes carry an optional `payload.recurrence` rule that turns one anchored entry into a series of occurrences without storing every occurrence separately:

```js
payload.recurrence = {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly',
  interval?: 2,                              // every N units (default 1)
  until?:    '2026-12-31',                   // cut-off date
  bysetpos?: -1 | 1 | 2 | 3 | 4,             // monthly only — "last" or "Nth"
  byweekday?: 0..6,                          // 0=Sun, 5=Fri — pairs with bysetpos
}
```

Common patterns:

| Need | Rule |
|---|---|
| Weekly cleaning every Sunday | `{ freq: 'weekly' }` anchored on a Sunday |
| Biweekly therapy | `{ freq: 'weekly', interval: 2 }` |
| Rent on the 1st of every month | `{ freq: 'monthly' }` anchored on the 1st |
| Birthday | `{ freq: 'yearly' }` |
| Last Friday of every month | `{ freq: 'monthly', bysetpos: -1, byweekday: 5 }` |
| First Monday of every month | `{ freq: 'monthly', bysetpos: 1, byweekday: 1 }` |

**Expansion flow** (read-time, no stored occurrences):

```
enrich()  ─► temporal_context  (Unruh)  → schedule.window (anchor-in-window items only)
       │
       ├─► listRecurring()    (Unruh)  → recurring anchors (any when_ts, including past)
       │
       └─► expandWindow(recurringAnchors, now-24h, now+7d)  (recurrence.js)
                                      ↓
                       merge into schedule.window
                                      ↓
                       formatTemporalContext()  (temporal-format.js)
```

Recurring anchors are dropped from the merged window if they'd otherwise appear (avoids both "the anchor stamped months ago" AND "today's occurrence" rendering).

**Per-occurrence resolution.** `payload.resolutions` is a map `{ "YYYY-MM-DD": "done"|"cancelled"|"carried_forward" }` keyed by local-TZ date. The expander filters out any occurrence whose date is in the map. Writers:
- `schedule_resolve_occurrence` MCP tool / `schedule_resolve` BUILTIN_TOOL with `occurrence_date` arg
- HTTP `POST /api/temporal/schedule/:id/resolve_occurrence`
- Temporal-editor "✓ done" / "✕ cancel" buttons auto-route to the per-occurrence endpoint when the item is an expanded occurrence (carries `__occurrence_of`).

The anchor's own `resolution` column still works — it cancels the WHOLE series rather than one occurrence. Use `schedule_resolve` without `occurrence_date` to end recurrence entirely.

UI: the temporal-editor schedule-create form has a **Repeats** dropdown with the common presets. The Familiar's `schedule_add_*` BUILTIN_TOOLS accept a `recurrence` object so the model can set arbitrary rules — including the "last Friday" pattern — directly from chat.

Bounded: the expander caps at 50 occurrences per anchor (overflow guard against malformed rules) and handles month-clamp edge cases (Jan 31 → Feb 28 instead of overflowing to March 3; Feb 29 → Feb 28 in non-leap years).

## Surface pipeline (the consumer side of personalization)

Open schedule items don't speak for themselves — the Familiar needs to
decide whether *this* moment is the moment to raise one, and how. The
surface pipeline rides existing LLM calls rather than spinning up a
new request per task (see CLAUDE.md "Ride existing requests; gate in
code"). All three triggers — opportunistic, triggered, care-driven —
plus the reflection loop net zero new LLM requests.

```
temporalPayload.schedule.window   ←  open tasks/events/reminders
                │
                ▼
   ── HARD GATES (pure code, no LLM) ──
   threat tier (severe → none; high → external_obligation only)
   routine phase (quiet_routine pattern → external_obligation only)
   dedup window (6h if the last offer was actually RAISED in the
   response; 90min if not — staying quiet never buys long
   suppression. Bypassed by external_obligation.)
                │
                ▼
   ── CONTEXT ASSEMBLY (per candidate) ──
   stakes_tier  ← payload.stakes_tier OR inferStakesTier(label)
   priorsBlock  ← matched section from docs/consequence-priors.md
   personModel  ← entity-core custom/what_lapses_cost.md (raw)
   taskSpecific ← payload.consequence_model
   confidence   ← high/medium/low based on what info is present
                │
                ▼
   ── PROMPT BLOCK ──
   [Surface candidates] block appended to enriched dynamic
   surfacedTasks list returned alongside surfacedBookmarks
                │
                ▼
   ── EVENT RECORD (fire-and-forget) ──
   Append to tomes/.surface-events.json with full event record
   (state_snapshot, stakes_tier, confidence, raised=null,
   outcome=null). Two taggers fill the record in later:
                │
                ▼
   ── RAISED TAG (post-turn, pure code) ──
   tagRaisedOutcomes scans the final response text for each offered
   task's label (same accepted-imprecision pattern as the M8 bookmark
   outcome scan; four call sites in server.js — both tool-loop paths
   and both plain paths) and tags the offer raised=true/false. The
   dedup gate reads it via getRecentOfferInfo: only a raised offer
   earns the 6h window. The outcome tagger separately fills in
   `outcome` when the schedule resolves.
```

**Triggers** (all rides, zero new LLM calls):

| Trigger | When | Riding | Carrier |
|---|---|---|---|
| Opportunistic | User just sent a chat message | Chat-turn enrich call | `[Surface candidates]` block in `dynamic` |
| Triggered | Reminder hits its `when_ts` | Pure-code firing (set at creation by the Familiar) | Chat message via outbox (since 0.3.9-alpha) |
| Care-driven | Silence-triage decided to reach out | The triage LLM call that's already happening | "Candidate tasks I could touch on" block in triage prompt |

**`stakes_tier`** controls surfacing pressure:
- `external_obligation` — real-world clock + external consequences (paperwork, deadlines, appointments). Bypasses quiet-hours and dedup. Surfaces under high threat.
- `personal_wellbeing` — internal, reversible, person-specific decay (meals, hygiene, exercise). Respects all soft gates.
- `purely_optional` — only matters if {{user}} cares. Lowest surfacing pressure.

Inferred from label by `inferStakesTier()` in `surface-context.js`. Overridable by the Familiar at creation (BUILTIN_TOOLS `stakes_tier` arg) and by {{user}} in the temporal editor (Stakes dropdown).

**`consequence_model`** is per-task free-text attached to the schedule node payload, informing framing when the task surfaces.

## Reflection loop (slice 2)

The pondering loop has a *mode*: when 5+ tagged surface outcomes have accumulated since the last reflection, the next pondering tick reflects on them instead of pondering an interest. **Same LLM call, different topic shape — zero new requests.**

```
pondering-loop.runOneTick()
   │
   ▼
shouldReflectNow()  ← reads tomes/.surface-events.json,
                      counts events with outcome ≠ null whose
                      outcome_at > last_reflection_at. ≥ 5 → true.
   │
   ▼ (true)
getReflectionInput()  ← projects fresh outcomes + current
                        what_lapses_cost.md content + identity
                        anchor into the reflection prompt input
   │
   ▼
runPonder(input, { mode: 'reflection' })
   │ ponderOnce() dispatches via buildPonderPrompt(input.mode === 'reflection')
   ▼
LLM returns:
  { title, content, what_lapses_cost_update: null | { heading, content } }
   │
   ├── Pondering tome write (scope: 'reflection')
   ├── markReflected(now) — resets fresh-outcome window
   └── If what_lapses_cost_update present:
       updateIdentitySection({ category: 'custom',
                               filename: 'what_lapses_cost.md',
                               heading, content })   ← via entity-core MCP
```

**Outcome tagging** is pure-code, runs at chat-turn entry as a fire-and-forget pass over `tomes/.surface-events.json`:

| Schedule signal | Outcome |
|---|---|
| `resolution === 'done'` | `engaged_and_completed` |
| `resolution === 'cancelled'` | `cancelled` |
| `resolution === 'carried_forward'` | `deferred` |
| `resolution === 'fired'` (reminder) | `fired` |
| unresolved + offered > 24h ago | `unresponded` |
| unresolved + < 24h | left null, re-checked next turn |

Once tagged, an event's `outcome` is immutable — the LLM later reasons about a stable record, not a moving target.

**`raised` tagging** is a separate, earlier tag on the same event: did the Familiar actually *say* something about the task in the turn it was offered? Tagged post-turn by `tagRaisedOutcomes` (pure-code response-text scan, zero LLM calls). It drives the differentiated dedup window (raised → 6h rest; un-raised → back in 90min) and flows into reflection automatically — "offered N times, never raised" is itself a pattern the reflection loop can learn from, since reflection events carry the field.

**Prompt stance:** the `[Surface candidates]` header frames holding tasks as part of the Familiar's care and names BOTH costs at equal weight (interrupting the moment vs. a task quietly slipping). It deliberately contains no bias-toward-quiet language — see CLAUDE.md's proactivity section; a regression test in `tests/surface-context.test.mjs` guards against its return.

**Storage decision:** event records and reflection metadata live in `tomes/.surface-events.json` (per-embodiment, like ponderings). Identity-layer *insights* derived from them ("Eury crashes within 4h of skipping meals") get lifted to entity-core's `custom/what_lapses_cost.md` only after the reflection LLM judges the pattern strong enough. The raw event stream belongs to Proto-Familiar; the durable knowledge belongs to the entity.

**`what_lapses_cost.md`** lives at `entity-core/custom/what_lapses_cost.md`. The Familiar writes via the reflection loop when patterns emerge. May not exist initially; surface-context assembly is null-tolerant.

Files: `surface-context.js`, `surface-events.js`, `docs/consequence-priors.md`.

## Deferred-action pattern (wants_to_save)

The autonomous pondering loop has no tool access — it's a background process that calls the LLM and writes to a tome, but can't call `save_memory` or `update_identity` during that call. The deferred-action pattern bridges this gap in two pillars:

**Pillar A (pondering-loop side, `pondering.js`):** When the Familiar notices, while pondering, that something fact-shaped wants to be filed, she records a `wants_to_save` intent in the tome entry instead of trying to write it there. Each intent has `kind` (tome/memory/identity), `summary` (what to save), and `acted_on: false`.

**Pillar B (chat-turn side, `recent-ponderings.js` + `thalamus.js`):** At the start of every live chat turn, `getUnactedIntents()` reads up to 5 unacted intents (oldest-first) from the ponderings tome. `enrich()` formats them as a `[Deferred intents from my free time]` block in the dynamic context — one entry per intent with the routing tool (`save_to_tome` / `save_memory` / `update_identity`) and the `(uid, index)` pair. The Familiar files each one at her own discretion during the turn. After each filing, she calls `acknowledge_deferred_intent(uid, index)`, which hits `POST /api/ponderings/intents/acted-on` and flips `acted_on` to `true` under the per-file lock.

The pattern is forward-compatible: any module that produces `wants_to_save` intents (pondering, reflection, future scan candidates) shares the same consumer infrastructure. No new LLM requests; the intents ride the existing chat turn.

`injectDynamicAtDepth(messages, dynamicContent, depth)` in `server.js`
is a pure helper; `tests/depth-inject.test.mjs` guards the
load-bearing invariant *"messages[0..injectedAt-1] is the same
reference as the input"* — without it, the prefix-cache claim is
hollow.

## Significant memories — the composite-key contract (regression guard)

This contract broke once already, silently, as a side effect of a fix.
Read this before touching ANYTHING that addresses a memory by date.

**The entity-core contract** (source of truth: `packages/entity-core/src/tools/memory.ts` in Psycheros):

- Significant memories are stored **one named file per milestone**:
  `data/memories/significant/{date}_{slug}.md`
  (e.g. `2026-06-11_why-melian-trusts-me.md`). The slug is mandatory in
  practice — two slugless saves on the same date collide on `{date}.md`
  and entity-core's merge-and-dedup destroys content (the original
  "significant memories disappearing" bug).
- `memory_list` returns significant entries with a **composite** `date`
  field: `` slug ? `${date}_${slug}` : date ``.
- `memory_read` / `memory_update` / `memory_delete` do **NOT** accept
  the composite form — they validate `date` against
  `/^\d{4}(-W\d{2}|(-\d{2})?(-\d{2})?)$/` and take `slug` as a
  **separate optional parameter**. An update that reaches entity-core
  without a slug relies on its fall-back-to-existing-slug behaviour to
  avoid writing a bare `{date}.md` that *shadows* the real
  `{date}_{slug}.md`.

So the identifier a consumer **sees** (from listings) is not the
identifier the write tools **accept**. Every seam between the two must
split the composite key.

**The single splitting point:** `cerebellum.parseMemoryKey(key)` →
`{ date, slug | null }` or `null`. Splits at the FIRST underscore
(dates never contain one; slugs may), and rejects slugs containing
dots or slashes so a key can never smuggle path segments. Do not
re-implement this split anywhere else.

**The seams that must honor the contract** (all wired as of 0.4.1-alpha):

| Seam | What it does |
|---|---|
| `GET/PUT/DELETE /api/entity/memories/:granularity/:date` (server.js) | Accepts the composite `:date`, splits via `parseMemoryKey`, passes `date` + `slug` separately to thalamus. **Never reintroduce a plain-date regex here.** |
| `thalamus.readMemory` / `updateMemory` / `deleteMemory` | Pass `slug` through to entity-core's tools. `updateMemory` without the slug is the shadow-file hazard. |
| `update_memory` / `delete_memory` executors (cerebellum.js) | Split the model-supplied key; their tool descriptions teach the `YYYY-MM-DD_slug` addressing. |
| `save_memory` executor | Auto-derives the slug (`deriveMemorySlug`) and returns the composite key in its confirmation so the Familiar knows the address of what it just wrote. |
| Knowledge editor (app.js) | Deliberately dumb: sends back whatever key the list returned. Keep it that way. |

**How it broke the first time** (so it isn't repeated): originally,
significant saves had no slugs — listings returned plain dates and the
editor worked, but same-date saves destroyed each other. The slug fix
(0.3.x) made *writes* safe, which changed what `memory_list` returns —
and the read/edit/delete seams, still validating plain dates, started
rejecting every new entry with `invalid date format` (found
2026-06-11, fixed in 0.4.1-alpha). The lesson: the date+slug contract
spans multiple seams across two repos; a change to how memories are
*written* is also a change to how they are *addressed*, and every seam
in the table above must move together.

**The guard:** the `parseMemoryKey` suite + executor-hint tests in
`tests/cerebellum.test.mjs`. If a refactor makes those tests awkward,
that is the contract talking — update all seams together or stop.

## Autonomous loops — when and what

| Loop | Cadence | Off-switch | What it does |
|---|---|---|---|
| Memorization | 5s tick | (none — always on) | Drains queue of session-memorization jobs |
| Pondering | 1min tick + tier-based interval | Settings toggle + `PROTO_FAMILIAR_PONDERING_DISABLED=1` | Picks an interest, ponders it, writes a real tome entry |
| Reminders | 30s tick | `PROTO_FAMILIAR_REMINDERS_DISABLED=1` | Polls `reminders_due`, enqueues into outbox, marks fired |
| Silence triage | 5min tick + LLM-set cool-down | `PROTO_FAMILIAR_TRIAGE_DISABLED=1` | LLM decides "should I reach out?" given threat + silence |
| Threat detection | per chat msg (in-band) | `PROTO_FAMILIAR_THREAT_DISABLED=1` | Patterns score user text; tracker accumulates with decay |

The autonomous loops do not run during shutdown — server.js's SIGTERM
handler awaits each loop's `stop*()` before closing the MCP children.

## Security design

- **API key handling:** key travels browser → `localhost` only. Server
  uses it once per request and discards. Browser persists in
  `localStorage`; don't use on shared / untrusted devices.
- **Path traversal:** all file-backed endpoints validate IDs against
  strict UUID regex before constructing paths. Covers session logs,
  Tome IDs, Tome entry UIDs.
- **Rate limiting:** `POST /api/chat` is per-IP, 20/min, in-memory.
- **Prompt inspector + temporal editor + threat surface:** unauthenticated.
  Intended for localhost. Disable / firewall before any non-loopback
  deployment.
- **Entity-core permissions:** spawned with `deno run -A`. Acceptable for
  a personal local tool; scope down for shared deployments.
- **Input size:** `express.json` capped at 4MB; per-field memory + identity
  writes capped at 8KB.
- **Tailscale gate:** server binds `0.0.0.0` but rejects non-loopback
  with `403` until the in-UI Tailscale toggle is on. Toggle endpoint
  is itself unauthenticated — leave off unless you trust the network.
- **Trusted-contact outreach (M12c):** Discord webhook only. Every
  outbound is duplicated into the user's chat outbox (`kind:
  'outbound_alert'`) so there is no covert contact. Hallucinated
  contact names are server-side rejected. Empty contacts list = no
  outreach possible. See
  [docs/threat-detection.md](threat-detection.md).
- **No telemetry:** no data leaves localhost except the proxied LLM
  request to the user-configured provider.

## Related docs

- [`CLAUDE.md`](../CLAUDE.md) — agent guide, philosophy, robust-over-cheap,
  proactivity-is-desired, entity-as-subject conventions.
- [`docs/threat-detection.md`](threat-detection.md) — the caring spine
  in detail, off-switches, every signal pattern.
- [`docs/caring-spine-build-plan.md`](caring-spine-build-plan.md) — the
  per-step build path that landed the spine.
- [`docs/cerebellum-design.md`](cerebellum-design.md) — the motor
  module's design rationale: the efferent symmetry, the thalamus
  boundary, tool dispatch, channel adapters, the escalation veto
  window.
- [`docs/unruh-design.md`](unruh-design.md) — temporal-context module.
- [`docs/research/`](research/) — research notes that feed future
  design decisions (task-handling obstacles, etc.).
