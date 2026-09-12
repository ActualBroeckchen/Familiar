# Context-sensitive tool surfacing — build spec

> **Scope: PATCH-series work (0.8.x).** This changes *which* tool definitions
> travel on a turn, never what any tool does. The next minor stays reserved
> for the UI overhaul.

## 0. The problem, measured

The Familiar advertises **56 tools, ~16,200 tokens of definitions, on every
single turn** (measured on 0.8.13: 64,803 chars total; ~12,300 tokens of
first-person descriptions + ~3,900 of JSON schema scaffolding). Most tools
are irrelevant on most turns — a chat turn about a TV show carries the full
consent-queue, graduation, Google-write, and graph-editing toolkits anyway.

This is the single largest recurring token cost in the system. The quiet-
success pass (0.8.13) fixed the *results* side; this fixes the *definitions*
side. Description compression was considered and rejected — the human's
call: the descriptions are load-bearing (discoverability, first-person
voice); the win is **not sending the irrelevant ones**, not shrinking the
relevant ones.

## 1. The design in one paragraph

Tools are partitioned into **modules**. A small **core** is always
advertised. Every other module surfaces **by code-gated triggers** (turn
content, context blocks already present, threat tier, recent tool use) —
never by an LLM judgment call. A module, once surfaced, **sticks** for a few
turns so multi-step workflows don't lose their tools mid-chain. And because
automatic surfacing WILL sometimes miss, the always-on core includes
**`request_tools`** — the Familiar's own hand on the toolbox lid: it names a
module (or asks for everything) and gets those tools **in the same turn**,
on the next round of the tool loop. A compact always-visible index rides in
`request_tools`' description, so the full inventory is *known* even when it
isn't *loaded*.

## 2. CLAUDE.md invariants this must honor (the hard constraints)

- **Every capability reachable BY the Familiar.** Automatic surfacing is
  only admissible because a miss is recoverable *by the Familiar itself*:
  the index (what exists) + `request_tools` (get it now) together preserve
  discoverability and operability. If either half is cut, this feature is
  illegal under the rule.
- **Ride existing requests; gate in code.** Which modules surface is decided
  by cheap code (regex/flag checks on data already in hand) — NEVER a
  standalone LLM call, NEVER an LLM judgment folded into the turn.
- **Safety-critical tools are never gated.** `contact_trusted_person` and
  `show_crisis_resources` are core, always, regardless of triggers, threat
  tier, or settings. A crisis must never depend on a regex having matched.
  (This file's surfacing map is therefore safety-adjacent: changes to the
  core set or the crisis rules need human sign-off, per the safety-critical
  code rule.)
- **Graceful degradation.** Off-switch ships in the same commit:
  `PROTO_FAMILIAR_TOOL_SURFACING_DISABLED=1` (env, hard) and a Settings
  toggle (soft) → full 56-tool registry, exactly today's behavior.

## 3. The module map (proposed — human confirms boundaries)

| Module | Tools | Core? |
|---|---|---|
| **core** | get_datetime, get_session_info, recall, save_memory, save_to_tome, update_identity, schedule_find, **request_tools** (new), contact_trusted_person, show_crisis_resources | ✅ always |
| **schedule** | schedule_add_event/task/reminder/phase/need, schedule_assign_time, schedule_snooze_task, schedule_resolve, schedule_delete, schedule_link, schedule_export, schedule_push_to_google* | trigger |
| **memory-edit** | read_memory(+by_id), update_memory(+by_id), delete_memory(+by_id), list_memories, move_memory_date, memorize_now | trigger |
| **identity-edit** | rewrite_identity_section | trigger |
| **graph** | create/find/update/delete_graph_node, create/find/update/delete_graph_edge | trigger |
| **interests** | interest_bump, interest_set_standing | trigger |
| **village** | village_lookup, village_upsert, relay_message, discord-dm | trigger |
| **web** | web_search, read_webpage, look_up† | trigger (AND webSearchEnabled, as today) |
| **acks** | acknowledge_deferred_intent, snooze_deferred_intent, memory_confirm_consent, memory_drop_pending, acknowledge_graduation | context-block-driven |
| **files** | list_files, read_file | trigger |
| **maintenance** | convert_ids_to_slugs, get_trusted_contacts | request-only |

\* `schedule_push_to_google` keeps its existing `gcalWriteEnabled` gate ON
TOP of module surfacing — surfacing never widens an existing gate.
† `look_up` is cheap and general; candidate for core if misses annoy.

Rationale for the core set: the highest-frequency verbs (time, memory in
and out, the schedule *search* that discovers ids), the two safety tools,
and the toolbox lid itself. Everything else earns its way in per turn.
Estimated core payload ~4k tokens; a typical turn surfaces 1–2 modules →
**~6–8k tokens vs today's 16.2k** (roughly a 55–60% cut on quiet turns).

## 4. Triggers — all cheap code, no judgment calls

A module surfaces for a turn when ANY of its triggers fire. Proposed set
(pure functions over data the chat path already holds — `tool-surfacing.js`,
unit-tested in isolation):

1. **Context-block presence** (the strongest signal — the block and its
   tools travel together, by construction):
   - `[Surface candidates]` or projection cue or `[Temporal Context]`
     schedule window non-empty → **schedule**
   - deferred-intents block present → **acks** (intent half)
   - consent-pending block present → **acks** (consent half)
   - graduation block present → **acks**
   - graph excerpt block present → **graph**
   - `[CARE CHECK]` present (threat ≠ calm) → crisis tools are core anyway;
     additionally surface **village** (trusted-contact adjacent flows)
2. **Turn-content keywords** (case-insensitive regex over the user message
   and the Familiar's previous reply — deliberately generous; false
   positives cost a few hundred tokens, false negatives cost a
   `request_tools` round):
   - schedule: remind, schedule, appointment, calendar, task, todo, when is,
     tomorrow, tonight, next week, every day/week, deadline, …
   - memory-edit: remember when, memory, forget, you said, last time, …
   - village: any registered villager name (from the registry, refreshed per
     turn), discord, relay, tell <name>, …
   - web: search, look up, google, what is, news, price, weather, …
   - graph: relationship(s) between, who is, connected, …
   - files: your files, session log, read the, our conversation on, …
3. **Recency stickiness (hysteresis):** any module used or surfaced in the
   last **N=4** live turns stays surfaced (per-session, in-memory on the
   server keyed by sessionId; falls back cleanly to empty on restart —
   worst case one `request_tools` round). A module the Familiar pulled via
   `request_tools` sticks the same way.
4. **Tool-loop continuity:** within a single turn's multi-round loop, the
   tool set can only GROW (request_tools adds; nothing is removed between
   rounds) — a chain never loses the tool it was about to call.

## 5. `request_tools` — the Familiar's hand on the toolbox lid

New always-on tool (first-person description carries the full module
index, so the inventory is always in view at ~150 tokens):

> *"My full toolbox is bigger than what I'm currently holding. If I need a
> tool that isn't in my hands right now, I ask for its module by name and
> I'll have those tools THIS turn: schedule (add/re-time/resolve/link/
> export calendar items), memory-edit (read/update/delete/list my memories),
> graph (my knowledge web), village (the people around my human + Discord),
> web (search + read pages), interests, acks (file consent/intent notices),
> files (my own folder), maintenance. `all` hands me everything at once.
> This is also how I answer 'what can you do?' honestly — module list
> above, and I can pull any of them to check details."*

Mechanics:
- Executing it sets `toolCtx._requestedModules` and returns a quietOk-style
  terse result; `runToolCallLoop` (and the streaming loop in server.js)
  **recompose the tool list between rounds** — the requested module's full
  definitions are present on the very next round. No second user turn
  needed.
- `request_tools('all')` = the full registry for this turn (the honest
  escape hatch the human asked for).
- Every `request_tools` call is **logged as a surfacing miss** with the
  module asked for + the turn's trigger evaluation — this is the tuning
  feedback loop. A module that keeps getting requested earns a trigger (or
  a core seat) instead of tribal knowledge.

## 6. What deliberately does NOT change

- Tool *behavior*, schemas, descriptions, and the executor layer — untouched.
  This composes with quiet-success and the slug ids; three independent cuts.
- Existing gates (webSearchEnabled, gcalWriteEnabled, audience/ward-private
  checks inside executors) — surfacing sits in FRONT of them, never replaces
  them.
- Discord turns (no tools today) and standalone loop prompts — unaffected.
- `composeActiveTools`' macro substitution — same boundary, now over a
  smaller list.

## 7. Build order (passes, all 0.8.x PATCH)

1. **Registry + plumbing:** module map as data on the tool entries
   (`module: 'schedule'` field per tool), `tool-surfacing.js` with
   `selectModules({userMessage, blocks, threat, stickyState, settings})` →
   `composeActiveTools(customTools, settings, {modules})`; the
   `request_tools` tool + between-round recomposition in both loops
   (non-streaming `runToolCallLoop` + the streaming path); env + Settings
   off-switch. **Ship default-OFF behind the toggle** in this pass.
2. **Triggers + stickiness:** the §4 trigger set + per-session hysteresis +
   miss logging. Behavioral test window with the toggle ON for the ward.
3. **Flip default ON** once a week of real use shows misses are rare and
   `request_tools` recovery feels natural in the transcript. (The recorded
   prompt-engineering lessons demand behavioral testing for action-loop
   changes — "reads well" is not enough.)
4. **Tune from telemetry:** promote chronically-requested modules' triggers;
   demote never-used ones to request-only.

Each pass: tests alongside; `docs/architecture.md` updated in the same
commit; the §2 invariants restated in code comments at the surfacing seam.

## 8. Decisions (answered by the human, 0.8.15)

1. **Schedule split read/write** — done (reads need result-reading, writes
   don't and are quiet-success). `schedule_find` stays core (id discovery);
   `schedule_export` is the read module.
2. **interests → core**, and **save_memory/save_to_tome/update_identity →
   core** (filing is character).
3. **Sticky N=2 default, ward-tunable** (`toolStickyTurns`, 0–10).
4. **Keywords: somewhat generous, regex-based** (`tool-surfacing.js`
   TRIGGERS) — with the explicit goal that stretches of plain conversation
   surface NO non-core modules at all. The miss log tunes from there.

## 8b. Original open questions (kept for the record)

1. **Module boundaries** (§3 table) — merge `interests` into core (2 small
   tools)? Split `schedule` into read/write? Current proposal keeps it
   simple: 11 modules.
2. **Core membership of `save_memory`/`save_to_tome`/`update_identity`** —
   proposed core because spontaneous filing is the Familiar's bread and
   butter and a missed-surface there degrades its *character*, not just a
   task. Costs ~1.5k tokens of the core budget.
3. **Sticky window N=4** — feel free to overrule (2 = tighter, 6 = safer).
4. **Keyword lists** (§4.2) — seed sets proposed; the miss log is the real
   tuning tool. OK to start generous?
