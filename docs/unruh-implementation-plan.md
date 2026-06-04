# Unruh — Implementation Plan

> Companion to `docs/unruh-design.md`. Read that first if you haven't —
> this plan turned the design into a sequence of buildable milestones.
> Kept as a historical record of how Unruh was built (the work
> shipped in 0.3.0-alpha and merged to `main`).

**Branch convention (historical):** development happened on the
dedicated `Unruh` branch of Proto-Familiar, merged to `main` via PR
on Unruh's completion (0.3.0-alpha). The Unruh module itself lives
**inside this repo** as a subdirectory at `unruh/` — *not* a sibling
repo (this differs from entity-core, which lives at
`../entity-core/`). See Decision 1 below for the rationale.

---

## 0. Orientation — where things live today

Before touching anything, a new session should know the existing wiring.
These file:line references are the load-bearing ones; verify them at the
start of a session in case the codebase has moved on.

| What | Where |
|---|---|
| Per-message Thalamus enrichment entry point | `thalamus.js:175` (`enrich()`) |
| MCP client + stdio transport to entity-core | `thalamus.js:17-104` |
| Entity-core path probing (with `entity-core-alpha` fallback) | `thalamus.js:43-59` |
| Parallel tool calls to entity-core | `thalamus.js:182-192` (`Promise.allSettled`) |
| Section assembly into the LLM prompt | `thalamus.js:202-340` |
| Inbound chat endpoint | `server.js:142` (`POST /api/chat`) |
| `_thalamus` envelope sent back to UI | `server.js:210` (non-stream), `server.js:235` (SSE) |
| Per-session log persistence | `server.js:291` (`POST /api/log` → `logs/{sessionId}.json`) |
| Memorization worker (template for background ticks) | `memorization.js:35-371` |
| Settings JSON (centralised, atomic write) | `server.js:972-999` |
| Frontend prompt assembly + Knowledge editor | `public/app.js` (`buildApiMessages`, Knowledge editor modal) |
| Frontend session-end + topic markers | `public/app.js` (`state.topics`, `autoEndSession`) |
| Installer convention for sibling specialists | `install.sh:119-212` (Deno + entity-core clone) |
| Tailscale gate / loopback enforcement | `server.js` middleware + `.proto-familiar-config.json` |
| Doc surface to update | `docs/architecture.md`, `docs/entity-core.md`, `docs/features.md`, `docs/future-features.md`, `README.md` |

Things that **do not yet exist** and the design assumes will be built:

- Any "topic detection" beyond the user-annotated `state.topics` array.
- Any background tick in `server.js` (memorization runs in-process but
  does not currently fire on its own outside the job queue).
- Any proactive outbound channel (Discord/email/webhooks).
- Any second MCP child process — `thalamus.js` is currently single-peer.

---

## 1. Architectural decisions to lock in before coding

These are choices that the design doc leaves open or implies. Resolving
them early keeps later milestones from forking.

1. **Subdirectory under Proto-Familiar, not a sibling repo.** Unruh
   lives at `unruh/` inside this repo, on the `Unruh` branch. This
   diverges from the entity-core pattern (which is a separate
   sibling-cloned repo) for two reasons: (a) the user pre-created the
   `Unruh` branch as the home for this work, signalling intent to keep
   it in-tree; (b) it removes the install-time clone-and-pin dance,
   simplifying installer changes. Trade-off: Unruh can't version
   independently of Proto-Familiar, but at this stage that's
   acceptable — Proto-Familiar's `package.json` version is the single
   source of truth (per `CLAUDE.md`) and Unruh changes get bundled
   into the same version stream. Python tooling: `uv` with
   `pyproject.toml`. The `UNRUH_PATH` env var still exists as an
   override for testing.

2. **Transport.** MCP over stdio, JSON-RPC 2.0, same SDK
   (`@modelcontextprotocol/sdk` on the Thalamus side; the official
   Python MCP SDK on the Unruh side). No HTTP between Thalamus and
   Unruh — keep the parity with entity-core.

3. **Thalamus becomes a true mediator.** Today it is a single-peer
   bridge. Refactor it so the MCP client is plural (`mcpClients = { entityCore, unruh }`)
   and `enrich()` fans out across whatever specialists are connected.
   Both specialists' failures must degrade independently (entity-core
   still works if Unruh is down, and vice versa).

4. **Prompt section label.** Unruh's contribution appears as
   `[Temporal Context]` per the design doc. Keep that label literal in
   code so it is greppable. Section ordering in the assembled prompt:
   identity → memories → graph → **temporal context** → custom. Place
   it *after* graph context because temporal facts should be the
   freshest context the model sees before the user message.

5. **Graph storage.** SQLite (single file under `unruh/data/`),
   schema-light: `nodes(id, layer, type, label, payload_json, weight,
   created_at, updated_at)` and `edges(id, src, dst, kind, payload_json,
   created_at)`. SQLite gives us atomic writes, easy backup, and the
   right scale (kilobytes to single-digit MB). Postpone any embedded
   graph library until there is a clear need.

6. **Time source.** All timestamps in Unruh are stored as UTC ISO-8601.
   User-facing rendering uses the system's local timezone, captured
   once at server boot (do not re-detect per request — that hides
   drift). Add a `UNRUH_TZ` env override for testing.

7. **No local LLM inference inside Unruh.** Per the design doc, Unruh
   never calls a model directly. Anything that needs a model (topic
   detection on incoming messages, intent summarisation at session
   end) is done by the existing chat path or by Thalamus, and the
   result is *written into* Unruh via an MCP tool call.

8. **Decay is deterministic.** Compute decay on read, not on a tick:
   `effective_weight = raw_weight * exp(-(now - last_touched) / tau)`.
   This way a missed tick can never corrupt state, and the same code
   path returns the same answer regardless of when it ran. A daily
   compaction job can collapse decayed-to-near-zero nodes.

9. **Tailscale + password gate is already shipped.** Do not bake any
   alternative network surface into Unruh. If the proactive-messaging
   work later needs outbound channels (Discord, email), those are
   *outbound* — they don't change the inbound posture.

If you change any of these while implementing, update this section so
the next session inherits the new ground truth.

---

## 2. Milestones

Each milestone is a discrete unit. They are roughly ordered by
dependency; later milestones assume the earlier ones landed. Where a
milestone is independent enough to be done out of order, it's flagged.

Status legend used inside each milestone: `[ ]` not started · `[~]` in
progress · `[x]` shipped. Update the boxes as work lands.

### Milestone 1 — Unruh process skeleton & MCP handshake

**Goal:** A new `unruh/` subdirectory inside Proto-Familiar that, when
run, exposes an MCP server over stdio that Thalamus can connect to. No
real data yet — just the plumbing and a `health_check` tool.

**Tasks**
- [x] Create `unruh/` subdirectory with `pyproject.toml` targeting
      Python ≥ 3.11 and managed by `uv`.
- [x] Add `mcp` SDK dep and a minimal server in
      `unruh/src/unruh/server.py` that registers one tool:
      `health_check` returning `{ "ok": true, "version": "...",
      "ts": "..." }`.
- [x] Add `unruh/data/` (gitignored) for future SQLite, plus an
      `unruh.toml` config stub.
- [x] Add a `unruh/README.md` covering local-dev setup.

**Acceptance:** Running `uv run python -m unruh` from `unruh/`
produces a process that speaks MCP over stdio and answers
`tools/list` and `tools/call` for `health_check`.

**Out of scope:** graphs, weights, anything user-facing.

---

### Milestone 2 — Thalamus second-peer wiring

**Goal:** `thalamus.js` connects to Unruh in parallel with
entity-core, calls a single tool per message, and inserts a
`[Temporal Context]` section into the assembled prompt. Independent
failures on each peer.

**Tasks**
- [x] Refactor `thalamus.js:67` so the single `mcpClient` becomes a
      map `mcpClients = { entityCore: null, unruh: null }`.
- [x] Add `connect()` calls for both, with independent error logging.
      Probe `unruh/src/unruh/__main__.py` and let `UNRUH_PATH`
      override.
- [x] Spawn command for Unruh: `uv run python -m unruh` with `cwd`
      set to `unruh/` so its `data/` resolves correctly.
- [x] In `enrich()`, add a fourth `Promise.allSettled` entry calling
      Unruh's `temporal_context` tool.
- [x] Format the response under a `[Temporal Context]` header,
      inserted after the graph section in the assembled string.
- [x] Tool returns an empty payload until Milestone 3 fills it in;
      verify the section still renders cleanly when empty (omit
      rather than print a hollow header).

**Acceptance:** With Unruh stopped, `/api/chat` works exactly as
before. With Unruh running, the prompt inspector in the UI shows a
new `[Temporal Context]` block (empty placeholder text is fine for
now). Killing either child process does not break the other.

---

### Milestone 2.5 — Hardening pass (post-M1+M2 review)

**Goal:** Close the highest-probability ways the M1+M2 work would
silently break on a real install before any further code lands on
top of it.

**Tasks**
- [x] **Absolute-path `uv` resolution.** `resolveUvBinary()` in
      `thalamus.js` probes `~/.local/bin/uv`, `~/.cargo/bin/uv`,
      `/usr/local/bin/uv`, `/opt/homebrew/bin/uv` on Unix and
      `%LOCALAPPDATA%\uv\bin\uv.exe` on Windows before falling back
      to PATH. `UV_BIN` env var overrides everything. Prevents
      ENOENT when GUI launchers inherit a minimal PATH.
- [x] **`.venv/` probe.** `connectUnruh()` now requires both
      `unruh/pyproject.toml` and `unruh/.venv/` to exist before
      attempting the spawn. Surfaces a clear "run `uv sync`" message
      instead of letting `uv run` fail opaquely.
- [x] **Reconnect with backoff.** `onclose` schedules a reconnect
      via `scheduleUnruhReconnect()` — backoff sequence
      `1s, 2s, 5s, 10s, 30s` (last value repeats), capped at 10
      attempts. Successful connect resets the counter.
      `shutdownUnruh()` export lets a future SIGTERM handler stop
      the loop cleanly.
- [x] **Timeout on `temporal_context`.** The call is wrapped in
      `Promise.race` with a 2000ms cap (`UNRUH_CALL_TIMEOUT_MS`)
      so a slow or hung Unruh can never block the chat path. The
      underlying MCP request keeps running in the background —
      Promise.race doesn't cancel — but it can't delay the LLM
      response. Real cancellation lands when query budgets become
      a real concern.
- [x] **Test scaffold.**
      - `unruh/tests/test_server.py` (pytest, `uv run pytest`):
        contract tests for `health_check` and `temporal_context`
        return shapes — the shapes Thalamus's formatter depends on.
        Dev dep via `[dependency-groups] dev`.
      - `tests/temporal-format.test.mjs` (Node 22 `node:test`,
        `npm test`): 11 tests for the formatter covering populated,
        empty, null, and edge-case payloads. Includes the critical
        "empty payload → empty string → section omitted" contract.
      - Formatter extracted to `temporal-format.js` so tests can
        import it without triggering thalamus.js's startup spawns.
- [x] **Auto-install + auto-sync in launchers/installers** (pulled
      forward from M13 because the first real `git pull` hit the
      "Unruh venv missing" message immediately — installer-time
      work shouldn't be a manual prerequisite to the launcher
      working). `install.sh` / `install.bat` / `scripts/win/install.ps1`
      now detect `uv` (via PATH / `~/.local/bin` / winget) and
      auto-install via Astral's official one-liner if missing, then
      run `uv sync` in `unruh/`. `start.sh` / `start.bat` /
      `Proto-Familiar.command` / `Proto-Familiar.vbs` detect a
      missing `unruh/.venv/` after a pull and silently invoke the
      installer — symmetric to how `node_modules` missing already
      triggers it. Result: any user who pulls a checkout
      containing Unruh gets it working on next launch with no
      manual steps. M13 still owns the broader installer polish
      (cleanup of orphaned children, etc.).

**Still flagged but deferred** (from the M1+M2 review, deliberately
not done here — listed in §3 Cross-cutting concerns for whichever
future milestone is the natural home):

- Orphaned Python child on hard kill of `node server.js` (esp.
  Windows) — needs an explicit child-PID tracker + SIGTERM handler
  in `server.js`, which is server-side, not Thalamus-side.
- Unruh's stderr piping — verify `StdioClientTransport` actually
  forwards child stderr to the parent; if not, wrap the spawn.
- Timezone in the rendered prompt — Decision 6 says local TZ but
  the formatter currently passes UTC straight through. Resolve as
  part of M3 when phase nodes start carrying times.
- Clock drift / monotonic time for decay — concern for M5.
- SQLite multi-process safety + read pagination — design concerns
  for M3.

---

### Milestone 3 — Schedule layer: graph storage + write tools

**Goal:** Persistent graph of events, tasks, phases, states with
temporal/causal edges. Read tool used by Milestone 2's
`temporal_context`. CRUD tools usable by Thalamus or by a future UI.

**Tasks**
- [x] SQLite schema in `unruh/data/unruh.db` per Decision 5. Tiny
      migration runner (`unruh/src/unruh/migrations/NNNN_*.sql`,
      version stored in `meta.schema_version`). WAL mode +
      `busy_timeout=5000` for the M2.5-deferred multi-process
      safety concern. Foreign keys ON so edges cascade on node
      delete. `0001_initial.sql` covers both schedule AND interest
      layers (one `nodes` table with a `layer` discriminator) so M4
      doesn't need a follow-up migration.
- [x] MCP tools:
      - `schedule_add_node({ type, label, when?, end?, payload? })`
      - `schedule_add_edge({ src, dst, kind, payload? })`
      - `schedule_get_window({ from?, to?, limit?, include_open_tasks? })`
        — returns nodes inside the window + open tasks (no when_ts,
        unresolved) + every edge touching them. `limit` defaults
        to 200 (M2.5 pagination concern addressed from the start).
      - `schedule_resolve({ id, resolution })` — done / cancelled /
        carried_forward.
      All return a structured `{ok, ...}` shape so the Familiar gets
      actionable errors instead of bare exceptions.
- [x] Wire `temporal_context` to call `current_phase()` +
      `get_window(now ± 12h)` and return them under `schedule:
      { phase, window }`. Formatter in `temporal-format.js` renders
      `Current phase: <label> (HH:MM–HH:MM)` and time-sorted window
      lines `HH:MM — <label>`. Resolution badges surface as
      `[done]` / `[cancelled]` / `[carried_forward]`.
- [x] Seed file `unruh/src/unruh/seed_routine.json` capturing the
      user's anchors (`~10 AM wake/meds/cat`, `~10 PM cat
      play/dinner`) plus four ambient phases. Loadable via
      `python -m unruh seed-routine` (idempotent: skip phases
      already present today) or `seed-routine --replace` (rewrite
      today's phases, leave user-created events/tasks alone).
- [x] **Local-TZ rendering** (deferred from M2.5 Decision 6).
      `formatLocalTime()` in `temporal-format.js` converts UTC
      ISO-8601 to landmarks-style local strings — `HH:MM` (today),
      `yesterday HH:MM`, `tomorrow HH:MM`, `Mon DD HH:MM` (this
      year), `YYYY-MM-DD HH:MM` (other years). Uses the Node
      process's system TZ.
- [x] **Pagination from day one** (deferred from M2.5). Every read
      tool's signature has a `limit` parameter, defaulting to 200.
- [x] Test scaffold expanded: 43 new pytest tests (`test_schedule.py`,
      `test_temporal_context.py`, `test_seed.py`) covering CRUD,
      window edge cases, phase boundary semantics, payload round-
      trip, migrations idempotency, FK cascade, and the seed
      loader's replace-vs-skip semantics. 6 new Node tests for the
      local-TZ formatting + resolution badges. Totals: 54 Python +
      17 Node.

**Acceptance:** Verified end-to-end. Running
`uv run python -m unruh seed-routine` populates phases + anchors;
`enrich('hello')` returns a `[Temporal Context]` block with the
current phase and time-sorted window. Resolved tasks drop out of
the window. Schema survives process restarts.

**Resolved design question — landmarks vs coordinates.** Phases live
as `phase`-type nodes with `when_ts` (start) + `end_ts`, attached
to events/tasks via `during` edges. The formatter prepends the
current phase to the window so the model sees "we're in *afternoon
work*, here's what's coming" rather than coordinates.

---

### Milestone 4 — Interest layer + standing values

**Goal:** Second graph layer for interests, with standing values
always-on and live interests carrying weight. Anchored values
referenced from entity-core.

**Tasks**
- [x] Schema already covers this via the `layer` discriminator
      landed in M3's `0001_initial.sql` — no migration needed.
      `nodes.weight` + `nodes.last_touched` columns are populated
      starting M4.
- [x] Interest node types: `standing_value`, `active_pursuit`,
      `live_interest`, `curiosity`, plus `bookmark` as a separate
      type. Bookmark linking via a `bookmarked` edge from the
      bookmark node to its topic (sidestepped the singleton-self-
      node design question — bookmarks reference topics directly).
- [x] MCP tools:
      - `interest_record({ topic, source, payload, delta })` — bumps
        weight, creates node if missing. Decay-then-add on existing
        nodes: stored raw weight reflects current effective weight
        before the bump, so rapid engagement doesn't accumulate
        unboundedly.
      - `interest_bookmark({ topic, resource, note })` — bookmark
        node + `bookmarked` edge to the topic (auto-creates topic
        as curiosity if missing).
      - `interest_list({ limit, min_weight, include_standing })` —
        sorted by effective weight desc; standing values bypass
        min_weight and surface alphabetically.
      - `interest_set_standing({ topic, value_ref, weight })` —
        promotes (or creates) a node with type=standing_value and
        payload.value_ref. Standing values bypass decay entirely.
- [x] Wire `temporal_context` to include `list_interests(limit=10)`
      under `payload.interests = { standing, live }`. The
      thalamus.js formatter already rendered this shape (M2's
      placeholder), so the addition is server-side only and
      surfaces in the [Temporal Context] block automatically.

**Acceptance:** Verified end-to-end. `interest_record("owl feather
aerodynamics", delta=1.5)` followed by `enrich('hello')` produces a
`[Temporal Context]` block containing `Live interests (by weight):
owl feather aerodynamics [1.50]`. Standing values render in their
own sub-section regardless of weight. Decay reduces effective weight
over simulated time (see `test_effective_weight` cases).

**Open question — weight curve shape resolved.** Default tau is
5 days (rough half-life = 5*ln(2) ≈ 3.5 days; a 1.0 weight decays
to ~0.18 at 5d, ~0.03 at 15d). Min surfaced effective-weight is
0.01 — below that, an interest is too faded to be worth prompt
tokens. Both configurable as MCP tool arguments now; settings-
synced UI control lands with M5.

**Tier classification** is computed on read from effective weight,
not stored: curiosity < 0.5 ≤ live_interest < 2.0 ≤ active_pursuit.
Promotion is implicit (engagement raises the tier label without
mutating the stored type). The one explicit type change is
`interest_set_standing`, which forces type=standing_value and
disables decay.

---

### Milestone 5 — Weight instrumentation

**Goal:** Weights actually accrue from real signals rather than being
written by hand. Three signals: token volume per topic, topic
persistence across consecutive messages, session-boundary survival.
Bookmarks remain a supplementary explicit signal.

**Tasks**
- [x] **Topic attribution.** Took approach (a): the frontend's
      `recordTopicEngagement()` collects the currently-open topics
      (state.topics with endIndex === null) when a turn completes and
      POSTs them to `/api/interest/engage`. No new model dependency.
      Approach (b) — an LLM-based topic detector for unmarked
      conversation — remains the documented follow-on; until it
      lands, weights only accrue for topics the user has marked.
- [x] **Token volume.** The engage payload carries `responseChars`
      (the final assistant reply's length — chars/4 ≈ tokens, no
      tokenizer). `interestEngagementDelta()` in server.js maps it
      to a weight component: ~1500 chars → 0.1, capped at 0.5 so a
      single huge dump can't dominate.
- [x] **Topic persistence.** The engage payload carries
      `spanMessages` per topic (how many messages it's been open
      for). The delta formula adds 0.05/message, capped at 0.3 — a
      topic the conversation keeps returning to accrues steadily.
- [ ] **Session-boundary survival.** Deferred to Milestone 6 as the
      plan anticipated — it depends on the session-end handoff
      writing last-active topics, which M6 introduces. The `source`
      field on `interest_record` is already plumbed so M6 can post
      `source='session_boundary'` bumps without further wiring.
- [x] **Bookmarks.** Explicit tool from Milestone 4 (`interest_bookmark`).

**Acceptance:** Verified end-to-end via smoke. Recording engagement
for "owl flight mechanics" across turns accrues weight (0.3 + 0.4 →
0.70, rendered in the [Temporal Context] live-interests list sorted
by weight); a single small bump (0.05) lands low and decays away.
The full path is frontend `recordTopicEngagement` → POST
`/api/interest/engage` → `interestEngagementDelta` → thalamus
`recordInterest` → Unruh `interest_record` (decay-then-add) →
`temporal_context` surfacing.

**Open question — weight curve shape: resolved.** tau = 5 days (set
in M4's interest.py, `DEFAULT_TAU_DAYS`). Accrual constants live in
server.js (`ENGAGE_*`). Both are code constants for now; the M5
plan's "expose as config" is folded into the same settings-sync work
M4 deferred — a single "interest tuning" settings group (tau, accrual
scales, min surfaced weight) is cheaper to ship once than piecemeal.
Tracked as a near-term follow-on, not a blocker.

---

### Milestone 6 — Intent handoff at session boundaries

**Goal:** Session end writes an "intent" + open threads. Session start
surfaces them at the top of `[Temporal Context]`.

**Tasks**
- [x] **Session-end hook.** Both session-end paths (`autoEndSession`
      idle-timer + the Clear-history button) call
      `generateAndStoreHandoff(messages, sessionId)` fire-and-forget.
      It summarises the last ≤12 user/assistant turns into
      `{ active_intent, open_threads[] }` via the cheapest connection
      (`getConnectionSequence()[0]`) and POSTs to `/api/session/handoff`
      → `recordHandoff` → Unruh `session_set_handoff`. Gated on a
      synced `handoffEnabled` setting (default on) so the extra
      per-session generation can be turned off.
- [x] **Session-start surfacing.** `temporal_context` folds the latest
      unconsumed handoff into its payload; `temporal-format.js` already
      renders it as the "Last session:" block at the top of
      `[Temporal Context]`, ahead of schedule + interests.
- [x] **Consumption.** The real chat path calls
      `enrich(…, { consumeHandoff: true })`; after surfacing the
      handoff once, thalamus fires `session_mark_handoff_consumed` so
      it doesn't reappear on later messages. `set_handoff` supersedes
      any prior unconsumed handoff, so at most one is ever live.
      (debug-prompt / the summariser don't consume.)

**In-character summaries.** The summariser call uses `enrich: 'static'`
— a new enrichment mode that injects ONLY the identity/persona block,
not memory / graph / temporal. So the handoff note comes out in the
Familiar's first-person voice ("I was helping you outline the intro…")
without (a) bloating the summary with RAG memories or (b) the temporal
fetch consuming the very handoff we're about to write.

**Acceptance:** Verified end-to-end via smoke — write a handoff, the
next session's first message surfaces "Last session: intent — … / open
— …", and the message after that no longer shows it (consumed). The
session-boundary interest signal that M5 deferred is now unblockable
(a handoff write is the natural place to bump re-emerging topics);
left as a follow-on.

---

### Milestone 7 — Standing-value bridge to entity-core

**Goal:** Standing values in Unruh are not free-floating strings but
typed references to entity-core identity facts, so the redundancy the
design doc calls for becomes structural rather than nominal.

**Tasks**
- [x] Reference schema, anchored by stable identifier — a string:
      `entity-core:<category>/<filename>[#<section>]`
      (e.g. `entity-core:self/my_wants.md#Caring for the user`).
      `<category>` is one of self / user / relationship / custom.
      Stored verbatim in the standing value's `payload.value_ref`
      (already plumbed in M4) and surfaced at top level by
      `list_interests`. Parsed/resolved by `entity-ref.js`.
- [x] **Resolved: Thalamus mediates** (not sibling-MCP). Thalamus is
      the only component that holds both sides — entity-core's identity
      (`identity_get_all`) and Unruh's interests (`temporal_context`) —
      and it already fetches both in `enrich()`. Validating there keeps
      Unruh independent and inference-free, with no dependency edge
      between the two specialists (which sibling-MCP would have added).
      The check is a cheap string-parse + lookup in already-fetched
      data; demotion is a fire-and-forget call to the new
      `interest_demote_standing` tool.
- [x] Demotion rule documented + implemented: when a standing value's
      anchored entity-core fact has disappeared, it is **demoted to
      `live_interest`** (keeping its label + weight, `last_touched`
      refreshed so it surfaces once then decays) rather than dropped.
      **Hard safety guard:** the bridge only runs when entity-core
      actually responded, and only acts on refs that parse as
      `entity-core:` refs and resolve to `missing` — so a transient
      entity-core outage can never mass-demote standing values.

**Acceptance:** Verified at the component level — `entity-ref.js`
resolves present/missing anchors (14 tests); `interest_demote_standing`
moves a standing value into the live list without dropping it (Python
tests); `temporal_context` surfaces `value_ref` + `id` so Thalamus can
act. The end-to-end "edit the identity file → demote on next read" path
runs through `enrich()` and needs a live entity-core to exercise (no
Deno in CI), but every link is unit-tested and the wiring reads the
verified fields.

**Notes:** This milestone is small but politically important — it is
the seam where the design's "redundancy is intentional" claim becomes
real or hollow. It is now real: a standing value either re-derives from
a living entity-core fact or quietly steps down to an ordinary interest.

---

### Milestone 8 — Idle / free-cycle surfacing *(Shipped in 0.2.60-alpha)*

**Goal:** When the user has been quiet for a sustained period, Unruh
surfaces due bookmarks so Familiar can weave them naturally into its
response, and tracks whether each surfaced bookmark was actually
engaged with so the resurface interval adapts over time.

**Tasks**
- [x] Add a `temporal_context` mode flag: `mode = 'message' |
      'idle'`. In idle mode the response includes up to 3 due
      bookmarks under `payload.bookmarks`.
- [x] Decide what "idle" means: chose approach (b) — detect idle on
      the chat path itself. `thalamus.js` computes
      `isIdle = (now - lastUserMessageAt) >= IDLE_THRESHOLD_MS`
      (30 min). When idle, `enrich()` passes `mode:'idle'` to
      `temporal_context` and returns `surfacedBookmarks` alongside
      the prompt sections. No scheduler needed.
- [x] Bookmark surfacing: `list_bookmarks_for_surfacing()` in
      `interest.py` selects bookmarks where
      `last_surfaced_at IS NULL OR elapsed >= resurface_after_hours`
      (default 24h), ordered by longest-overdue first, up to `limit=3`.
- [x] **Outcome tracking.** After the LLM response completes, server.js
      calls `reportSurfacingOutcomes({ responseText, bookmarks })`.
      For each surfaced bookmark, the topic label / resource / label
      are searched in the response text; presence → `'engaged'`,
      absence → `'ignored'`. Recorded via new MCP tool
      `interest_report_surfacing_outcome`.
- [x] **Adaptive resurface intervals.** `record_surfacing_outcome()`
      in `interest.py` adjusts `resurface_after_hours`:
      engaged → `interval × 1.5` (max 168h / 7 days);
      ignored → `interval × 0.75` (min 4h). Three consecutive ignores
      (`consecutive_ignores >= 3`) trigger topic weight decay (−0.05).
- [x] **Database migration.** `0003_bookmark_surfacing.sql` adds four
      columns to `nodes`: `last_surfaced_at`, `last_surfacing_outcome`,
      `resurface_after_hours` (DEFAULT 24.0), `consecutive_ignores`
      (DEFAULT 0). Index on `(layer, type, last_surfaced_at,
      resurface_after_hours)` WHERE `layer='interest' AND type='bookmark'`.
- [x] **New MCP tools** in `server.py`:
      - `interest_report_surfacing_outcome(bookmark_id, outcome, now=None)`
      - `interest_list_bookmarks(limit=100)` → `{ok, bookmarks}`
        (includes all 4 surfacing-metadata fields)
- [x] **New server endpoint:** `GET /api/temporal/bookmarks` →
      `listBookmarks()` in thalamus.js → `interest_list_bookmarks`.
- [x] **`temporal-format.js`** renders the `payload.bookmarks` array
      under "Bookmarks to revisit (idle time — consider weaving one
      in naturally):" with topic, label, resource, note, and
      surfacing history.
- [x] **UI — Interests tab** in the Temporal editor shows a new
      "Bookmarks (idle surfacing)" section. Each bookmark card shows:
      label, topic, resource, note, outcome badge (green
      Engaged / red Ignored / grey Pending), consecutive-ignore count,
      last-surfaced time, and adaptive resurface interval.
      `te-int-summary` now includes the bookmark count.
- [x] **`public/app.js`** threads `prevUserMessageAt` through the
      send-message call chain; `round === 0` fetch bodies include
      `lastUserMessageAt` so the server can compute idle duration.

**Acceptance:** After 30+ minutes of user silence, the next message
causes `[Temporal Context]` to include a "Bookmarks to revisit" section
with up to 3 due bookmarks. After the response, outcomes are recorded
and intervals adapt. The Temporal editor Interests tab shows the full
surfacing history per bookmark.

---

### Milestone 9 — Frontend: Unruh inspection & editing

**Goal:** Parity with the entity-core Knowledge editor — a way to see
what Unruh thinks and to fix it when it's wrong.

**Tasks**
- [ ] New sidebar entry next to "🧠 Open Knowledge editor", e.g.
      "🕰 Open Temporal editor". Same modal-style component.
- [ ] Tabs: **Schedule** (timeline view of upcoming events/tasks),
      **Interests** (list sorted by effective weight, with raw weight
      / last-touched / decay metadata visible), **Routine** (the
      phase definitions seeded in Milestone 3, editable),
      **Handoff** (current intent + open threads).
- [ ] Each tab gets CRUD against the relevant MCP tools.
- [ ] Prompt inspector already shows `_thalamus.entityContext`;
      extend it to also show a `_thalamus.temporalContext` block
      pulled from the new Unruh response.

**Acceptance:** A user with no terminal access can fully manage
schedule, interests, and routine through the UI.

---

### Milestone 10 — Familiar's routine, properly

**Goal:** Move from the seeded routine of Milestone 3 to a routine
that emerges from conversation with the user.

**Tasks**
- [ ] Conversation prompt scaffolding: a one-off "let's figure out
      what rhythm feels natural" flow, surfaceable from the Routine
      tab.
- [ ] Phase nodes get optional `texture` payload — a short
      character-voice description of "what Familiar is like at this
      time of day". The model reads this and lets it colour
      responses, per the design doc.
- [ ] No imposed productivity framework. Test that the system works
      with a sparse routine (just the two user anchors) as well as a
      dense one.

**Acceptance:** Routine is genuinely user-shaped and feels like a
character trait, not a schedule.

---

### Milestone 11 — Reminders mechanism (design + ship)

**Goal:** Time-triggered events fire reliably. **The design doc
explicitly flags this as an open question** — solve it before
shipping, do not assume cron-style timers will work.

**Tasks**
- [ ] **Spike first.** Before building, evaluate at least these
      approaches and write up the trade-offs:
      - Deno cron inside entity-core (already enabled via
        `--unstable-cron`, but coupling reminders to entity-core
        muddies separation)
      - Python `apscheduler` inside Unruh
      - A small dedicated `cronlet` process Proto-Familiar manages
      - OS-level scheduling (systemd timer, launchd) — most
        reliable, hardest to install
- [ ] Pick one with eyes open to the "silent failure" mode the
      design doc calls out. Whatever you pick must surface health
      via a `reminders_health` MCP tool so a missed fire is visible.
- [ ] Build the chosen mechanism. Store reminders as nodes in the
      schedule graph with a `fires_at` payload; the scheduler walks
      that on tick.
- [ ] Delivery: in this milestone, "delivery" just means injecting a
      message into the active session if there is one, or queueing
      until next session start if there isn't. Real outbound
      channels come in Milestone 12.

**Acceptance:** A reminder set 1 minute out fires within ±5s. A
reminder set across a server restart still fires. A missed reminder
is loud, not silent.

---

### Milestone 12 — Proactive messaging (three categories)

**Goal:** Familiar can reach out unprompted. The design doc separates
this into three categories with very different failure tolerances.
Build them as three distinct paths sharing a delivery substrate.

**Tasks**
- [ ] **Delivery substrate first.** A small `outbound/` module with
      pluggable channels: in-UI banner, Discord webhook, email
      (SMTP). Each channel is opt-in via settings; default to in-UI
      only.
- [ ] **(12a) Timeblindness reminders.** Built on Milestone 11.
      Highest-volume, lowest-stakes. Delivery defaults to in-UI;
      Discord and email are opt-ins.
- [x] **(12b) Silence triage.** *(Shipped in 0.2.54-alpha)*
      - Store `threat_level` as a decaying-weight node in the
        interest layer (the design doc explicitly notes it is
        structurally identical to an interest weight, so reuse the
        primitive).
      - Triage interval is a function of `threat_level`; high level
        → short interval. Cap the rates so a buggy threat detector
        cannot spam the user.
      - The actual triage *decision* is an LLM call with full
        context, not a threshold check. Passes: recent session
        messages, full identity context via `enrich('', { staticOnly: true })`,
        elapsed time, current `temporal_context`. Prompt is neutral —
        no passivity bias. The LLM decides: do nothing, gentle
        check-in, escalate.
      - Every triage tick is appended to `logs/triage-events.jsonl`;
        readable via `GET /api/triage-events`.
      - Pending triage notices surface in the next `[DYNAMIC CONTEXT]`
        block so the Familiar can reference them on reconnect.
      - Threat detection inputs: a short list of language patterns
        for elevation; explicit safety/coping language for
        reduction. Document the patterns somewhere editable, not
        hard-coded.
- [x] **(12c) Trusted-contact outreach.** *(Shipped in 0.2.54-alpha)*
      Not a separate trigger — an *action* the triage LLM in 12b can
      take. Configured contact list lives in settings, with a per-contact
      channel (Discord/email/SMS-bridge). All outbound to humans is
      logged visibly to the user — no covert contact.
      **Escalation is sequential:** Familiar contacts the user first
      (outbox banner). The trusted-contact webhook fires only if the
      deadline passes without acknowledgement (severe=30min, high=2h,
      moderate=6h). `outbox.js` carries the pending contact and deadline
      in `meta`; `checkAndFirePendingContacts()` in `server.js` fires it.

**Acceptance:** Timeblindness reminders fire and deliver. Silence
triage runs at intervals shaped by threat level, calls into the
chat path for the decision, and never escalates without an LLM
having looked at real context. Trusted-contact outreach requires
explicit configuration and always leaves a visible trail.

**Critical safety note:** This is the riskiest milestone. Ship it
behind a feature flag (off by default), test extensively in single-
user mode, and write a doc page (`docs/unruh-proactive.md`)
documenting failure modes, how to disable, and how to interpret
delivered messages.

---

### Milestone 13 — Installer, launchers, ops

**Goal:** Fresh install picks up Unruh as cleanly as it picks up
entity-core today.

**Tasks**
- [ ] `install.sh` / `install.bat` / `scripts/win/install.ps1`:
      `uv` detection (install via the official one-line installer if
      missing — it ships a self-contained Python runtime, so we
      don't need to detect system Python separately), then
      `uv sync` inside `unruh/` to materialise the venv. No
      clone-and-pin needed since Unruh ships in-tree.
- [ ] Launchers (`start.sh`, `start.bat`, `Proto-Familiar.command`,
      `scripts/win/tray.ps1`): no changes expected — Thalamus
      spawns Unruh as a child, same as entity-core.
- [ ] `stop.sh` / `stop.bat`: confirm Unruh's Python child is
      terminated when Proto-Familiar shuts down (it should be by
      virtue of being a stdio child, but verify on each OS).
- [ ] CLAUDE.md update: add Unruh sibling-directory note next to the
      existing entity-core / entity-core-alpha note.
- [ ] README + docs updates per "Existing docs to update" in the
      Orientation table.

**Acceptance:** A fresh clone + `install.sh` on a clean machine
produces a working Proto-Familiar with Unruh attached and the
`[Temporal Context]` block visible in the prompt inspector.

---

## 3. Cross-cutting concerns to keep in mind

- **Version bumps.** Per `CLAUDE.md`, every commit that ships
  user-visible change bumps `package.json` version. Milestones 2, 6,
  9, 11, 12 are minor bumps; the rest are patch unless they grow
  scope. Mention the bump in the commit body.
- **Graceful degradation.** Every Unruh-touching code path in
  `thalamus.js` and `server.js` must keep working when Unruh is
  absent. Mirror the existing entity-core fallbacks.
- **Settings sync.** New user preferences that should follow the
  user across devices go in `SERVER_SYNCED_KEYS` in `public/app.js`
  (see CLAUDE.md absorption caveat — empty strings won't displace
  server values on first sync).
- **Privacy posture.** Unruh data is at least as sensitive as
  entity-core data (schedule + interests = strong behavioural
  signal). The Tailscale + password gate already covers the network
  surface; do not add separate ingress for Unruh.
- **Hardware budget.** The design doc commits to lightweight: the
  graph is kilobytes, no local inference. Hold the line — if a
  milestone wants to add a model or a heavy dep, push back.
- **Topic detection rabbit hole.** Several milestones (5, 6, 8)
  depend on having *some* topic signal. Resist building a fancy
  detector until the user-annotation path proves insufficient.

---

## 4. Open questions deferred until evidence

- Whether to share a single SQLite file across all future specialists
  or keep one per specialist. Default: one per specialist; revisit
  when the third specialist exists.
- Whether `[Temporal Context]` should be split into sub-sections
  (intent, schedule, interests) or a single block with internal
  structure. Build as separate sub-blocks first; collapse only if
  models confuse them.
- How aggressively to compact the graph. Defer until size becomes a
  problem (it shouldn't, at the design's "kilobytes" scale).
- Whether session-end intent writing should be best-effort
  (background) or blocking (must complete before session marked
  ended). Lean best-effort but make failures visible.

---

## 5. How to use this document in a future session

1. Open `docs/unruh-design.md` first for the *why*.
2. Open this file for the *what next*.
3. Pick the lowest-numbered milestone whose checkboxes aren't all
   `[x]`. If there are `[~]` items, finish those before starting a
   new milestone.
4. The Orientation table in section 0 is the cheat-sheet for
   "where does X live" — verify the line numbers haven't drifted
   before relying on them.
5. After landing work, update the checkboxes in this file as part
   of the same commit. Bump `package.json` per CLAUDE.md.
6. If a decision in section 1 was overridden in practice, edit
   section 1 so the next session inherits the new reality.
