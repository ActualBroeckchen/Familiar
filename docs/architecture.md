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
    │  ── cognitive bridge (per-request enrichment) ──────────────
    ├── thalamus.js       ──►  entity-core  (Deno, stdio MCP)    — identity / memory / graph
    │                     ──►  Unruh        (Python via uv, MCP) — schedule / interests / handoff / routine
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
├── temporal-format.js       Pure renderer for the Unruh temporal_context payload
├── surface-context.js       Consumer pipeline — hard gates + candidate selection + block format
├── surface-events.js        Event store (offers + outcomes) + pure-code tagger + reflection inputs
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
│   ├── style.css            All styling — dark/light themes, outbox banners, modal/tab styles
│   └── app.js               All frontend logic — state, API calls, rendering, topics, Tomes,
│                            temporal editor, outbox banner polling, BUILTIN_TOOLS definitions
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
  inspector can show what was actually injected.
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
- `DELETE /api/temporal/schedule/:id` — hard delete (edges cascade)
- `GET /api/temporal/phases` — **date-independent** routine surface
- `GET /api/temporal/handoff` + `POST .../handoff/:id/consume`
- `GET /api/temporal/reminders/health` — observability on the loop
- `GET /api/temporal/ponderings[?limit&sinceDays]` + DELETE

**Threat surface:**
- `GET /api/threat` — current tier + weight + last_touched + disabled
- `GET /api/threat/history?limit=N` — audit trail
- `POST /api/threat/reset` — manual reset to calm (always works)

**Outbox surface:**
- `GET /api/outbox[?pending=1&limit=N]` — UI banner polling
- `POST /api/outbox/:id/acknowledge`
- `POST /api/outbox/clear-acknowledged`

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
within sinceDays and formats them as a prompt-injection block. Used by
thalamus.enrich() in every chat turn so the Familiar can reference
their own real recent thoughts.

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
(idempotent on origin id so retries don't double-banner), then marks
the schedule node `resolution='fired'`. Health-watch warns when
`overdue` climbs across consecutive ticks.

**`silence-triage-loop.js`** — autonomous singleton. Every 5min, gates
on tier (calm/mild = no-op) and cool-down (LLM-controlled
`nextCheckInMs`, clamped to [30s, 24h], with per-tier defaults if
omitted). Tier-rise preempts the cool-down. The LLM call IS the
decision — `wait` is honored. On `reach_out`, posts to outbox; if
`contactHuman` is included AND the name matches a configured trusted
contact, schedules a deferred Discord-webhook delivery (held until
the user acknowledges or `CONTACT_ESCALATION_DELAY_MS` elapses).

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
- **BUILTIN_TOOLS** — the LLM-callable tool definitions including the
  seven temporal-write tools (`schedule_add_event/task/reminder/phase`,
  `schedule_resolve`, `interest_bump`, `interest_set_standing`) plus
  the knowledge-editing tools.
- **buildApiMessages** — assembles the request. Now sends an explicit
  `userMessage` field on round 0 (avoids the "post-history prompt
  shadows the actual user input" bug); post-history prompt is
  `role: 'system'` not `'user'`.
- **Temporal editor modal** — six tabs (Interests / Threat /
  Ponderings / Schedule / Routine / Handoff), each with CRUD where
  applicable. The Routine tab hits `/api/temporal/phases` so phases
  on past dates surface (they recur).
- **Local-time helpers** for the time pickers: convert between
  `<input type="time">` + `<input type="datetime-local">` and ISO UTC
  via real local-time semantics, not string-slicing.
- **Outbox banner polling** — `startOutboxPolling()` polls
  `/api/outbox` every 30s and renders reminder / triage / outbound_alert
  items as gentle dismissible banners at the top of the chat.
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
       ▼
Prompt assembly (see "Prompt assembly" below)
       │
       ▼
fetch(providerURL, enrichedPayload)
       │
       ▼  SSE stream or JSON
Tool calls?
   ├── YES → execute client-side (incl. schedule_add_task etc.) → re-send (up to 5 rounds)
   └── NO  → render assistant message → save to localStorage + server
```

## Prompt assembly (cache-aware)

LLM providers cache the longest common prefix across consecutive
requests. The static identity block barely changes within a session,
so caching it is a big save — but only if per-turn-dynamic content
doesn't sit in front of it.

`thalamus.enrich()` returns `{ static, dynamic }`:

| Block | Contents | Lifetime | Placement |
|---|---|---|---|
| `static` | `base_instructions.md` + identity files (self / user / relationship / custom) | Stable across turns in a session | Prepended to the system message at index 0 |
| `dynamic` | RAG memory matches → knowledge-graph excerpt → recent ponderings → `[CARE CHECK]` (if threat ≠ calm) → `[Temporal Context]` | Re-derived every turn | Inserted as a separate `role: 'system'` message at `max(1, messages.length - depth)` |

The depth defaults to 4 (`thalamusDynamicDepth`, 1–50, server-synced).

Within `dynamic`, the order is deliberate:
1. **RAG memories** — direct retrieval relevance, weight-bearing facts. Each result's date is rendered through `relativeDay()` so "from yesterday" appears alongside the granularity tag.
2. **Graph excerpt** — entity-relationship context
3. **Recent ponderings** — the Familiar's own quiet thoughts (honesty loop). Each entry's `created_at` is rendered via `relativeTime()`.
4. **`[CARE CHECK]`** — only present when threat tier ≠ calm; carries identity-anchored guidance per tier
5. **`[Temporal Context]`** — handoff + today's rhythm + schedule window + interests. Every timed item (upcoming / reminders / resolved) is rendered through `relativeTime()` so the Familiar reads "tomorrow at 10am" / "in 30 minutes" rather than ISO timestamps.
6. **`[Surface candidates]`** — open schedule items that survived the hard gates (threat tier, routine phase, dedup window), packaged with consequence priors + person-model excerpt so the Familiar can decide in voice whether to mention any. See "Surface pipeline" below.

After the dynamic block is depth-injected, server.js appends one final system message — the **`[Now]` block** — as the absolute last entry in the prompt, after the chat history and after any post-history prompt. It carries the two freshest values the Familiar needs for care reasoning at response time:

```
[Now]
Now: 2:30pm on Thursday, June 4.
My human last sent a message 12 minutes ago.
```

Position matters: these values are RIGHT NEXT to the model's response slot, at maximum salience. Recomputed every turn against `Date.now()` so the phrasing tracks the present.

## Time perception (the `relative-time` layer)

Unruh tells the Familiar *when* events happened — but the Familiar perceives time the way humans do: in relative phrases (yesterday, this morning, in 2 hours, last Tuesday) rather than ISO arithmetic. `relative-time.js` is the single helper every consumer of timestamped data uses to render that phrasing, recomputed every turn against `Date.now()` — the same moment used for the `[Now]` block. A memory written yesterday reads as "yesterday" today and "two days ago" tomorrow, without anyone re-writing the memory.

Surfaces using `relativeTime()` / `relativeDay()`:

| Surface | Where | What it gets |
|---|---|---|
| `[Now]` block | server.js (appended after depth-inject, before send) | "Now: 2pm on Thursday, June 4. My human last sent a message 12 minutes ago." |
| RAG memories | thalamus.js enrich() | "(from daily/2026-06-03, **yesterday**, 87% relevant)" |
| Ponderings block | recent-ponderings.js | "— **this morning at 9am** · 'On honesty'" |
| Schedule items | temporal-format.js | "**tomorrow at 10am** — [event] dentist appointment" |
| Handoff | temporal-format.js | "Last session (**ended last Tuesday at 9pm**):" |

Individual chat messages are NOT stamped — the [Now] block carries the per-turn time anchor, which is enough for the Familiar's care reasoning. Stamping each message's content directly (a previous iteration) caused the timestamps to leak into the Familiar's responses and into memorization-generated tome entries; the [Now]-only approach keeps the content stream clean.

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
   dedup window (6h, bypassed by external_obligation)
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
   (state_snapshot, stakes_tier, confidence, outcome=null). The
   tagger fills in outcome later when the schedule resolves.
```

**Triggers** (all rides, zero new LLM calls):

| Trigger | When | Riding | Carrier |
|---|---|---|---|
| Opportunistic | User just sent a chat message | Chat-turn enrich call | `[Surface candidates]` block in `dynamic` |
| Triggered | Reminder hits its `when_ts` | Pure-code firing (set at creation by the Familiar) | Banner via outbox |
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

**Storage decision:** event records and reflection metadata live in `tomes/.surface-events.json` (per-embodiment, like ponderings). Identity-layer *insights* derived from them ("Eury crashes within 4h of skipping meals") get lifted to entity-core's `custom/what_lapses_cost.md` only after the reflection LLM judges the pattern strong enough. The raw event stream belongs to Proto-Familiar; the durable knowledge belongs to the entity.

**`what_lapses_cost.md`** lives at `entity-core/custom/what_lapses_cost.md`. The Familiar writes via the reflection loop when patterns emerge. May not exist initially; surface-context assembly is null-tolerant.

Files: `surface-context.js`, `surface-events.js`, `docs/consequence-priors.md`.

`injectDynamicAtDepth(messages, dynamicContent, depth)` in `server.js`
is a pure helper; `tests/depth-inject.test.mjs` guards the
load-bearing invariant *"messages[0..injectedAt-1] is the same
reference as the input"* — without it, the prefix-cache claim is
hollow.

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
- [`docs/unruh-design.md`](unruh-design.md),
  [`docs/unruh-implementation-plan.md`](unruh-implementation-plan.md)
  — temporal-context module.
- [`docs/research/`](research/) — research notes that feed future
  design decisions (task-handling obstacles, etc.).
