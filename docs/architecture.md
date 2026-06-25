# Architecture

> **Keep this current.** When component responsibilities, data flow,
> or the prompt-assembly order changes in code, update this doc in
> the same commit. CLAUDE.md mandates it because architecture
> drift is a top driver of "future-me has no idea why X" bugs.

## Overview

Proto-Familiar is a Node.js application — a thin Express server +
vanilla-JS single-page frontend — that surfaces a persistent AI
companion (the Familiar) bonded to one human. It is an **embodiment**
of the same entity held in **Phylactery** — the in-tree
canonical store (Phylactery milestone complete as of 0.6.x); see
[CLAUDE.md](../CLAUDE.md#entity-as-subject--the-design-value-under-everything)
and the [Psycheros PHILOSOPHY.md](https://github.com/PsycherosAI/Psycheros/blob/main/PHILOSOPHY.md)
for the design value that everything below descends from.

The server's responsibilities:

1. **Proxy LLM requests** so the user's API key never leaves localhost.
2. **Enrich every request** with cognitive-module context: identity +
   memory + graph from Phylactery, temporal context + ponderings +
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
server.js  (Express, Node 22+, ESM)
    │
    │  ── cognitive bridge (per-request enrichment, INWARD) ────────
    ├── thalamus.js       ──►  Phylactery  (Python via uv, stdio MCP) — identity / memory / graph / snapshots
    │                     ──►  Unruh       (Python via uv, stdio MCP) — schedule / interests / handoff / routine
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
    ├── reachout-loop.js    ── autonomous: warm non-crisis outreach
    ├── reachout.js         ── warm-outreach decision (ward + warm villagers)
    ├── outbox.js           ── persistent delivery queue (reminders, triage, alerts)
    ├── last-activity.js    ── timestamps user activity for the silence loop
    │
    │  ── village (audience gating + external presence) ───────────
    ├── village.js          ── registry: categories/grants, villagers, locations
    ├── audience.js         ── grant resolution + section-marker gate (V3)
    ├── discord-gateway.js  ── autonomous: bidirectional Discord presence (V4); per-location presence modes strict/lurk/active + mention legibility + readBots (V8); deferred presence [later:…] revisit queue (V9)
    │
    │  ── classical infrastructure ──────────────────────────────
    ├── memorization.js     ── autonomous per-fact memorization queue + worker (Pillar C)
    ├── outgoing-filter.js  ── Pillar D: post-response semantic gate before delivery
    ├── temporal-format.js  ── pure renderer for Unruh's payload
    ├── providers.js        ── shared chat-completions URL map
    │
    ├── logs/               session JSON files (git-ignored)
    └── tomes/              per-Tome JSON files + state caches
        ├── .memorization-queue.json   (git-ignored)
        ├── .consent-pending.json      (git-ignored) — pending consent IDs for Phylactery
        ├── .threat-state.json{,.tmp}  (git-ignored)
        ├── .outbox.json{,.tmp}        (git-ignored)
        └── .last-activity.json{,.tmp} (git-ignored)
```

Thalamus is a **plural-peer mediator**: each cognitive module is a
separate stdio MCP child spawned at boot. Failures degrade
independently — Phylactery down doesn't take Unruh out, and vice
versa — and `enrich()` fans out across whichever peers are live
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
├── thalamus.js              MCP bridge — Phylactery + Unruh, plus all the helper wrappers
├── cerebellum.js            Motor module — tool registry + executors + tool loop, triage deliberation, trusted-contact delivery, escalation deadlines
├── crisis-signals.js        Pattern-based detector — 5 tiers, ~13 signal categories, damping
├── threat-tracker.js        Decaying scalar with audit history, off-switches, file persistence
├── pondering.js             Pure `ponderOnce()` primitive — LLM call + tome write
├── pondering-cadence.js     Tiered interval formula + threat multiplier + user-stretch scale
├── pondering-loop.js        Autonomous singleton loop; integrates with cadence + isEnabled gate
├── reminders-loop.js        Autonomous singleton loop; polls Unruh for due reminders
├── silence-triage-loop.js   Autonomous singleton loop; LLM-deliberated proactive check-ins
├── reachout-loop.js         Autonomous singleton loop; warm non-crisis outreach (companionship). Stands down at moderate+ threat (triage owns distress); quiet-hours + cooldown gated
├── tome-graduation-loop.js  Autonomous singleton loop (Phase 4, opt-in/default-OFF); drains durable facts stranded in tomes into Phylactery (identity + memory + graph; relational facts resolve-or-create nodes + dedup edges). Pure logic in tome-graduation.js. Code-gated candidates → one batched LLM judgment (Phase-3 rubric; leans toward graduating — consolidation back-end prunes over-gathering) → route via thalamus wrappers (ward memory consent-gated) → tidy only after confirmed route (delete/pointer). Off-switch PROTO_FAMILIAR_TOME_GRADUATION_DISABLED=1; distinct from Pillar H (identity→RAG)
├── reachout.js              Warm-outreach decision: getWarmVillagers (relationToFamiliar==='warm' + reachable), buildReachoutPrompt (warm-framed, not crisis), decideReachoutViaLLM
├── outbox.js                Delivery queue (reminders / triage / reachout / relay / outbound_alert), dedup on originId
├── last-activity.js         Tiny persistent "user last typed at" timestamp
├── recent-ponderings.js     Read recent pondering tome entries for in-chat reference
├── interest-picker.js       Weight-proportional sampler for the pondering loop
├── relative-time.js         Natural-English relative phrasing for every timestamped surface (memories, ponderings, schedule, handoff, "Now")
├── recurrence.js            Recurrence-rule expansion — turns one "weekly cleaning" anchor into occurrences within the temporal window
├── temporal-format.js       Pure renderer for the Unruh temporal_context payload
├── surface-context.js       Consumer pipeline — hard gates + candidate selection + block format
├── surface-events.js        Event store (offers + outcomes) + pure-code tagger + reflection inputs
├── village.js               Village registry (V1) — categories/grant sets, villagers (name/pronouns/aliases/relation/stance/comm-style/notes/privateNotes/remember consent map/graphNodeId), locations; local mirror + Phylactery write-through sync (see docs/village-support-design.md). The Familiar reaches it via the village_lookup / village_upsert tools (privateNotes field-gated to ward-private turns)
├── own-files.js             Sandboxed read-only access to the Familiar's own checkout — resolves repo-relative paths inside the root, denies secrets (settings.json, .env) + build noise (node_modules/.git/.venv), size-caps + text-only. Backs the list_files / read_file tools (ward-private only)
├── websearch.js             Web access (opt-in, 0.7.0) — backs the look_up / web_search / read_webpage tools. look_up (0.7.19) answers definitions/facts/overviews from keyless official reference APIs (Wikipedia action API + DuckDuckGo Instant Answer API), no scraping/no setup. web_search finds pages; searchWeb resolves the human-chosen backend: webSearchBackend ∈ {basic → in-box keyless DuckDuckGo HTML scrape (no setup); api → a provider adapter (Marginalia/Tavily/Brave/Google) via webSearchApiProvider+key}. ANY backend failing falls through to the keyless floor — a wrong key / down provider never leaves the human without search. Each search logs which backend actually served (`[websearch] "q" — served via …` / `… failed […]; fell back to built-in keyless search`) so a silent fallback is visible (0.7.28). Owns the SSRF guard (scheme allow-list + resolved-IP block of loopback/private/link-local/metadata + redirect re-validation), the fetch timeout, and the linkedom→@mozilla/readability→turndown extraction with provenance stamping. cerebellum registers the defs + delegates; gated by webSearchEnabled / PROTO_FAMILIAR_WEBSEARCH_DISABLED=1. (The managed local engines — SearXNG/4get/LibreY — were removed in 0.7.38; Marginalia + APIs + the floor cover the same ground without the install/spawn machinery.)
├── websearch-providers.js   Proper search-API adapters (0.7.20; marginalia 0.7.37) — braveSearch / tavilySearch / googleSearch / marginaliaSearch, one small JSON client each (no scraping), all returning the same {rows}|{error} shape searchWeb dispatches through (API_PROVIDERS registry). Marginalia is an INDEPENDENT small-web index whose "public" key needs no signup (API-Key header; 503 when the shared key is rate-limited). Provider hosts are sanctioned public endpoints (not the SSRF-guarded read path); missing/bad key → {error} → searchWeb degrades to the floor
├── guide-chat.js            In-modal web-search explainer (0.7.29) — the SAME Familiar, scoped to explaining the search-backend options in plain language. buildGuideSystem() assembles a STRIPPED context (framing + identity layer via enrich staticOnly + the four prompt fields + a tools-info block with honest per-option trade-offs and Brave/Tavily signup steps + a no-jargon block), macro-resolved. Explainer only: no tools, no memory/graph/temporal/care-check, not persisted/memorised. Backs POST /api/guide-chat. Off-switch PROTO_FAMILIAR_GUIDE_CHAT_DISABLED=1
├── web-fetch-util.js        timedFetch — a shared fetch-with-AbortController-timeout used by the search-API provider adapters (one place, not copy-pasted). Not the SSRF guard; just the timeout + JSON defaults for sanctioned backends
├── audience.js              Audience grant resolution (V3) — union/intersection/ladders, fetch eligibility, identity section markers; consumed by thalamus.enrich() and the Discord router
├── discord-gateway.js       Discord gateway adapter (V4+V5+V6) — bot-token WebSocket presence; DM policy + mention-only guild replies, per-location sessions, V3 gate applied before every reply; V5: per-location connection routing (location.connectionId → settings.connections → primary fallback) + hourly token-bucket rate limiting (tomes/.rate-limits.json, ward outbox notice on exhaustion); V6: relayToDiscord() REST send (DM-open or channel post) backing the relay_message tool; off-switch PROTO_FAMILIAR_DISCORD_DISABLED=1
├── knocks.js                Village knock list (V4.x) — contact attempts from unregistered people, captured for one-click registration in the Village editor; tomes/.village-knocks.json, capped, metadata only
├── injection-guard.js       Prompt injection immunization — pattern scanner + sanitizer applied at every external-data boundary
├── memorization.js          Persistent per-session memorization queue + worker; V7: buildSharedRoomPrompt variant selected when audienceTag !== 'ward-private' — focuses on ward-only facts, skips unregistered-third-party detail
├── outgoing-filter.js       Pillar D outgoing gate — semantic check before delivery; retries up to budget then safe-refusal
├── providers.js             Shared chat-completions URL map (used by server.js + thalamus.js)
├── macros.js                Shared macro substitution — `substituteMacros(text, settings)` resolves `{{user}}`/`{{char}}` to configured names. Applied at three boundaries: (1) LLM prompts (triage, reachout), (2) tool results (`executeToolCall` result boundary — all executors covered automatically), (3) tool descriptions (`composeActiveTools`). Lowercase fallbacks ('my human', 'the Familiar') are intentional for mid-sentence inline prose.
├── entity-ref.js            Validate phylactery:self/file.md#section refs; accepts legacy entity-core: prefix as alias
├── package.json
├── .gitignore
│
├── logs/                    Session JSON files (auto-created, git-ignored)
├── tomes/                   Per-Tome JSON files (auto-created, git-ignored on UUID names)
│
├── phylactery/              In-tree Python module (Phylactery — canonical self-store)
│   ├── pyproject.toml       uv-managed Python project, deps locked in uv.lock
│   ├── src/phylactery/server.py  FastMCP server (identity / memory / graph / snapshots / lifecycle / backup)
│   ├── src/phylactery/identity.py + memory.py + graph.py + consolidate.py
│   ├── src/phylactery/graduation.py  Pillar H — signed-off graduation-eligibility rule + Familiar-led audit
│   ├── src/phylactery/scheduler.py   Pillar H — volume-gated lifecycle worker (off-switch PROTO_FAMILIAR_CONSOLIDATE_DISABLED)
│   ├── src/phylactery/backup.py      Pillar H — passphrase-encrypted single-file export/restore
│   ├── src/phylactery/remember.py    Pillar I — ward remember-consent map (per-category true/false/ask policy)
│   ├── src/phylactery/snapshot.py + audience.py + embed.py + db.py
│   ├── data/                SQLite database + snapshots + backups + remember_map.json (auto-created, git-ignored)
│   └── tests/               pytest contract tests (test_graduation.py + test_retrieval_decay.py)
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
│   ├── graph-map.js         Shared force-directed graph-map engine (createGraphMap) — behind
│   │                        BOTH the Phylactery knowledge graph and the Unruh schedule map
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

**Memorization:** `POST /api/memorize` (session scope is day-anchored) +
`GET /api/memorize` + ack/cancel — see `memorization.js`.
**Coverage (day-anchoring Phase 3):** `GET /api/memory-coverage` (per-date
status for the calendar) + `POST /api/memorize-day {date,force}` ((re)feed a
day's slices) — see `memory-coverage.js`.
**Import (day-anchoring Phase 4):** `POST /api/import-logs` — without `commit`
PREVIEWS (parse + segment, no writes); with `commit` places foreign logs by date
(one imported session per date) and enqueues them for immediate ingestion. Parsers
in `log-import.js` (Proto-Familiar JSON, timestamped text; rejects unknown loudly).

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
- `POST /api/temporal/schedule/edge` — connect two nodes into the consequence graph (`{src, dst, kind}`)
- `DELETE /api/temporal/schedule/edge/:id` — remove one consequence link (both endpoint nodes survive)
- `GET /api/temporal/phases` — **date-independent** routine surface
- `GET /api/temporal/handoff` + `POST .../handoff/:id/consume`
- `GET /api/temporal/reminders/health` — observability on the loop
- `GET /api/temporal/ponderings[?limit&sinceDays]` + DELETE
- `POST /api/ponderings/intents/acted-on` — mark a deferred intent as filed (body: `{ uid, index }`); called by the `acknowledge_deferred_intent` LLM tool

**Village surface (V1 — registry only; gating lands in V3):**
- `GET /api/village` — full registry (categories + villagers + locations, normalized)
- `POST /api/village/categories` + `PATCH /api/village/categories/:id` + `DELETE /api/village/categories/:id?reassignTo=` — built-ins not deletable; Strangers locked
- `POST /api/village/villagers` + `PATCH /api/village/villagers/:id` + `DELETE /api/village/villagers/:id` — saving a villager auto-dismisses knocks matching their aliases
- `POST|PATCH|DELETE /api/village/locations` — keyed by body `key` (location keys contain `:`)
- `GET /api/village/knocks` + `DELETE /api/village/knocks/:platform/:id` — pending contact attempts from unregistered people (captured by the Discord gateway; identity metadata only, never message content)
- `GET /api/discord/status` — gateway connection state, bot identity, turn/failure counters, a `fatal` flag (token/intents rejected — the UI shows red instead of a perpetual "reconnecting"), plus `webSocketSupported`/`nodeVersion` so the Settings UI can warn proactively when the runtime is too old (Node < 22) to open the gateway
- `POST /api/discord/apply` — apply the saved Discord settings and (re)connect immediately (the Settings "Apply & connect" button), clearing any fatal state; returns the resulting status. Saves the ward waiting for the 30s supervisor tick or reloading the page

**Web search (the Settings "Configure search backend" modal):**
- `POST /api/guide-chat` — the in-modal Familiar explainer (0.7.29): same entity, stripped context (identity + the four prompt fields + tools-info/no-jargon), non-streaming, no tools, not persisted. Degrades calmly. Off-switch `PROTO_FAMILIAR_GUIDE_CHAT_DISABLED=1`

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
- `startVillageSync()` — village registry boot reconciliation + default-category seeding
- `startDiscordGateway()` — supervisor idles until Settings carry a bot
  token + the toggle; follows Settings changes within 30s; hard
  off-switch `PROTO_FAMILIAR_DISCORD_DISABLED=1`

Each loop has a `stop*()` function called from the SIGTERM /
SIGINT / SIGHUP handler so clean shutdown awaits any in-flight tick.

### `thalamus.js` — the cognitive-module mediator

Spawns and reconnects **Phylactery** (Python via uv, `./phylactery/`) + **Unruh**
(Python via uv) as stdio MCP children. Phylactery is the canonical self-store
(identity + memory + graph + trackers); entity-core (Deno) is retired as of Pillar I.
Exposes:

- **`enrich(userMessage, { liveTurn, staticOnly, lastUserMessageAt, audience })`**
  — the central per-request call. Fans out to identity + memory + graph
  (Phylactery) + temporal_context (Unruh) + local-disk reads (recent
  ponderings, threat state). Returns `{ static, dynamic }`. The
  `audience` option (Village V3) is the resolved grant object from
  `audience.js`; when present, ungranted knowledge classes are never
  fetched (gate-before-fetch) and ward-private blocks (ponderings,
  deferred intents, care check, surface candidates) are skipped
  entirely. Absent/null audience = ward-private = full context. See
  [Prompt assembly](#prompt-assembly) below for what goes where.
- **Interest helpers:** `recordInterest`, `bumpInterest`, `demoteStanding`,
  `setStandingInterest`, `listLiveInterests`, `listInterests`.
- **Schedule helpers:** `getScheduleWindow`, `addScheduleNode`,
  `updateScheduleNode`, `resolveScheduleNode`, `deleteScheduleNode`,
  `getDueReminders`, `getRemindersHealth`, `listPhases`.
- **Handoff helpers:** `recordHandoff`, `getHandoff`,
  `markHandoffConsumed`.
- **Phylactery spawn / reconnect:** auto re-spawns when settings
  change the Phylactery connection.
- **Standing-value bridge (M7):** on every liveTurn, reconciles
  standing values whose `value_ref` points at a now-gone Phylactery
  identity fact (demotes them to live interests).

### `cerebellum.js` — the motor module (outbound counterpart to Thalamus)

Thalamus owns everything flowing inward; cerebellum owns everything
flowing outward — the Familiar's actions and deliveries. The boundary
is strict: Thalamus assembles context and never executes actions;
cerebellum executes actions and never assembles prompt context.
Cerebellum never opens its own MCP connections — every write to
identity / memory / temporal state goes through thalamus.js's exported
wrappers (the single enforcement point for "writes go through
Phylactery's MCP").

Currently owns:

- **Tool dispatch** — `BUILTIN_TOOLS` (the full registry of tool
  definitions, first-person descriptions authored with `{{user}}`/`{{char}}`
  macros — raw source form; substitution happens at send time) +
  `TOOL_EXECUTORS` (server-side implementations; writes ride
  thalamus's wrappers) + `executeToolCall()` (never throws — failures
  become structured strings into the loop; applies `substituteMacros` from
  `macros.js` to every tool return value at the result boundary, so all
  executors are covered even if they forget substitution individually) +
  `composeActiveTools(customTools, settings)` (built-ins + the user's
  advertise-only custom tools; deep-clone walks every `description` string
  through `substituteToolMacros` → `macros.js` before the tool list is sent
  to the provider; optional `settings` param defaults to `readSettingsSync()`)
  + `runToolCallLoop()` (the non-streaming multi-round loop; the
  streaming variant lives in /api/chat because it is SSE transport).
  `initCerebellumTools()` receives the tome-storage capability, **the
  Village read/upsert functions, and `relayToDiscord`** from server.js at
  boot so `save_to_tome`, `village_lookup` / `village_upsert`, and
  `relay_message` work without cerebellum ever importing server.js (the
  last would be a cycle — discord-gateway imports settings helpers from
  cerebellum).
- **Village tools (0.6.x)** — `village_lookup` / `village_upsert` let the
  Familiar see and edit the Village and link villagers to graph nodes
  (`graphNodeId`). Gated via `ctx.wardPrivate` (threaded into `toolCtx`
  from the session audience tag in /api/chat): `privateNotes` disclosed
  and mutations allowed only on ward-private turns; lookups still surface
  the person and ordinary notes when others are present, with the
  sensitive bucket stripped. Mutations: editing an existing record or
  writing `privateNotes` is ward-private only and deferred for consent
  otherwise; *creating* a just-met person is allowed even with others
  present. See docs/village-support-design.md ("Field-level gating —
  privateNotes").
- **Own-file tools (0.6.x)** — `list_files` / `read_file` give the
  Familiar sandboxed read-only access to its own checkout (tomes, logs,
  docs) so it can look things up on purpose. Sandbox + secret denylist
  in `own-files.js`; ward-private only (file contents are shared
  history, not for gated rooms).
- **`relay_message` (Village V6, 0.6.15-alpha)** — carries a message from
  the ward to a villager (DM) or a Discord location. Resolves the target
  against the registry, runs the composed text through the
  restricted-memory gate at the *target's* audience tag (`searchRestricted`
  dep, defaults to `searchMemoryRestricted`; fails open), delivers via
  `relayToDiscord` (injected dep), and mirrors every relay to the ward's
  outbox (`mirrorToWard` dep, defaults to `enqueueAndDispatch`) — no covert
  contact. The gate/mirror/delivery deps are injectable so tests run
  without spawning MCP children or touching the real outbox. Both target
  kinds are made enumerable to the Familiar by `village_lookup`, which
  (V8) reports a **Places** roster + per-villager Discord-reachability so
  the Familiar can always name a valid relay target.
- **Web tools (opt-in, 0.7.0-alpha; `look_up`/`web_search` split 0.7.19-alpha)** —
  `look_up` / `web_search` / `read_webpage`, thin executors that delegate
  to `websearch.js` (SSRF guard, timeout,
  `linkedom`→`@mozilla/readability`→`turndown` extraction with provenance
  stamping). `look_up` answers definitions/facts/overviews from keyless
  official reference APIs (Wikipedia + DDG Instant Answer), no scraping;
  `web_search` finds pages. Unlike every other built-in they are
  **conditionally advertised**: `composeActiveTools` filters them out via
  `webSearchEnabled(settings)` unless the human has enabled web access
  (and `PROTO_FAMILIAR_WEBSEARCH_DISABLED=1` forces them off). A page the
  Familiar reads persists in session history for the rest of the session;
  to carry it across sessions the Familiar keeps the gist via the existing
  `save_to_tome` (the read return is provenance-stamped so the source
  rides along). See docs/websearch-setup.md and docs/websearch-build-spec.md.
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

**`reachout-loop.js`** + **`reachout.js`** — autonomous singleton, the
companionship counterpart to silence-triage. Every 10min, `runOneReachoutTick`
applies cheap code gates *before* any LLM call: crisis-defer (threat at
moderate+ → stand down, triage owns the moment), quiet hours
(`warmthQuietHoursStart/End`, default 23–08 local), and a cool-down
(`nextCheckInMs`, clamped to [15min, 24h], default ~2h). The decision
(`decideReachoutViaLLM`) reuses `enrich(staticOnly)` + recent session
messages for continuity, and is given the pending `tell` intents
(`getUnactedIntents`, filtered to kind `tell`) and the warm-villager list
(`getWarmVillagers`: `relationToFamiliar==='warm'` AND Discord-reachable —
the dormant tag's first real use). On `reach_out` it routes to either a
ward banner (outbox `kind:'reachout'`, dedup-bucketed; marks the `tell`
acted-on if one was cited) or a warm-villager DM (`relayToDiscord`, always
mirrored to the ward — no covert contact). The prompt is warm-framed, not
crisis-framed, and follows the proactivity rules (both costs named at equal
weight; no bias-toward-quiet). This loop never gates a *safety* action —
it's purely additive warmth. Off: Settings "Warm reach-outs" or
`PROTO_FAMILIAR_WARMTH_DISABLED=1`.

**`outbox.js`** — `tomes/.outbox.json` persistent queue. `enqueueOutbox`
dedups on `(kind, originId)` while unacknowledged. `listOutbox`
newest-first. `acknowledgeOutbox` / `clearAcknowledged`. `updateOutboxMeta`
for the triage loop's pending-contact deferral.

**`last-activity.js`** — single timestamp in `tomes/.last-activity.json`
stamped from the chat path; consumed by the silence-triage loop.
Discord ward messages stamp it too — the Familiar's sense of "my human
was just here" follows the human, not a particular window.

**`discord-gateway.js`** — autonomous singleton (Village V4). A
supervisor tick (30s) compares Settings (`discordEnabled`,
`discordBotToken`) against the live connection and starts / stops /
restarts to match — no server restart needed. The gateway itself is a
native-WebSocket client (Node ≥ 22) implementing identify / heartbeat /
resume / backoff. Fatal states park it until Settings change (cleared on
token change or via `applyDiscordSettings()`): WS-level fatal close codes
(missing privileged intents) **and** a `401`/`403` on the REST `/gateway/bot`
handshake (rejected/reset token) — the latter sets `fatal` instead of
looping silently, so the UI surfaces "token rejected" rather than a green
light over an endless retry. Inbound `MESSAGE_CREATE` flows
through `classifyMessage()` (pure, tested): ward DM → ward-private
turn; registered-villager DM → gated turn; guild → governed by the
location's **presence mode** (Village V8): `strict` (default — reply
only when @-mentioned or replied-to), `lurk` (read the room, reply only
when addressed), or `active` (may chime in unprompted). The location
ceiling is ALWAYS in the audience (unassigned room = Strangers). Each
location is a session in `logs/` (rotated after 6h idle; map in
`tomes/.discord-map.json`), participants accumulate, and the audience is
re-resolved per turn from the accumulated list. Ward messages also run
crisis-signal scoring + threat recording (`source: 'discord'`) on the
reply path. Discord turns carry NO tools and never consume handoffs
(`liveTurn: false`). Memorization of Discord sessions is deferred until
memories carry audience tags (see village-support-design.md).
Off-switch: `PROTO_FAMILIAR_DISCORD_DISABLED=1`. Observability:
`GET /api/discord/status`.

*Presence modes (V8).* Messages the Familiar isn't addressed in resolve
to `action: 'observe'` (lurk, and active turns it sits out): the message
is appended to the session for context, nothing is sent, no LLM call —
and deliberately **threat-neutral** (observing never moves the ward's
activity clock or threat tier; that stays on the reply path, out of the
safety-critical surface). Active-mode pacing is `decideAmbientReply()`
(pure, tested) over a volatile in-memory `ambientState` (per-location
`lastTurnAt` + recent message timestamps): a hard `activeCooldownSec`
floor on unprompted turns plus one of two ward-toggleable strategies —
`llm` (model decides each time; abstains via a bare `[pass]`, detected
by `isAmbientAbstain`) or `tiers` (pure-code slow/medium/fast cadence
scaled off the cooldown). The V3 knowledge gate runs identically in
every mode — mode is *when* the Familiar speaks, never *what it knows*.

*Active-mode reply batching (V8.x).* An unprompted turn no longer replies
once per message — a burst coalesces into ONE reply to the whole block,
the way a person catches up on a few lines at once. The first reply-worthy
ambient message arms a per-location settle timer (`scheduleAmbientBatch`)
instead of replying; later messages in the burst fold into the session log
via the existing `observeMessage` path (so they land in history) and reset
the timer; when the room goes quiet the single held trigger runs through
`handleTurn`, which already reads the whole log. The settle window adapts to
room pace — `adaptiveSettleMs()` (pure, tested) waits ~1.5× the typical
recent inter-message gap, clamped to [2s, 12s], with a 25s hard age ceiling
so a never-quiet room still gets answered; `markAmbientTurn` (the cooldown)
fires when the batch does. **Only ambient turns batch** — a direct @-mention
replies immediately and `cancelAmbientBatch` folds any pending burst into
history so it isn't answered twice. Off-switch:
`PROTO_FAMILIAR_DISCORD_BATCH_DISABLED=1` reverts to per-message replies.

*Room legibility (V8).* `resolveMentions()` (pure, tested) rewrites
inbound `<@id>` / `<@!id>` tokens to `@Name` (my own char name → a
registered villager's name → the payload display name → `@someone`)
before the text reaches the model, in both the reply and observe paths —
raw snowflakes leave the Familiar unable to tell who a message names. On
an ambient turn `directedAtOthers()` (pure, tested) collects the names a
message was explicitly aimed at (other-user @-mentions + a reply target,
excluding me) and feeds them to the presence block, so an active-mode
Familiar can distinguish "this exchange is between them" from open-room
chatter and weigh both costs (barging in vs. a missed moment of
presence) instead of treating every unaddressed line as its cue.

But the *triggering* line of an exchange is often the only one that's
tagged — "@Nichtschwert, you and I?" is, but Nichtschwert's untagged
"sure, what's up?" that follows is not, even though it plainly continues
their two-person thread. `directedAtOthers()` alone would read that
follow-up as open-room and the Familiar would barge in. So every stored
message (spoken and observed) records structured per-message signals —
`speaker`, `targets` (others it named), `namedMe` (whether it pulled me
in) — and on an ambient turn whose own line names no one,
`carriedExchange()` (pure, tested) walks the recent history for the most
recent message that named only others (and didn't pull me in): its
speaker + named parties are a live exchange, and if the person speaking
now is one of them, this line continues *their* thread, not an opening
for me. It reads only the structured fields — no parsing of display text
— so it stays reliable code, not a guess about tone. A line that names
me cancels the carry-forward (the room turned toward me). The open-room
presence branch is correspondingly worded to make the model *read* for an
untagged exchange between others rather than treating any unaddressed
line as its cue — absence of a tag on one line is not proof the room is
open.

*Other bots & Familiars (V8).* My own messages are ALWAYS ignored (the
inner loop guard, above the opt-in). *Other* bots — including other
Familiars — are ignored by default (`reason: 'bot-author'`); a location
with `readBots: true` lets them through `classifyMessage` as normal, so
they're answered when addressed and paced by the room's mode +
`activeCooldownSec` + rate limit otherwise. For shared Familiar
channels; the loop is the ward's to pace, not a hard block.

*Deferred presence (V9).* Ambient turns now have a third option beyond
speak / `[pass]`: `[later:…]` schedules a revisit. Three syntax forms —
relative (`[later:15m]`), wall-clock (`[later:22:30]`), and named
buckets (`[later:soon]` ~15min / `[later:later]` ~45min /
`[later:much-later]` ~1h). Clamped to [5min, 1h]; may re-defer up to
2× total. Persisted in `tomes/.discord-revisits.json`. A self-arming
timer (`armRevisitTimer`) fires the soonest-due entry and re-arms; it
is armed on every `READY` (so the bot token is present before a timer
could fire, and a disable→enable cycle re-arms) and cleared in
`teardown`. Any real incoming message at a location supersedes its
pending revisit (`cancelRevisitsForLocation`). Revisit turns are
threat-neutral and never move the ward's activity clock.

A revisit speaks into a *shared* room, so `fireRevisit` runs the exact
same safety spine as a live turn: it resolves the knowledge gate from
the room + accumulated participants (`resolveLocationGate` →
`resolveAudience`/`audienceTagFor`, never ward-private context in a
guild), and delivers through `deliverReply` — the shared Pillar D
outgoing-filter → send → persist → rate-slot → status path that
`handleTurn` also uses. The two paths share one delivery function so
neither can drift from the other or skip a gate the other applies.

Session history now renders `[HH:MM]` timestamps (server local time)
before each speaker prefix, so the model can read exchange rhythm and
gaps directly. `carriedExchange` gains a `maxAgeMs` staleness gate
(default 1h) so exchanges older than that are not carried forward as
live threads.

### `memorization.js` — autonomous per-fact memorization (Pillar C)

Persistent queue at `tomes/.memorization-queue.json`, 5-second tick,
exponential backoff, idempotent enqueue on
`sessionId+scope+topicId+messageRange`.

**Extraction** uses a per-fact format: LLM returns
`{facts: [{content, category, subjects, confidence}], relations: [{from, fromType, type, to, toType}]}`
where `category` ∈ `basics | emotional_content | health_info | relationships | whereabouts`.
Facts with `confidence < 0.4` are silently skipped.

**Shared graph rubric (`graph-vocab.js`, 0.7.63).** What earns a node/edge is defined
**once** and read by every surface that creates one: the entity-type vocabulary
(`person, place, organisation, pet, condition, project, thing`), the **no-abstractions**
rule (the single biggest driver of graph quality — keeps "stress"/"work-life balance"
from becoming nodes), and the edge rule (both endpoints concrete, never invented,
snake_case type). Both memorization prompts (`buildPrompt` / `buildSharedRoomPrompt`)
and the chat-path tools (`create_graph_node` / `create_graph_edge`) interpolate the same
constants, so a node made mid-chat is held to the same standard as one made during
memorization — closing a drift where the vocabulary differed across three surfaces and
the chat tools lacked the no-abstractions rule. The Python `graph_relate` /
`graph_node_create` docstrings carry the same list by hand (sync comment in both).

**Tiering — standalone `daily` facts (0.8.2):** extracted facts land at the
`daily` tier (the doc's baseline for conversation-derived memory), written with
`standalone: true` so each keeps **its own row** carrying its `category` /
`subjects` / `consent_pending` / `confidence` — instead of being mis-filed as
`significant`. In `memory.create` there are now three storage shapes:
`significant` (own row keyed `date_slug`, a rare deliberate milestone),
`standalone` (own row keyed by the **plain date** so consolidation's range
filter still rolls it up; a `slug` marks it so the journal bucket never absorbs
it), and the date-bucketed journal (`daily`/`weekly`/… with `slug` NULL, content
appended as bullets). Reserving `significant` for true milestones means these
facts now **consolidate** (`daily→weekly→…`), **decay**, and are caught by
exact-dup hygiene (which groups by `granularity,date_key,content` — significant's
unique `date_slug` had escaped it). After a weekly rollup, the consolidated daily
sources are **pruned** (snapshot first, recoverable) so the tier doesn't pile up;
`consent_pending` dailies are excluded from both the summary and the prune, so an
unreviewed fact is never baked into a permanent weekly note before the ward
approves it.

**Day-anchored fact dates + by-id addressing (0.7.61).** Because many standalone
facts share one plain `date_key`, that key **cannot** address a single fact —
`read_memory(granularity, date)` returns whichever row comes first. Two fixes:
- **The date now rides through.** `processJob` passes the day-scoped job's
  `topicId` (the segment's calendar date) as `createMemoryFull({ date })`, so a
  slice from an older conversation files under **its** day, not today. Without this
  every imported fact landed in today's bucket (the "159-into-today" bug).
- **By-id is the unique handle.** `memory.py` gained `read_memory_by_id`,
  `update_memory_by_id`, `delete_memory_by_id`, and `move_memory_date` (re-files a
  mis-dated fact — only the day moves; significant rows rebuild their `date_slug`).
  Exposed as MCP tools (`memory_read_by_id`, `memory_move_date`,
  `memory_update_by_id`, `memory_delete_by_id`), thalamus wrappers, the Familiar's
  `read_memory_by_id` / `move_memory_date` / `update_memory_by_id` /
  `delete_memory_by_id` tools (ids ride in on `recall` / `list_memories`), and the
  HTTP `/api/entity/memories/by-id/:id` surface (GET/PUT/DELETE + `…/move`). The
  Knowledge-editor memory panel now opens, edits, moves, and deletes by id — fixing
  the bug where every row opened the same entry.
- **The mass-overwrite guard (0.7.64, audit finding).** `granularity+date_key` is
  unique ONLY for the journal bucket (`slug NULL`) and significant rows (slug baked
  into the composite key) — **not** for standalone per-fact rows that share a plain
  date. So the by-date `update_memory` / `delete_memory` now scope to `slug IS NULL`
  when no slug is given: a no-slug update was previously an **un-scoped** `UPDATE …
  WHERE granularity=? AND date_key=?` that would rewrite **every** standalone fact
  on that date with the same content. By-date now only ever touches the journal
  bucket; per-fact rows are by-id only, and the Familiar's `update_memory` /
  `delete_memory` descriptions steer it to the `_by_id` variants for a single fact.

> **Tiering is one of two axes; don't conflate them.** `granularity`
> (`daily…significant`) is the rollup tier this section touches. A memory record
> *also* has a **`register`** field — `episodic | me | ward` — which is a
> **separate axis** (`phylactery-design.md:272`). The memorization pipeline only
> produces **`episodic`** facts; the `me`/`ward` registers hold *standing truths*
> about the Familiar (`me`) or the human (`ward`). They are reached two ways:
> autonomously by *graduation* (Pillar H moves identity-file detail off the
> always-injected surface, created at `significant`), and **deliberately by the
> Familiar** via `save_memory`'s `register` choice (0.8.6 — a me/ward write is
> filed as a standalone `significant` fact on that register; the lighter sibling
> of `update_identity`). `me`/`ward` are **not** `granularity` values.
>
> **Legibility (0.8.6 / 0.7.48):** `memory.search`, `memory.list_memories`, and
> `memory.read_memory` all carry each record's `register`. Thalamus tags
> `me`/`ward` recalls (`a standing fact about my human · …`) so the *Familiar* can
> weight an identity-grade fact differently from a passing episodic moment, and
> the *Knowledge editor* badges them (`standing · self`/`ward`) in the memory
> browse list + detail so the **human** can see them too. Without this the
> register was invisible on both surfaces.

**Semantic dedup-merge (0.8.0):** `memory.create` (Phylactery) runs a KNN
similarity check before inserting a significant / standalone / consent-pending
memory. A near-identical paraphrase (sim ≥ 0.85) folds into the existing entry
(bumps `updated_at`, no new row); an additive near-dup (sim ≥ 0.78) appends the
new detail. A per-fact row only dedups against other per-fact rows
(`slug IS NOT NULL`), never into a journal bucket. Consent-safe: an unconsented
detail is never folded into an already-confirmed memory (it gets its own row).
The merge marker rides back through `memory_create` → `thalamus.createMemoryFull`
→ `memorization.js`, which skips re-queuing a merged dup for consent. This is
what stopped the "82 queued, only 5 new" duplicate pile-up.

**Auto-graph (0.8.1):** the same extraction call also returns `relations` —
concrete edges between named entities (person/place/organisation/pet/condition/
thing; never abstractions). `parseRelations` normalises and within-job-dedups
them (never throws — enrichment, not load-bearing), then `processJob` routes each
via `thalamus.graphRelate` → Phylactery `graph_relate` (`graph.relate`), which
resolve-or-creates both endpoints by case-insensitive label and dedups the edge
by `from/to/lower(type)`. Fire-and-forget per edge (Promise.allSettled), gated on
`created > 0` so a fully gate-dropped session doesn't quietly rebuild the graph.
This rides the existing memorization LLM call (no new request) and fixes the
"Familiar almost never saves to the graph unless prompted" gap.

**Graph-node audience derivation (Pillar E, 0.7.x).** Each endpoint's audience is
derived **in code** before routing: `audience.deriveNodeAudience({ label,
registry })` matches the label to a known villager (by name/handle) and takes that
villager's representative Village category, else **`ward-private`** (fail-closed —
places, orgs, the ward, abstractions stay private until deliberately widened). The
edge takes the **narrower** of its two endpoints (`mostRestrictiveAudience`) so it
can't reveal a ward-private node in a wider room. These ride into `graph_relate`'s
`fromAudience`/`toAudience`/`edgeAudience` (and the Familiar's `create_graph_node`
derives the same way). Audience tags only **new** nodes — `resolve_or_create_node`
never re-tags an existing node, so a deliberate override isn't clobbered by ongoing
memorization. The deliberate-override surface is `graph_node_update`'s `audience`
(Familiar tool `update_graph_node`, or the Knowledge-editor node popover's audience
dropdown) — how the ward/Familiar widens a node to a circle or keeps it to just the
two of them. Graph gating is the structural `audience` column + the Phase-1 recall
filter; the `<!-- gate: -->` comments are an **identity-file** mechanism only and
were never used in graph descriptions.

**`remember` gate** (per villager, per category):
- `true` → store freely in Phylactery
- `false` → drop silently
- `ask` (or no `remember` map on the villager) → store immediately with
  `consent_pending=1` and record the ID in `tomes/.consent-pending.json`

When multiple villagers are subjects of a fact, the most restrictive
gate wins (`false > ask > true`). Default when no villager map exists:
`basics=true`, all others=`ask`.

**Standing mutual consent (0.8.3):** a villager record can carry
`standingConsent: { wardAgreed, villagerAgreed }`. When **both** are true
(`village.standingConsentActive`), `resolveRememberGate` clears that villager's
`ask` to `true` — no more per-fact consent prompts about them — but an explicit
`false` category still hard-blocks (a convenience toggle never overrides the
ward's veto). Set two ways: the Village-UI consent checkboxes, or the Familiar's
`village_upsert` tool (`mutualConsentToRemember`, ward-private only).

**Write-time audience derivation (Pillar C → Pillar E, 0.7.x).** Each per-fact row
is now stamped with the audience tag that gates its later recall — derived **in
code** by `audience.deriveMemoryAudience({ category, subjects, sessionTag,
registry })`, never asked of the extractor (a tag the LLM could forget is a tag
that could leak). The rule is **session-bounded by default, widen/tighten by
explicit consent**: with no per-subject preference a fact is capped at the room it
was made in (`audienceTag`), and a sensitive category (`health_info`,
`emotional_content`) is floored to `ward-private`. A subject villager may carry a
`disclosure` map (per remember-category → a Village category id, or
`ward-private`); an explicit entry **overrides** the default in either direction —
widening a ward-private fact out to a named circle, or tightening past the session
ceiling — and even overrides the sensitivity floor, because that is the data
subject's own stated consent. With multiple subjects the **narrowest** circle wins
(everyone named must be comfortable with the room). The ward sets `disclosure` in
the Village UI (a per-category dropdown beside the consent toggles); the Familiar
sets it in first person via `village_upsert`'s `disclosure` argument (circle names
resolved to ids, ward-private only for edits). The derived tag rides into
`createMemoryFull({ audience })`, where it becomes the `audience` column the Pillar
E recall gate filters on.

**Consent flow:** `thalamus.enrich()` reads `.consent-pending.json` cheaply
(no MCP round-trip) and injects a `[PENDING MEMORY CONSENT]` block when
non-empty. The Familiar calls `memory_confirm_consent(ids)` or
`memory_drop_pending(ids)` (both in `BUILTIN_TOOLS`); `pruneConsentPending(ids)`
then removes the handled IDs from the local file.

**Day-anchored coverage (Phase 1 of the day-anchoring keystone, 0.7.x).** Session
memorization is now tracked per **local calendar date**, not per session.
`day-segments.js` `segmentByDay(messages)` derives per-date slices from a session
log (Hybrid model — the live log stays one intact file; segmentation is logical,
at memorize time; a midnight-crossing session becomes two slices). `memorization
.enqueueSessionByDay()` enqueues one job per date-slice (`scope:'day'`,
`topicId:<date>`, `messageRange`), skipping slices the **coverage ledger** already
marks memorized. On completion `processJob` calls `memory-coverage
.recordSegmentRun()` (a day slice with zero kept facts is still *done* — it's
recorded, not retried; shared-room slices get a `'shared-room'` flag). The ledger
(`tomes/.memory-coverage.json`) stores only what's been memorized per
(date, session); `computeCoverage()` reads the logs live and derives per-date
status (`complete | partial | uncertain | empty`) by comparing the two — so the
active day reads `partial` the moment new messages land. Dates use server-local
time, stamped in the ledger. **Phase 3 (calendar UI):** the Knowledge editor's
**Coverage** tab renders a month calendar coloured by status (`computeCoverage()`
via `GET /api/memory-coverage`); clicking a day lists its sessions and offers
"Memorize this day" (`POST /api/memorize-day`, `collectDateSlices` → per-slice
enqueue, `force` to re-run done days). **Phase 2 (always-on sweep):**
`memory-sweep-loop.js` — a 10-min pass that enqueues the missing slices of every
*past* incomplete day (skips today, handled live; skips completed days). Only
enqueues into the memorization worker (no LLM call of its own); default-ON,
Settings "Memory coverage sweep" / `PROTO_FAMILIAR_MEMORY_SWEEP_DISABLED=1`.
**Phase 4 (foreign-log import):** `POST /api/import-logs` (preview → commit) +
`log-import.js` parsers place foreign logs by date (one imported session per
date) and enqueue them for immediate ingestion (confirm-gated in the Coverage-tab
import form). Parsers: Proto-Familiar JSON, SillyTavern `.jsonl` (`is_user`→role, ISO
`send_date`), OpenClaw `.jsonl` (event stream — `type:'message'` events, content
blocks), timestamped text. Undated logs are dated by an explicit `fallbackDate`
or one read from the filename (`dateFromFilename`); if neither exists the preview
asks for a date. *(see `docs/day-anchoring-build-spec.md`.)*

**Triggers** (all session-scope triggers route through `enqueueSessionByDay`;
topic-scope stays whole-range):
- Web: client calls `POST /api/memorize` on session end (fetch or sendBeacon),
  and the sidebar "Memorize now" button (`memorize-now-btn`) for on-demand.
  Always `audienceTag: 'ward-private'`.
- Discord: `discord-gateway.sessionForLocation()` enqueues the old session
  when idle rotation fires (session has been quiet ≥ `SESSION_IDLE_ROTATE_MS`).
  `audienceTag` comes from the stored session log.
- **Familiar self-trigger (0.8.4):** the `memorize_now` tool. When the Familiar
  judges the conversation holds things it must carry across instances — and a
  clean rollover may never happen (the human switches sessions / clears history)
  — it commits the session itself. The executor reads the session id from the
  tool context (`sessionInfo.sessionId`) and delegates to `memorizeSessionNow`
  (server.js, injected via `initCerebellumTools` to avoid the cerebellum↔
  memorization import cycle), which reads the clean on-disk log and enqueues the
  same pipeline. No new request beyond the chat turn it rides; degrades to a calm
  first-person line, never throws into the tool loop. (Single deliberate facts
  still go through `save_memory`; this commits the whole exchange.)

**Off-switch:** `PROTO_FAMILIAR_MEMORIZE_DISABLED=1` (the worker; `memorize_now`
just enqueues, so it honours the same switch — a disabled worker won't drain).

### Migration: entity-core → Phylactery (Pillar F)

One-time, snapshot-first, idempotent conversion run via:

```
npm run import-entity -- --from /path/to/entity-core [--yes]
```

`scripts/import-entity.js` resolves the source data directory (accepts
both an entity-core root with `src/` + `data/`, or a bare data dir with
`self/` / `memories/` / `graph.db`), confirms with the operator, then
invokes the Python migration module:

```
cd phylactery/ && uv run python -m phylactery.migrate_from_entity_core \
    --source <sourceDataDir>
```

`phylactery/src/phylactery/migrate_from_entity_core.py` phases:

- **Phase 0** — Snapshots Phylactery before any writes (recovery baseline via
  `snapshot.auto_snapshot`). Safe to run multiple times: already-migrated records
  (matched by `source_json.originalId`) are skipped.
- **Phase 1a** — Identity `.md` files from `self/`, `user/` (→ `'ward'` category),
  `relationship/`, `custom/` are inserted into `identity_files` with
  `audience='ward-private'`.
- **Phase 1b** — Memory `.md` files from all five tiers (`daily/weekly/monthly/
  yearly/significant/`) are inserted into `memories`, date-key preserved, with
  `audience='ward-private'`.
- **Phase 1c** — `graph.db` nodes and edges are inserted into `graph_nodes` /
  `graph_edges` with `audience='ward-private'`. Schema columns are probed
  gracefully; missing `graph.db` or unrecognised schema is skipped with a warning.
- **Phase 2** — Prints `type='person'` nodes for manual villager-match review.
  No auto-merge of person nodes ↔ villagers.

The `identity_files.category` rename (`'user'` → `'ward'`) is enforced at
migration time (Phase 1a) and by SQL migration `0003_pillar_f_ward_rename.sql`
for any pre-existing rows. After migration, entity-core is not started;
Phylactery is the sole canonical store.

### `outgoing-filter.js` — Pillar D outgoing gate

Post-response, pre-send semantic gate for non-ward-private rooms. Runs in the
non-streaming tool-call loop path in `server.js` and in the Discord reply path.
Streaming replies bypass the filter (content is already in-flight as deltas).

**Flow:**
1. If `audienceTag === 'ward-private'`, return immediately — no check needed.
2. Call `memory_search_restricted(query, roomAudience)` via Phylactery, which
   searches for ward-private memories semantically close to the draft text.
3. If similarity score ≥ `FILTER_THRESHOLD` (0.70), send a rejection nudge
   (second-person prompt per build-spec §3 — the one sanctioned exception to
   the first-person convention) and retry `callUpstream`.
4. After `FILTER_RETRY_BUDGET` (3) retries without a clean draft, emit
   `FILTER_SAFE_REFUSAL`: "I can't share that here — something in what I was
   about to say isn't cleared for this room. If you need that information,
   ask me somewhere private."

**Failure mode:** any error in `searchMemoryRestricted` returns `{hit: false}`,
so the filter always fails open — a Phylactery outage never blocks a reply.

**Parameters signed off by the human (build-spec §7):**
threshold=0.70, retry budget=3, safe-refusal text as above.

### Pillar E — audience-gated recall (`audience.js` + Phylactery)

`fetchEligibility` decides *whether* the memory/graph fetch runs for a room;
**the recall gate decides *what comes back*.** **Graph follows the memory grant**
(0.7.66): the graph is relational memory, so `doGraph = doMemory` (a room with
`memories: true | 'shared'` also fetches the graph), and the per-node `audiences`
filter below scopes it node-by-node. This replaced a gate on a `graph` grant that
**no Village category ever granted** — graph enrichment was therefore silently OFF
in *every* non-ward session (memory still worked, so the symptom was "graph stopped
enriching but memory didn't"). The per-node tags now do the real privacy gating, so
the coarse grant was both unsatisfiable and redundant. `audience.js` `visibleAudiences
(roomTag, registry)` computes the SET of audience tags a room may see — every
Village category whose `permissionScore` ≤ the room's, which excludes
`ward-private` (it isn't a category and outscores all) and any
more-trusted-than-the-room category. `server.js`/`discord-gateway.js` compute
this set and pass it into `enrich({ audiences })`, which forwards it to
`memory_search` / `graph_node_search` / `graph_subgraph`. Phylactery's
`audience_in_sql(audiences)` turns it into `audience IN (…)` (None → `1=1` for a
ward room; `[]` → `0=1`); `memory.search`, `graph.search_nodes`, and
`graph.get_subgraph` (all three fetches, incl. the subgraph endpoint backfill)
filter through it. Fail-closed: a record tagged with a deleted/unknown category
is absent from the set → excluded; a registry-read failure leaves
`audiences=null` only on the ward path.

**The leak this closed (0.7.x):** the room tag was never passed, so recall
defaulted to `ward-private` → `1=1` → ward-private memories/graph surfaced in the
Familiar's *context* in trusted shared rooms. (The old `audience_filter_sql` also
kept `ward-private` in the non-ward `IN`-list — a second leak — left for the dedup
path; recall now routes through `audience_in_sql`, which doesn't.) The outgoing
filter (Pillar D) remains the send-side backstop; together they are the two gates
the design intended. See `docs/audience-gating-build-spec.md`.

### Pillar H — lifecycle: consolidation scheduler, hygiene, graduation, backup

**Consolidation scheduler** (`scheduler.py`) — Phylactery's own internal
background worker (daemon thread, 5-min wake cadence, **volume-gated** so an
idle Familiar burns no LLM calls). Each pass runs, independently guarded:
hygiene → tier consolidation → graduation audit. Off-switch
`PROTO_FAMILIAR_CONSOLIDATE_DISABLED=1`; started from `server.py:main()`,
forced on demand via the `lifecycle_pass` tool / `POST /api/entity/lifecycle`.

**Cheap-code hygiene** (`consolidate.run_hygiene`) — pure SQL, folded into the
pass (not a separate loop): dedup exact-duplicate narrative records (keep
oldest), merge graph nodes sharing a non-empty `(label, villagerId)` (re-point
edges, drop losers). Same label with **different** identities is never
auto-merged — it's reported as ambiguous for the ward to resolve. Snapshots
before any change.

**Tier consolidation** (`consolidate.consolidate_to_weekly/monthly/yearly`) — LLM
rolls a period's lower-tier entries into one higher-tier summary (`daily→weekly→
monthly→yearly`). After a successful **weekly** rollup the consolidated daily
sources are pruned (`_prune_consolidated`, snapshot first) so the daily tier
doesn't accumulate. `consent_pending` dailies are held out of both the summary and
the prune — an unreviewed fact is never folded into a permanent rollup before the
ward approves it.

**Recall tracking** (`memory.search` → `_touch_recall`) — pure observability:
bumps `recall_count` + `last_recalled_at` for everything surfaced.

**Retrieval-decay** (`_decay_weight`) — `score = similarity × 0.5^(days_since_recall/180)`.
careWeight:high records floor at 0.5; never-recalled records get weight=1.0. Down-rank only
(never a filter cutoff). Applied before the `max_results` slice so decay can reorder across
similarity bands. Re-sort on every search ensures stale records don't crowd out fresh ones.

**Graduation audit** (`graduation.py`) — keeps the always-injected
`identity`/`ward` surface lean by filing no-longer-front-of-mind detail into
RAG-recalled `me`/`ward` register records. Nothing is deleted; graduated
records can be pulled back. The **eligibility rule is human-signed** and lives
in one pure function, `is_graduation_eligible(record, now)`:

```
candidate  = NOT careWeight:high
             AND on-surface > DWELL_DAYS (30)
             AND last recalled > RECALL_RECENCY_DAYS (30, or never)
             AND last confirmed > CONFIRM_RECENCY_DAYS (30)
NEVER eligible (pinned): careWeight:high
             OR category ∈ {health_info, crisis, support-map}
             OR content matches care-critical patterns (allergies, meds,
                doses, crisis triggers, support contacts, care guidance)
             OR confirmed within the window
```

The bias is toward KEEPING — false positives are cheap, filing away a
safety-relevant fact is not. The actual per-block decision rides the
consolidation LLM call (the Familiar, in its own voice); code only narrows the
candidates and re-screens every graduated item against the care matcher
(defence in depth). `auto_snapshot` runs before any identity trim. Ward-block
graduations land in `graduation_log`; thalamus surfaces unacknowledged ones as
a `[GRADUATION NOTICE]` block (TTL-cached, ward-private turns only,
non-blocking), and the Familiar calls `graduation_acknowledge` once mentioned.
Tested in `phylactery/tests/test_graduation.py`.

**Encrypted backup/restore** (`backup.py`) — "back up / restore my Familiar":
`VACUUM INTO` a consistent copy, encrypt with a key derived from the ward's
passphrase (PBKDF2-HMAC-SHA256 → Fernet/AES), write a single `.phylactery`
file. Restore decrypts, sanity-checks it's a real Phylactery DB, swaps it over
the live DB, and `thalamus.restoreBackup` reconnects the MCP child. The
passphrase is never stored — a lost passphrase means an unrecoverable backup,
which the UI states plainly. Surfaced in the Knowledge editor → Snapshots tab
and via `POST /api/entity/backup/{export,restore}`.

### `public/graph-map.js` — shared graph-map engine

`createGraphMap(config)` is one reusable canvas engine behind **both**
map views — the Phylactery knowledge graph and the Unruh schedule's
consequence graph — because both stores hold genuinely graph-shaped
data. It owns everything generic: the Fruchterman-Reingold force layout,
the dots-and-quadratic-curve rendering, hit-testing (point-to-Bézier),
the deterministic 24-hue palette + legend, the tooltip, and the viewport
(`world = (screen − tx) / zoom`). Interaction is unified through Pointer
events: **wheel** zooms, **one finger / drag** pans, **two-finger pinch**
zooms, and the **＋ / − / Fit** buttons zoom around centre — the
touchpad-friendly path for users who can't scroll-to-zoom.

What stays with each host is the *domain* layer: data fetch, node/edge
shapes, and the editor popover. Hosts normalise their edges to
`{ id, fromId, toId, type, weight? }` before `setData`; the knowledge
graph passes `weight` (edges fade by strength), the schedule passes none
(edges hue by `kind`). This extraction replaced ~520 lines of inline
`keGraph*` code that the schedule map would otherwise have had to
copy-paste (CLAUDE.md — no copy-paste of substantial logic). The engine
emits `onNodeClick` / `onBackgroundClick`; each host wires its own
popover to those.

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
  toggle** (List / Calendar / Map):
  - **List** — the existing linear schedule view with windowed
    look-ahead (default 48h, configurable).
  - **Calendar** — month-grid view, Monday-start, 6×7 cells.
    Clicking a day opens the create form pre-filled to that date.
    Recurring nodes expand server-side so occurrences render on
    their actual dates; phases stay in the Routine tab to avoid
    cluttering daily-recurring rows. Iconography: recurring
    occurrences prefix with ↻, resolved ones strike through.
  - **Map** — the schedule's **consequence graph** on the shared
    force-directed canvas (see *Graph-map engine* below): nodes are
    events/tasks/phases/states (resolved ones faded), edges are the
    `causes`/`requires`/`depends_on`/`blocks`/`during`/`carries_forward`
    links between them, hued by kind. Clicking a node opens a popover
    that lists its links (✕ to remove) and a "+ connect" form
    (target node + kind) — the user-facing half of edge authoring,
    posting to `/api/temporal/schedule/edge`. This is the home of the
    graph Unruh was always shaped to hold; the Familiar authors the
    same edges from its side via the `schedule_link` tool. **The planned
    consequence-over-time model on top of these edges (valence / two
    futures / certainty / window-position learning) is specced in
    [`consequence-graph-build-spec.md`](consequence-graph-build-spec.md).**
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

### Pillar I — Knowledge-manager repoint + new-field surfacing

All `/api/entity/*` HTTP routes now delegate entirely to Phylactery via thalamus.js wrappers
(entity-core is retired). New fields surfaced in the KE:

- **`audience` + `careWeight` on memory records** — shown in the detail view with editable
  dropdowns; `PUT /api/entity/memories/by-id/:id` accepts `audience` and `careWeight`
  and forwards them to `memory_update_by_id` → `memory.py` `update_memory_by_id()`. The
  audience dropdown lists the real Village circles (ward-private + each category, via the
  shared `keAudienceOptionsHTML` helper used by the graph-node editor too) — the same model
  the recall gate filters on, not the old stale `ward-private`/`all` pair.
- **Audience badges** in the memory list rows for non-ward-private records; careWeight badges
  for `high`/`low` entries.
- **Ward · Remember settings** — persistent consent-policy map
  (`basics / emotional_content / health_info / relationships / whereabouts → true/false/ask`).
  Stored in `phylactery/data/remember_map.json`. Surfaced via:
  - Phylactery MCP tools `remember_map_get` / `remember_map_set` (`remember.py`)
  - thalamus.js helpers `getRememberMap()` / `setRememberMap()`
  - HTTP routes `GET /api/entity/ward/remember`, `PUT /api/entity/ward/remember`
  - KE Identity pane: "Remember settings" row always visible under the `ward` category header
  - **Wired into the memorization gate** (`memorization.js`): the Village registry's
    per-villager `remember` map covers facts about *other* people; the ward is not a
    villager, so facts about my human themselves (no matched villager subject) are gated
    by this ward map. Without it, the human's own `health_info`/`emotional_content` facts
    bypassed the gate entirely. The gate decision lives in two pure, tested exports —
    `gateForCategory(category, map)` and `resolveRememberGate(category, subjectVillagers, wardMap)`
    (`remember-gate.test.mjs`). Defaults (human-signed): `basics=true`, all sensitive
    categories `ask` — surfaced for confirmation, never silently dropped. Degrades to those
    defaults if Phylactery is unreachable.
- **Settings field rename**: `entityCoreConnectionId` → `phylacteryConnectionId` (legacy name
  still accepted as fallback in `loadPhylacteryEnv()` and `phylacteryCredsSnapshot()`).
- **Prompt Inspector labels**: "Entity-Core (static/dynamic)" → "Phylactery (static/dynamic)".
- **Deno/entity-core retirement**: `start.sh`, `start.bat`, `Proto-Familiar.command` no longer
  prime `~/.deno/bin` on PATH; comments updated to reflect Phylactery+Unruh as the only MCP children.

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
   ├── identity_get_all     ──►  Phylactery (MCP)         → static block
   ├── memory_search        ──►  Phylactery (MCP)         ┐
   ├── graph_node_search    ──►  Phylactery (MCP)         │
   ├── temporal_context     ──►  Unruh (MCP)              │ dynamic block:
   │     ├── current phase                                │  - RAG memory matches
   │     ├── full routine (live phases, date-independent) │  - graph excerpt
   │     ├── schedule window (events/tasks/reminders)     │  - "Today's rhythm"
   │     ├── interests (standing + live with weights)     │  - schedule sections
   │     └── handoff (session-end note)                   │  - interests
   ├── getRecentPonderings() ──► local tome read          │  - [CARE CHECK]
   └── getThreat()           ──► local file read          ┘  - [Temporal Context]
       │
       │  injection-guard.js is available but NOT applied to Phylactery /
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
7. **`[Surface candidates]`** — open schedule items that survived the hard gates (active snooze, threat tier, routine phase, dedup window), packaged with consequence priors + person-model excerpt so the Familiar can decide in voice whether to mention any. The header is ADHD/executive-dysfunction-aware: explicit GREEN LIGHT states to surface in (free time, momentum, boredom/restlessness, "forgetting something"), explicit RED LIGHT states to hold in (severe/high threat, quiet phase, mid-task), and named access ramps (timebox, single next action, planning-only slot, body-double). See "Surface pipeline" below.

## Time perception (the `relative-time` layer)

Unruh tells the Familiar *when* events happened — but the Familiar perceives time the way humans do: in relative phrases (yesterday, this morning, in 2 hours, last Tuesday) rather than ISO arithmetic. `relative-time.js` is the single helper every consumer of timestamped data uses to render that phrasing, recomputed every turn against `Date.now()` — the same moment used for the `[Now]` block. A memory written yesterday reads as "yesterday" today and "two days ago" tomorrow, without anyone re-writing the memory.

**A relative phrase ALWAYS travels with a date (0.7.x).** Near-term phrasings ("yesterday", "in 3 weeks") were always present, but beyond ~a month `relativeTime`/`relativeDay` used to fall back to a bare absolute date the model had to date-arithmetic itself. They now append a directional interval (`intervalPhrase` → "in N months" / "a year ago"), so a distant memory or appointment reads "Friday, December 25 **(in 7 months)**" / "January 22, 2025 **(a year ago)**" — the absolute date keeps the precision, the parenthetical keeps the perception. One helper change covers every consumer below.

**Future events carry a day count, coarsening with distance (0.7.x).** A relative-only future phrase ("this Sunday", "in 3 weeks") still forces the model to compute *how far away* that is — and LLMs are unreliable at date arithmetic, which is exactly what the **timeblindness alerts** depend on being right. So every future phrasing ≥2 calendar days out now carries a count alongside its human anchor, exact in the near window and coarsening further out so it stays readable:

| Future distance | Renders as |
|---|---|
| 2–6 days | `this Friday at 3pm (in 3 days)` |
| 7–13 days | `next Wednesday at 9am (in 9 days)` |
| 14–21 days | `Thursday, June 25 at 2pm (in 21 days)` |
| 22 days – ~2 months | `Thursday, July 9 at 2pm (in 5 weeks)` |
| beyond ~2 months | `Friday, December 25 at 9am (in 7 months)` |

The **exact-day window runs to 3 weeks** — that's where the timeblindness alerts actually fire and the model must not mis-estimate distance; past it, weeks then months read better than "in 204 days". The day count is `calendarDayDelta` (the same calendar-day measure the rest of the layer uses, so 23:59→00:01 reads as 1 day); the coarser weeks/months tiers reuse `intervalPhrase`/`plainInterval`. The 21-day threshold lives in one place (`futureInterval`). **Past** phrasings are deliberately left natural ("last Monday", "2 weeks ago"): day-count precision is a forward-scheduling need, and a memory recalled as "2 weeks ago" reads better than "14 days ago". `tomorrow`/`yesterday` stay bare — the count is already in the word.

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
   floating     ← !task.when  (no time assigned)
   ageDays      ← from task.when, OR task.created_at when FLOATING
   priorsBlock  ← matched section from docs/consequence-priors.md
   personModel  ← Phylactery custom/what_lapses_cost.md (raw)
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

**`snooze_until`** is an ISO timestamp on the task payload, set when {{user}} explicitly says "not now" and the Familiar calls the `schedule_snooze_task` tool (id + minutes, clamped 1min–1week). `passesHardGates` honours an active snooze across every tier — the human asked — so it blocks before the threat/quiet/dedup checks. The reminder loop remains the firm safety net for anything with a real deadline; the snooze only quiets the opportunistic surface path. Because Unruh's `schedule_update_node` REPLACES the whole payload, the tool reads the current payload from the schedule window and merges the stamp in (preserving `stakes_tier` / `consequence_model`).

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
                               heading, content })   ← via Phylactery MCP
```

**Outcome tagging** is pure-code, runs at chat-turn entry as a fire-and-forget pass over `tomes/.surface-events.json`:

| Schedule signal | Outcome |
|---|---|
| `resolution === 'done'` | `engaged_and_completed` |
| `resolution === 'cancelled'` | `cancelled` |
| `resolution === 'carried_forward'` | `deferred` |
| `resolution === 'fired'` (reminder) | `fired` |
| unresolved + offered > 24h ago + `raised === true` | `unresponded` |
| unresolved + offered > 24h ago + `raised !== true` | `not_raised` |
| unresolved + < 24h | left null, re-checked next turn |

The `unresponded` / `not_raised` split is load-bearing: `unresponded` means the Familiar *actually raised* the task with the ward and nothing came of it (evidence about the ward), while `not_raised` means it was offered to the Familiar as a candidate but never reached the ward at all (evidence about the Familiar's own surfacing — the ward can't respond to what they never saw). Conflating them — the pre-0.6.25 behaviour — let a quiet stretch where the Familiar simply didn't speak get misread as the ward withdrawing. A confirmed resolution always wins over both regardless of `raised`.

Once tagged, an event's `outcome` is immutable — the LLM later reasons about a stable record, not a moving target.

**`raised` tagging** is a separate, earlier tag on the same event: did the Familiar actually *say* something about the task in the turn it was offered? Tagged post-turn by `tagRaisedOutcomes` (pure-code response-text scan, zero LLM calls). It drives the differentiated dedup window (raised → 6h rest; un-raised → back in 90min), decides the aged-out outcome split above, and flows into reflection (the projection carries `raised`, and the reflection prompt is taught that `not_raised` outcomes are about the Familiar's surfacing, never the ward's engagement).

**Prompt stance:** the `[Surface candidates]` header is written for a ward with executive dysfunction — there is no "right moment" that arrives on its own, so the header tunes toward action. It names explicit GREEN LIGHT states the Familiar surfaces in and explicit RED LIGHT states it holds in (vagueness is *not* a reason to stay quiet — the servile-default model needs the inclusion/exclusion conditions spelled out or it collapses to silence), names the cost of silence (the task waits forever; a missed task outweighs a refusable check-in), and offers concrete access ramps (timebox, single next action, planning-only slot, body-double). It deliberately contains no bias-toward-quiet language — see CLAUDE.md's proactivity section; a regression test in `tests/surface-context.test.mjs` guards against its return.

**Floating-task aging (0.7.x).** A floating task (no `when`) used to compute `ageDays` from `task.when` only — so it was always `null` and every floating task read as brand-new forever, with no staleness to prioritise. Now age falls back to `created_at` (which Unruh already serialised), the candidate carries a `floating` flag, and both surfaces show it — the candidate block (`[floating — no time set]` + `Floating for: Nd — still no time assigned`) and the `[Temporal Context]` open-tasks list (`(floating Nd — no time set)`). The prompt gains a dedicated FLOATING TASKS directive: the aged ones earn a gentle "when shall we put this?" in a calm moment, and the Familiar pins the agreed time with the new **`schedule_assign_time(id, when)`** tool (thin wrapper over `updateScheduleNode` → Unruh `schedule_update_node`, which always supported setting `when_ts` — the capability existed end-to-end but had no Familiar-facing surface). Turning a someday into a real `when` is itself counted as progress.

**Addressing schedule nodes by id (0.7.x).** Every schedule editing tool — `schedule_assign_time`, `schedule_snooze_task`, `schedule_resolve`, and `schedule_delete` — is keyed by a node **id**, but the human-readable schedule renders **labels**. Both surfaces that show schedule state now also surface the ids the tools need, so the Familiar can *act on* what it can *see* (the CLAUDE.md operability rule: a tool whose key argument the Familiar can never name is a tool it can never use):
- **`[Temporal Context]`** (`temporal-format.js`) appends a compact `[schedule ids]` legend at the end of the block — mirroring the knowledge-graph id legend — listing `label [type] = id` for both routine phases and the window, deduped, skipping nodes with no id. This is the only path by which a **phase** id reaches the model (phases are otherwise label-only in "Today's rhythm").
- **`[Surface candidates]`** (`surface-context.js`) prints an `id:` line under each candidate, so a floating task surfaced for time-assignment carries its id in the same place the Familiar reads about it.

**`schedule_delete(id)` (0.7.x).** Permanently removes a schedule node — event, task, reminder, or routine **phase** — via `deleteScheduleNode` → Unruh `schedule_delete_node` (which returns `{ok, deleted}`; `deleted:false` means no such id). Distinct from `schedule_resolve`, which marks a node `done`/`cancelled` while *keeping the record*: delete *erases* it, and is the only way to remove a phase or clean up a duplicate/mistaken entry. The plumbing (`deleteScheduleNode` thalamus helper + the Unruh MCP tool) already existed end-to-end; it simply had no Familiar-facing tool until now — the classic "capability not reachable BY the Familiar" gap.

**Storage decision:** event records and reflection metadata live in `tomes/.surface-events.json` (per-embodiment, like ponderings). Identity-layer *insights* derived from them ("Eury crashes within 4h of skipping meals") get lifted to Phylactery's `custom/what_lapses_cost.md` only after the reflection LLM judges the pattern strong enough. The raw event stream belongs to Proto-Familiar; the durable knowledge belongs to the entity.

**`what_lapses_cost.md`** lives in Phylactery's `custom` category as `what_lapses_cost.md`. The Familiar writes via the reflection loop when patterns emerge. May not exist initially; surface-context assembly is null-tolerant.

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
| `GET/PUT/DELETE /api/entity/memories/by-id/:id` + `POST …/move` (server.js) | The unique-handle surface (registered BEFORE `:granularity/:date` so `by-id` isn't swallowed as a granularity). The only way to address one of many standalone facts that share a date; `…/move` re-files a mis-dated fact. |
| `thalamus.readMemory` / `updateMemory` / `deleteMemory` | Pass `slug` through to entity-core's tools. `updateMemory` without the slug is the shadow-file hazard. |
| `thalamus.readMemoryById` / `updateMemoryById` / `deleteMemoryById` / `moveMemoryDate` | By-id wrappers over the `memory_*_by_id` / `memory_move_date` MCP tools. |
| `update_memory` / `delete_memory` executors (cerebellum.js) | Split the model-supplied key; their tool descriptions teach the `YYYY-MM-DD_slug` addressing. |
| `read_memory_by_id` / `move_memory_date` / `update_memory_by_id` / `delete_memory_by_id` executors (cerebellum.js) | The Familiar's by-id surface; ids ride in on `recall` / `list_memories`. `move_memory_date` cleans up facts filed under the wrong day; `update_/delete_by_id` safely correct or remove ONE per-fact row. The by-date `update_memory`/`delete_memory` are journal-bucket/significant only (scoped `slug IS NULL`). |
| `save_memory` executor | Auto-derives the slug (`deriveMemorySlug`) and returns the composite key in its confirmation so the Familiar knows the address of what it just wrote. |
| Knowledge editor — memory panel (app.js) | Addresses every read/edit/move/delete by the row's `id` (0.7.61). It used to send the `granularity/date` key, which collided for standalone facts sharing a date — clicking any row opened the top one. By-id is the fix; don't regress it back to key-addressing. |

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
| Memorization | 5s tick | `PROTO_FAMILIAR_MEMORIZE_DISABLED=1` | Drains queue of session-memorization jobs |
| Pondering | 1min tick + tier-based interval | Settings toggle + `PROTO_FAMILIAR_PONDERING_DISABLED=1` | Picks an interest, ponders it, writes a real tome entry |
| Reminders | 30s tick | `PROTO_FAMILIAR_REMINDERS_DISABLED=1` | Polls `reminders_due`, enqueues into outbox, marks fired |
| Silence triage | 5min tick + LLM-set cool-down | `PROTO_FAMILIAR_TRIAGE_DISABLED=1` | LLM decides "should I reach out?" given threat + silence |
| Warm reach-out | 10min tick + LLM-set cool-down | Settings toggle + `PROTO_FAMILIAR_WARMTH_DISABLED=1` | Warm non-crisis outreach (ward banner or warm-villager DM); stands down at moderate+ threat |
| Tome graduation | 30min tick (opt-in, default OFF) | Settings "Graduate tome knowledge" + `PROTO_FAMILIAR_TOME_GRADUATION_DISABLED=1` | Drains durable facts stranded in tomes → identity/memory/graph (relational facts resolve-or-create + dedup); confirmed route before tidy; consent-gated ward memory |
| Memory coverage sweep | 10min tick (default ON) | Settings "Memory coverage sweep" + `PROTO_FAMILIAR_MEMORY_SWEEP_DISABLED=1` | Memorizes PAST days that never ingested (day-anchoring Phase 2); skips today + completed days; only enqueues into the memorization worker — no LLM call of its own |
| Discord gateway | 30s supervisor | Settings toggle + `PROTO_FAMILIAR_DISCORD_DISABLED=1` | Bidirectional Discord presence; follows Settings (token/enable) without restart |
| Threat detection | per chat msg (in-band) | `PROTO_FAMILIAR_THREAT_DISABLED=1` | Patterns score my human's text; tracker accumulates with decay |

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
- **MCP child processes:** Phylactery + Unruh run as local stdio children
  (Python via uv), reading/writing only their own `data/` dirs. No network
  listener of their own; reachable only through thalamus over stdio.
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
- [`docs/phylactery-design.md`](phylactery-design.md) — canonical self-store
  design rationale (original design by Zari Lewis / Psycheros).
- [`docs/phylactery-build-spec.md`](phylactery-build-spec.md) — imperative
  build instruction for the Phylactery milestone (A→B→G→…).
- [`docs/research/`](research/) — research notes that feed future
  design decisions (task-handling obstacles, etc.).
