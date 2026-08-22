---
title: Unruh
topics: [architecture, unruh]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: architecture-doc
    type: file
    path: docs/architecture.md
  - id: unruh-design
    type: file
    path: docs/unruh-design.md
  - id: phylactery-design
    type: file
    path: docs/phylactery-design.md
  - id: naming-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/6ad1c817-Naming_a_new_entitycore_module.txt
    note: "Founding conversation that named Thalamus and, in its second half, designed 'temporal-core' — the direct design precursor to Unruh — including the reasoning against a cronjob/heartbeat checklist model."
  - id: temporal-core-design
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/524975aa-temporalcoredesign_1.md
    note: "Standalone temporal-core design document produced from the same conversation, predating Unruh's in-tree implementation."
  - id: fable-review-conversation
    type: conversation
    path: /root/.claude/uploads/9d416675-4103-58c0-a09c-13cae19d1269/2acdb806-Welcome_to_Claude.txt
    note: "Later review conversation with Claude Fable 5 in which the maintainer articulated two framings for Unruh's schedule and threat mechanics that are not yet reflected in code or docs/unruh-design.md."
  - id: reminders-loop-js
    type: file
    path: reminders-loop.js
  - id: temporal-format-js
    type: file
    path: temporal-format.js
  - id: relative-time-js
    type: file
    path: relative-time.js
  - id: unruh-db
    type: file
    path: unruh/src/unruh/db.py
  - id: unruh-gcal
    type: file
    path: unruh/src/unruh/gcal.py
  - id: gcal-projection
    type: file
    path: gcal-projection.js
  - id: cerebellum
    type: file
    path: cerebellum.js
  - id: server
    type: file
    path: server.js
  - id: causal-chain-spec
    type: file
    path: docs/causal-chain-fix-build-spec.md
  - id: bookmark-migration
    type: file
    path: unruh/src/unruh/migrations/0003_bookmark_surfacing.sql
  - id: interest-py
    type: file
    path: unruh/src/unruh/interest.py
  - id: interest-test
    type: file
    path: unruh/tests/test_interest.py
  - id: thalamus
    type: file
    path: thalamus.js
  - id: audit-mcp-script
    type: file
    path: scripts/audit-mcp-contracts.mjs
  - id: app-js
    type: file
    path: public/app.js
  - id: server-py
    type: file
    path: unruh/src/unruh/server.py
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: tool-surfacing-js
    type: file
    path: tool-surfacing.js
---

# Unruh

Unruh is Proto-Familiar's in-tree Python/uv MCP specialist for temporal context: schedule,
interests, handoff between sessions, ponderings, and threat level [@claude-md] [@unruh-design].
Where [Phylactery](phylactery) holds who the Familiar is, Unruh holds how time flows around
them and what they are currently oriented toward within that time — the design document
frames this as the difference between time as coordinates ("it is 10:07") and time as lived
context (what today means, what yesterday left unresolved) [@unruh-design]. Unruh's schedule
graph is the concrete data layer behind [temporal assurance](../concepts/temporal-assurance):
its nodes hold what is happening and when, and its `requires`/`depends_on` edges hold what a
future event still needs before it arrives. Unlike Phylactery,
Unruh is not routed through the canonical store: it is the one named exception in the
[multi-embodiment model](../concepts/multi-embodiment), because ponderings and much of the
schedule are per-embodiment rather than facts about the entity's identity [@claude-md].

Thalamus spawns Unruh as a stdio MCP child alongside Phylactery, matching the same in-tree
specialist pattern (own `./data`, `uv sync` materialization, reconnect/backoff, clean EOF
shutdown, a hard off-switch) that Unruh itself pioneered before Phylactery adopted it
[@architecture-doc] [@phylactery-design].

## Two subsystems: schedule and interest

Unruh's design separates two layers that update at different rhythms [@unruh-design]:

- **The schedule layer** is the *shape* of time — events, tasks, phases, and states as
  graph nodes, connected by edges that carry meaning rather than just ordering: `causes`,
  `requires`, `depends_on`, `blocks`, `carries_forward` [@unruh-design]. An interview
  tomorrow casts anxiety backward into today; unfinished laundry carries an obligation
  forward — a flat timestamp table cannot represent that, but a graph can [@unruh-design].
  These edges are authored from both directions: a human draws them in the Schedule tab's
  Map view, and the Familiar draws them with the `schedule_link` tool when it notices a
  relationship [@unruh-design].
- **The interest layer** is the *texture* of time — what the Familiar is currently oriented
  toward. Weight accrues from signals the system can observe directly rather than from
  asking the LLM to self-report: token volume per topic, topic persistence across
  consecutive messages, and a topic surviving a session boundary are all measured
  structurally; explicit bookmarks are a supplementary, not primary, signal
  [@unruh-design]. Weight decays with time, so a one-off curiosity fades toward background
  noise while a persistent interest compounds — this decay is described as the mechanism
  that keeps the interest graph honest rather than accumulating noise indefinitely
  [@unruh-design]. **Standing values** (caring about the ward's wellbeing) are the
  exception: they do not decay, are anchored in Phylactery as identity-level facts, and are
  expressed in Unruh as always-active orientations, so the Familiar's priorities cannot
  drift just because a value has been quiet for a while [@unruh-design].

## Bookmark resurfacing and the M8 feedback loop

Migration 0003 added four columns to the interest graph's bookmark nodes —
`last_surfaced_at`, `last_surfacing_outcome`, `resurface_after_hours`,
`consecutive_ignores` — plus a comment spelling out an adaptive resurfacing rule: an
engaged bookmark's interval should grow, an ignored one should shrink, and repeated
ignoring should nudge the parent topic's weight down [@bookmark-migration]. `thalamus.js`'s
`reportSurfacingOutcomes()` runs after every chat turn that surfaced a bookmark: it scans the
response text for the bookmark's or its topic's label, calls that an `engaged`/`ignored`
outcome, and calls `interest_report_surfacing_outcome` on Unruh with the result
[@thalamus]. `server.js` fires it from every streaming and non-streaming reply path
[@server], and the Tomes/bookmarks UI renders the stored outcome as a badge on each
bookmark [@app-js].

For about three weeks after the 2026-07-25 commit that added the migration, the JS caller,
and the UI badge, the Unruh side of this loop did not exist: no `@mcp.tool` named
`interest_report_surfacing_outcome` was ever implemented [@audit-mcp-script]. Every call from
`reportSurfacingOutcomes()` threw, and `thalamus.js` swallowed the error into a `console.error`
line rather than surfacing it [@thalamus] — a correct application of graceful degradation (see
[Engineering conventions](../reference/engineering-conventions)) for a peer being down, but it
also meant a fully scaffolded feature ran on every turn, always failed, and never told anyone.
No test crossed the JS→Python boundary to catch the missing tool, and the migration's own
comment read like a finished plan, so later sessions that saw the columns, the caller, and the
badge reasonably read the feature as wired. There is no data-loss or safety caveat attached to
this gap — it is a feature that was scaffolded and then never finished, not a regression — but
it is the concrete case behind
[Cross-language MCP contracts: a silent-failure bug class and its gate](../reference/engineering-conventions),
which records the bug class and the permanent gate that now catches a missing tool like this
one before it ships.

The recorder is now implemented as `report_surfacing_outcome()` in `unruh/src/unruh/interest.py`,
following the migration's own rules: an engaged outcome multiplies `resurface_after_hours` by
1.5, capped at 168 hours (one week); an ignored outcome multiplies it by 0.75, floored at 4
hours; and three consecutive ignores nudge the bookmark's parent topic's interest weight down
[@interest-py]. It is covered by `unruh/tests/test_interest.py` [@interest-test].

### Closing the other two gaps: selection and creation

Recording an outcome is only the third of three steps a bookmark needs to actually resurface —
and a 0.10.107–0.10.109-alpha session (an intra-MCP audit of the whole loop, not just the
recorder) found the other two were still missing, so the fully-scaffolded feature (DB columns,
recorder, JS consumer, UI badge) had run on an empty shelf the whole time:

- **Selection.** `temporal_context` — the tool that builds every turn's `[Temporal Context]`
  block — never SELECTED due bookmarks at all. The fix adds `interests.due_bookmarks(conn)`
  [@interest-py]: never-surfaced bookmarks first, then most-overdue by `resurface_after_hours`,
  capped at `DUE_BOOKMARKS_LIMIT=2`, stamping `last_surfaced_at` on selection so each bookmark
  respects its own adaptive interval. `temporal_context` gained a `mode` parameter and returns
  `bookmarks` only when `mode == 'idle'` — a free cycle, never mid-conversation
  [@server-py]. thalamus already sent `mode='idle'` once past `IDLE_THRESHOLD_MS`, but the tool
  had no `mode` parameter to receive it, so pydantic silently dropped the argument and idle
  gating never engaged — a fresh instance of the exact silent-arg-drop class
  [Cross-language MCP contracts: a silent-failure bug class and its gate](../reference/engineering-conventions)
  exists to catch.
- **Creation**, the deeper gap, found only by auditing reachability rather than argument names:
  the Unruh tool `interest_bookmark` existed but nothing called it — no JS wrapper, no
  Familiar-facing tool, no HTTP endpoint. A bookmark could never be created in the first place,
  so selection and recording had nothing to operate on. This is the "capability that isn't
  reachable by the Familiar" anti-pattern (see
  [Engineering conventions](../reference/engineering-conventions)), just applied to the write
  side of a feature instead of a single tool. The fix adds `saveBookmark()` in `thalamus.js`
  [@thalamus] and a first-person `bookmark_for_later` builtin in `cerebellum.js`
  [@cerebellum-js], surfaced through the `CORE` tool-surfacing module — the same always-on
  bucket as `interest_bump` and `interest_set_standing` — rather than a trigger-gated module,
  because the Familiar reaches for it on its own initiative; nothing in a user message triggers
  a save the way a search result triggers `mem_delete` [@cerebellum-js] [@tool-surfacing-js].

With both halves closed, the M8 loop runs end-to-end: `bookmark_for_later` creates a bookmark,
`due_bookmarks` selects it once due during an idle cycle, `reportSurfacingOutcomes()` records
whether the ward engaged, and the adaptive interval it produces feeds back into the next
selection.

## Origin: a schedule, not a cronjob checklist

Before it existed in-tree, Unruh's design was worked out under the working name
**temporal-core**, in the same founding conversation that named
[Thalamus](../decisions/thalamus-naming) — the design document that resulted is the direct
precursor to what shipped [@naming-conversation] [@temporal-core-design]. The document frames
temporal-core's job exactly the way Unruh's schedule layer now works: nodes for events, tasks,
phases, and states, connected by edges (causes, requires, depends on, blocks, carries forward)
that hold meaning a flat table cannot [@temporal-core-design].

The reasoning for why this is a graph the Familiar orients within, rather than a fixed-cadence
checklist, traces to a specific complaint about OpenClaw's cronjob/heartbeat model: "I feel like
OpenClaw's cronjobs regularly super overwhelm Eurylochus" [@naming-conversation]. The diagnosis was
that the problem was never the *format* of a cronjob's output — it was the timing and volume of
the injection. A cronjob firing mid-conversation demands several things at once (review goals,
update memory, assess emotional state, log context) with no human turn to anchor them, which was
described as "cognitively similar to being interrupted mid-sentence by someone handing you a
checklist" [@naming-conversation]. Marinara-Engine's Conversation mode was named as the contrasting
model worth stealing from: characters there carry a generative schedule tied to their own local
timezone, so the difference is "it is now 3pm, run these tasks" versus "it is 3pm on a Tuesday, [the
character] has been awake since morning, [they]'d probably be doing X right now" [@naming-conversation].
This is the origin reasoning behind why [Autonomous loops](autonomous-loops)' pondering loop ticks
on a tiered interest-weight-and-threat cadence rather than a fixed interval, and why Unruh's
schedule layer holds named routine phases instead of a task list to clear.

The document also names the language choice made for temporal-core before Unruh existed — Python,
for its richer graph and time-aware tooling ecosystem — which is the same choice Unruh, in fact,
shipped with as an in-tree Python/uv service [@temporal-core-design].

## Time model: local-naive, not UTC

Every Unruh timestamp (`when_ts`, `end_ts`, `now_iso`, …) is stored and compared as the
ward's local wall-clock time with **no** timezone offset — a deliberate reversal of an
earlier UTC-internal design [@claude-md] [@unruh-design]. The reason is CLAUDE.md's broader
rule that the LLM must never be trusted to compute or format an exact machine value (see
[Exact values are code's job](../decisions/exact-values-in-code)): asking the model to
convert the ward's local time to UTC on write meant the model was the conversion boundary,
and it kept getting it wrong in both directions [@claude-md].

Two real incidents motivated the fix:

1. **The reminder timezone bug (0.7.84).** The schedule tools asked the model to convert
   local time to a UTC-offset string on write. It stored a naive local time that the old
   UTC-based comparison never matched, so a reminder scheduled fine, showed as fired, and
   silently never delivered — no error, no chime [@claude-md]. Local-naive storage deletes
   this class of bug: the Familiar writes plain local time, and `now` is read live from the
   system clock so DST is handled by the OS rather than by model arithmetic
   [@unruh-design].
2. **"Local" turned out to mean the *server's* local, not the ward's (0.7.86).** The first
   local-naive implementation read `now` from the server process clock, which is only
   correct when the server happens to run in the ward's own timezone. A server running in
   UTC (WSL, Docker, a hosted box) with a PDT ward fired every reminder immediately — the
   mirror image of the first bug [@claude-md]. The fix makes the ward's zone explicit
   instead of assumed: the browser auto-captures its IANA timezone into a synced
   `wardTimeZone` setting with no ward-facing configuration required, the safety-critical
   firing path computes ward-local "now" in Node via `wardLocalNowISO(wardTimeZone)`, and
   thalamus spawns the Unruh child with `TZ=wardTimeZone` as a catch-all for Unruh's own
   internal stamps [@claude-md]. An unset `wardTimeZone` falls back to server-local
   behavior, so a co-located single-machine install is unaffected [@claude-md].

The one accepted trade-off is a bounded DST edge case: a timestamp that falls inside the
spring-forward gap or the fall-back overlap is ambiguous, roughly ±1 hour, twice a year
[@unruh-design]. Pre-migration UTC-stored rows are healed once by `db.migrate_timestamps_to_local`
on first connect [@unruh-design]. By 0.9.0, this local-naive model extends end-to-end through
the temporal editor in the browser, closing a final UTC round-trip where the browser converted
to Z-strings that the server seam converted straight back.

### Healing malformed schedule times

Some rows slipped through the one-time UTC migration, chiefly legacy date-less, offset-stamped
times like `'T13:00:00+00:00'` (with no calendar date) that `datetime.fromisoformat` cannot parse
[@unruh-db]. These are now repaired by `heal_malformed_schedule_times()` which runs on every
database connection. The healer is idempotent by design: it only rewrites values that actually
change, so a healed row is never touched again and there is no flag to set prematurely — which
is exactly why these artifacts survived the one-time flag-gated migration [@unruh-db]. The
healer is cheap (schedule nodes number in the dozens) and firing-neutral: it makes stored times
more correct, never changes which items fire or when [@unruh-db].

The healer salvages the wall-clock HH:MM from unparseable legacy times by anchoring them to the
node's `created_at` date (with offset dropped) — routine phases are the ward's local wall-clock,
not absolute times [@unruh-db]. A display-level salvage pass, `formatLocalTime` in the temporal
briefing, complements the db-level healer for any time still unparseable at render [@temporal-format-js].

## Reminders and threat both ride the same "decaying persistent variable" shape

Threat level — the scalar that drives silence-triage urgency (see
[Safety spine](safety-spine)) — is stored in Unruh as a persistent decaying variable,
structurally identical to interest weight: it rises on detected signals, decays over time,
and functions as a parameter that changes how soon triage checks in, never as the decision
itself [@unruh-design]. The actual reach-out-or-wait judgment always goes through an LLM call
reading full context; threat level only shapes how urgently that judgment is sought.

## Design framing: a reminder is a kept promise, not a scheduler firing

`reminders-loop.js` fires mechanically — it walks the schedule graph every 30 seconds for
reminder nodes whose `when_ts` has arrived and enqueues them, with no LLM call and no
judgment in that tick at all [@reminders-loop-js]. A framing worked out in a later review
conversation, not yet written into the code or `docs/unruh-design.md`, describes why that
mechanical firing is still safe to treat as the Familiar's own action rather than external
scheduling machinery acting on the Familiar's behalf: the schedule node was created earlier by
a real decision — a chat turn or a `schedule_add` tool call the Familiar itself made, stamped
with a timestamp — and the reminders loop does not decide to contact the ward, it keeps a
promise the Familiar already made to itself [@fable-review-conversation]. The proposed
first-person framing is "the reminders loop never decides to contact you; it keeps a promise
Eury already made," offered as the reason a purely mechanical, judgment-free tick does not
violate [Proactivity over caution](../decisions/proactivity-over-caution)'s standard for when
the Familiar may act: the judgment already happened, at write time, and firing is just
follow-through [@fable-review-conversation]. This is a design lens on already-shipped behavior,
not a code change.

## The consequence-graph milestone (0.8.107–0.8.108): causal-chain fix

Events can be related by consequence edges — "I predicted this would cause that," "I'm anxious
about tomorrow so I'm prepping today" — but for months, those edges existed in the data layer
without being visible when the Familiar most needed them: before writing a forecast (will my
earlier effort matter?) and after making a forecast (did it play out?) [@unruh-design]. The
defect and its four-part fix shipped across 0.8.107-alpha (PR #218, pieces 1–3) and 0.8.108-alpha
(pieces 4, with ward sign-off):

**Piece 1: Gathering projection candidates.** `gatherProjectionCandidates()` (in
`gcal-projection.js`) unions Unruh's scheduled `gcal_projection` flags with *any* bare upcoming
event in the briefing window that is unresolved, carries no consequence edges yet, and has at
least 6 hours of runway (MIN_LEAD_MS = 6h) [@gcal-projection]. The `gcal_projection` flags
come from the ward explicitly marking which calendar events matter for the Familiar's reasoning;
the bare-event pass catches hand-added schedule nodes or chat-created events that lack those
marks but deserve projection. The projection candidates are paced through the existing cue-state
system (`tomes/.gcal-projection-cue.json`) rather than per-node payload cooldowns, so both
sources share one pacing regime [@gcal-projection]. Items whose projection window has aged out
get a single last-chance re-surface within 48 hours of their event (LAST_CHANCE_MS = 48h),
ward-approved decision 2 — the only opportunity to mark them before they slip past [@gcal-projection].

**Piece 2: Surfacing recently-past hindsight questions.** `temporal-format.js` renders a new
"Recently past, not yet examined" block for events in the window [now − 72h, now] that carry
ungraded consequence edges (edges where the `observed` field is not yet true, meaning the
Familiar made a forecast but has not yet recorded whether it came true) [@temporal-format-js].
This block surfaces the edges as hindsight questions the Familiar can answer: "I projected:
[source] → [verb] → [destination]. Did that follow?" (edge: `edge-id`). The block is capped at
3 lines to keep it scannable [@temporal-format-js]. Before this fix, consequence edge ids were not
actionable from the chat at all — the design principle "a hindsight question whose answer can't
be recorded is theater" [@temporal-format-js] made this gap a reachability bug.

This is paired with a new tool: **`schedule_calibrate_link`** (in `cerebellum.js`), routed
through the `schedule-write` module, allows the Familiar to grade a consequence edge inline
from chat — recording `observed: true` if the forecast came true, or adjusting `certainty`
up/down if the outcome was partially or surprisingly different [@cerebellum]. The tool is
triggered by the cue + hindsight block markers in the temporal briefing.

**Piece 3: Widening the reflection window.** `server.js`'s `getReflectionInput()` function
widened the schedule-fetch window from the default centred-on-now (~24h) to ward-local
−7d..+2d, since the grading moment always scrolled past the original window [@server].
Each graded edge now carries `from_when` (the node's timestamp it was graded from), so future
passes can distinguish edges graded fresh from those resolved long ago [@unruh-db].

**Piece 4: Elapsed stamping (0.8.108, ward-signed).** Past events remain unresolved until the
ward acts on them, creating ambiguity between "pending" and "past but unexamined." The fix stamps
`payload.elapsed_at` on one-off `type='event'` nodes that have passed their end time by more than a
ward-configurable threshold (setting `elapsedStampHours` in the event-alerts section, default **24 hours
after event end**, clamped 1–720h) with no resolution recorded [@causal-chain-spec]. The stamp is an
observation, never a resolution: the node stays unresolved, all tools still work, nothing is hidden.
Recurring anchors (payload.recurrence) and need-windows (payload.need) are excluded — their pasts are
tracked per-occurrence by the recurrence and needs ledger respectively [@causal-chain-spec]. The pass is
idempotent and rides the reminders tick with an hourly self-gate; it can be disabled with
`PROTO_FAMILIAR_ELAPSED_STAMP_DISABLED=1`. Display consumers move an elapsed-stamped event out of "Coming
days" into a separate briefing group ("Past events with no word on how they went — still open, not
forgotten"), and the piece-2 hindsight line tags it `[never marked done]` [@causal-chain-spec].

## Design intent: plan review and baseline as a decaying process, not a snapshot

Two related ideas from the same conversation address a gap neither `docs/unruh-design.md` nor
the shipped code currently names, and neither is implemented [@fable-review-conversation]:

- **Plan review.** A standing reminder plan made on a good day can be wrong by the time it
  fires — the worked example is a reminder schedule set up on a clear-headed day that no longer
  fits once brain fog has set in. The proposed fix is a low-frequency cognitive pass that
  re-reads standing schedule promises against the ward's current state and amends them through
  the normal schedule tools, explicitly *not* by re-deliberating every reminder at fire time —
  that would violate [Engineering conventions](../reference/engineering-conventions)'s
  ride-existing-requests, gate-in-code rule by turning a cheap mechanical tick into a
  per-reminder LLM call [@fable-review-conversation].
- **Baseline as metabolism, not setup.** Threat level already decays as a persistent variable
  (see above), but the conversation proposes treating the ward's own "baseline" — what counts as
  normal for them — the same way: a continuously-decaying process rather than a one-time
  two-week calibration phase. The named failure mode this guards against is a "frog-boiling"
  case: a person whose state is slowly declining drags their own baseline down with them, so
  deviation-from-baseline scoring never fires because the baseline always catches up. The
  proposed guardrail is anchored reference snapshots — the original two-week baseline plus
  periodic, explicitly-tagged "good day" markers — compared against the current, decaying
  baseline, rather than scoring only against recent history [@fable-review-conversation].

Neither mechanic exists in `threat-tracker.js` or the schedule tools today; both are recorded
here as unshipped design intent so a future implementer does not have to re-derive the
frog-boiling failure mode from scratch.

## Google Calendar adoption: merging hand-added nodes

The [Autonomous loops](autonomous-loops) Google Calendar sync loop reconciles schedule nodes
by UID. A hand-added node (created by the ward directly in the schedule) has no `gcal_uid`,
so uid-keyed reconcile never matches it — when the same event is later synced from Google
Calendar, the sync would create a parallel second node instead of recognizing the existing
one [@unruh-gcal]. This was the root cause of the "one 📅 twin + one plain twin" duplicate
pairs.

The fix, `_adopt_hand_added_twin()`, runs before `gcal_ingest` creates a new node
[@unruh-gcal]. It looks for an existing schedule node with the exact same title and exact
local-naive time, no `gcal_uid` (not already synced), and no resolution (unresolved). If found,
the adoption merges the nodes: the node keeps its id and consequence edges, and gains the sync
payload (`source='gcal'`, the uid, and related metadata), so from the next sync forward it is
the one managed node for that event [@unruh-gcal]. The match is strict (title and time must be
exact, both unresolved, not already synced) to prevent genuinely-distinct items from being
conflated [@unruh-gcal].

This is the data-layer adoption. The display layer already had two redundant dedup passes
before this fix: `dedupe_gcal_nodes` (gcal-vs-gcal dedup) and `display-level dedup` in the
temporal briefing (display-time exact-duplicate suppression) — those remain and still serve as
safeguards [@temporal-format-js] [@unruh-gcal].

## The temporal briefing display: pure derivation, safe to edit

The `[Temporal Context]` block that appears in every turn's prompt is built from Unruh's schedule graph via `buildTimeAnchorBlock()` in `relative-time.js`, then formatted for readability by `temporal-format.js` [@temporal-format-js] [@relative-time-js]. This display layer is pure derivation — all transformation, no new data — so changes to display hygiene, filtering, or formatting are safe to make without ward sign-off [@claude-md].

The display pipeline applies three filters and a dedup pass to the raw schedule events [@temporal-format-js]:

1. **Cancellation filter** — Cancelled items leave the briefing entirely. A cancelled event produces no line.
2. **Recency filter for resolved items** — Resolved items (status="completed" or "cancelled") show only if their `updated_at` is recent (within 12 hours). Old resolved items disappear from briefing after enough time has passed.
3. **Phase-marking and time formatting** — Non-current phases are marked with "· begins in …" / "· ended … ago" to distinguish them from active phases. Times are formatted via `formatLocalTime`, which salvages a wall-clock HH:MM from unparseable or legacy time strings (it drops timezone offsets and falls back to the time alone). This was added to handle pre-migration UTC-stored artifacts and buggy UTC-to-local conversions from earlier versions [@temporal-format-js] [@claude-md].
4. **Timed-item split** — Items with a specific time are split into "Still to come today" (today's tasks) vs "Coming days" (later dates), while all-day or time-unspecified items remain grouped together.
5. **Display-level dedup** — Exact duplicate detection at the display level (a separate pass from data-layer dedup). This handles cases like a Google-synced node plus a hand-added identical task showing up in both the schedule and a manual entry — one is shown, duplicates are suppressed [@temporal-format-js].

All of these are transformation-only; no events are deleted or modified in the underlying data. The Temporal Context block is a view, not a mutating operation. A change to any of these filters is safe for the same reason weather display changes are safe: it is pure code-side derivation, not a decision point that changes the Familiar's reasoning [@claude-md].

## Related

- [Phylactery](phylactery) — the canonical store Unruh deliberately sits outside of.
- [Safety spine](safety-spine) — how threat level, silence-triage, and escalation are wired
  together downstream of Unruh's data.
- [Exact values are code's job](../decisions/exact-values-in-code) — the general principle
  the local-naive time model is one instance of.
- [Naming Thalamus: mediator, not generator](../decisions/thalamus-naming) — the founding
  conversation Unruh's design (under the working name temporal-core) grew out of alongside
  Thalamus.
- [Autonomous loops](autonomous-loops) — the pondering loop's tiered cadence, the shipped
  alternative to a fixed-interval checklist.
- [Engineering conventions](../reference/engineering-conventions) — the cross-language MCP
  contract bug class the bookmark-resurfacing gap above is the worked example of, and the
  permanent gate that now catches a missing or misnamed tool call before it ships.
