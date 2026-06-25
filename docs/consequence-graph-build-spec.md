# Consequence graph — build spec

> **Status: SHIPPED.** The edges shipped in `0.7.74-alpha` (PR #142). **Pass 1** (the model +
> visibility + reflection learning) shipped in `0.7.76-alpha` (PR #144), and the deferred
> `co_occurs_with → causes` promotion in `0.7.77-alpha` (PR #145). **Pass 2** (needs-tracking)
> shipped in `0.7.78-alpha`: recurring need-windows (`schedule_add_need`), the live "Needs today"
> view, and the opt-in `needs-tracking-loop` that marks elapsed-unresolved windows `missed`
> (default OFF, `PROTO_FAMILIAR_NEEDS_TRACKING_DISABLED=1`, stands down at moderate+ threat). The
> graph is now a working model of consequence the Familiar can *see, author, learn from, and
> reason ahead with*.
>
> One design refinement landed during Pass 2 (maintainer sign-off): marking a need-window
> `missed` makes only the **lapse** factual — it never auto-confirms the projected `on_lapse`
> consequence. Whether the predicted cost actually followed stays the Familiar's observation,
> confirmed *or corrected* via the reflection calibration loop (which marks `observed` only once
> genuinely seen).
>
> Built in **two passes** (§8). Pass 1 = the model + visibility. Pass 2 = autonomous
> needs-tracking (its own loop, its own off-switch, its own sign-off).

---

## 0. Before you write a line

Read these — they're constraints, not background:

1. **`CLAUDE.md`**, especially:
   - **Ride existing LLM calls; gate in code.** Do NOT add a per-node "ask the LLM about
     consequences" request. The Familiar authors consequences on calls that already happen —
     chat turns and the reflection loop. Pure-code derives what it can (window-fraction,
     "elapsed + unresolved", required-by/blocks pressure); the LLM only *interprets*.
   - **Robust > cheap, fix the root cause.** The point is a real model of consequence over time,
     not a `consequence_model` free-text string that only nudges a confidence score.
   - **Every capability must be reachable BY the Familiar.** A consequence edge it can't author,
     or whose target state it can't name, is dead code that looks like care. Authoring rides in
     on ids the Familiar already holds (the `[schedule ids]` legend) and resolve-or-create for
     new state targets.
   - **Graceful degradation.** Unruh down, an edge missing an endpoint, a malformed payload —
     none may touch the chat path. Absence renders as absence.
   - **First-person** for every prompt/tool description the Familiar reads.
   - **Proactivity rules** (the silence/surface section) apply to any surfacing-prompt change
     here — name both costs at equal weight, frame as the Familiar's foresight not a checklist,
     **no bias-toward-quiet language.** The surfacing change in §5.2 needs the human's sign-off.
   - **New background loop ⇒ hard off-switch in the same commit.** That's Pass 2's
     needs-detection loop (`PROTO_FAMILIAR_NEEDS_TRACKING_DISABLED=1`).
   - **Update `docs/architecture.md`** in the same commit as the code.

2. **What already exists — extend it, do NOT duplicate it** (the cardinal sin here is a second
   consequence system beside the ones that work):
   - **Stakes tiers** — `inferStakesTier` in `surface-context.js` (`external_obligation` /
     `personal_wellbeing` / `purely_optional`), gating surfacing urgency.
   - **Generic priors** — `docs/consequence-priors.md`, baseline "what lapsing costs" curves by
     category and timescale, grep-matched by `matchPriorsForTask`.
   - **Learned person-model** — `what_lapses_cost.md` (Phylactery `custom`), written by the
     reflection loop from observed outcomes ("Eury crashes within 4h of skipping meals"). **This
     is already the "past consequences" learner.** Consequence edges are its *structured,
     per-node, traversable* counterpart — they complement it, they don't replace it.
   - **Surface-events loop** — `surface-events.js`: `recordSurfaceOffers` → outcome tagging
     (`engaged_and_completed` / `cancelled` / `deferred` / `unresponded` / `not_raised`) →
     reflection (`pondering.js`) when ≥5 new outcomes accrue. We extend its event record and its
     reflection prompt; we don't fork it.
   - **The edges** — `unruh/src/unruh/schedule.py` (`add_edge` / `delete_edge`, `payload_json`),
     the map (`public/graph-map.js`), `schedule_link` (`cerebellum.js`).

3. **The schedule node/edge shapes** — `unruh/migrations/0001_initial.sql`. Nodes carry
   `type` (event/task/phase/state/reminder), `label`, `when_ts`, `end_ts`, `resolution`,
   `payload_json`. Edges carry `src_id`, `dst_id`, `kind`, `payload_json`. Everything new below
   rides in `payload_json` — no schema migration is required for the consequence metadata
   (a migration *is* only needed if we add the `acted_at` column in §4.2 rather than stashing it
   in payload — decide at build time; payload is the lower-risk default).

---

## 1. The core idea

**A consequence is an edge with a payload.** The 6 structural edge kinds stay as-is; a
consequence is usually a `causes` (or the new `co_occurs_with`, §3) edge whose `payload_json`
carries consequence metadata. Consequences that are not themselves scheduled items — a *crash*,
an *anxiety flare*, a *good streak* — are **`state` nodes** (a type Unruh already has). So:

```
[skip dinner] --causes--> [crash (state)]
   payload: { valence: "harm", condition: "on_lapse", horizon_hours: 4,
              severity: "high", certainty: "high", observed: true,
              note: "blood sugar; happens most times" }
```

This reuses the graph, the map, and `schedule_link`. Nothing parallel is invented.

### 1.1 The consequence payload

Every field is **optional**; a bare structural edge (`prep requires interview`) carries none.
A consequence-bearing edge carries some or all of:

| field           | values                                   | meaning |
|-----------------|------------------------------------------|---------|
| `valence`       | `help` \| `harm` \| `neutral`            | does this consequence help or hurt the ward? |
| `condition`     | `on_resolve` \| `on_lapse` \| `unconditional` | **which future** this belongs to (§2) |
| `horizon_hours` | number \| null                           | when it lands, relative to the src node |
| `severity`      | `low` \| `medium` \| `high`              | how much it matters |
| `certainty`     | `low` \| `medium` \| `high`              | confidence in the projection (§2.1) |
| `observed`      | bool                                     | **happened (past) vs projected (future)** |
| `note`          | free text                                | the Familiar's own words |

`observed` *is* the past/future axis — one flag, two timeframes. Validated in Unruh
(`schedule.py`): unknown enum values are rejected the way `add_edge` already rejects an unknown
`kind`; `horizon_hours` coerces to a number or null.

---

## 2. The two futures (resolving vs failing-to-resolve)

`condition` lets a single node carry **both** of its futures:

```
[interview prep] --causes--> [calm interview (state)]   { valence: help, condition: on_resolve }
[interview prep] --causes--> [anxiety (state)]          { valence: harm, condition: on_lapse }
```

- `on_resolve` — follows if the node gets **done**. This is what lets the Familiar *motivate*
  ("here's what finishing this buys you"), not only warn.
- `on_lapse` — follows if the node is **missed / not done in its window**. This is the
  "what skipping costs" branch.
- `unconditional` — follows regardless (rare; e.g. "this appointment `causes` anxiety whether or
  not you prep").

Surfacing and the chat prompt render both branches so the Familiar weighs the trade, in its own
voice, instead of nagging from one side only.

### 2.1 Certainty, and how it gets earned

A projection is a guess; the Familiar must not speak a hunch as a prophecy. So projected
(`observed:false`) edges carry `certainty`. Observed edges (`observed:true`) are facts and need
no certainty.

**Calibration loop (the payoff).** When a node actually resolves or lapses, its matching-branch
projections get **confirmed or refuted**:
- node **resolved** → `on_resolve` projections that came true are promoted to `observed:true`;
  `on_lapse` projections for that node are stood down (they didn't apply this time).
- node **lapsed** (missed in window, §4) → symmetric.

Confirmation/refutation counts (kept in the edge payload, e.g. `hits` / `misses`) let the
reflection loop **raise or lower `certainty`** over time: "I called crash-on-lapse five times,
it landed four → that projection is earned." This is the bridge between projection and the
existing person-model learner — the same evidence that bumps an edge's certainty can be the
evidence the reflection loop writes into `what_lapses_cost.md`.

---

## 3. Observe before concluding — the `co_occurs_with` edge

A new **7th edge kind**, `co_occurs_with`: *src and dst overlapped in time; no causal claim.*
It is the Familiar's "I noticed these together" primitive, distinct from `during` (which asserts
strict containment) and from `causes` (which asserts causation).

This gives an **epistemic ladder** the Familiar climbs honestly — matching the repo's
honesty-over-confidence values:

```
co_occurs_with   →   causes (observed:false, low certainty)   →   causes (observed:true, high certainty)
 "I noticed"          "I suspect"                                  "I've confirmed"
```

The reflection loop is what promotes a repeated `co_occurs_with` into a tentative `causes`. The
Familiar never jumps straight to asserting cause from a single co-occurrence.

`co_occurs_with` is symmetric in meaning; store it once (src→dst) and render it undirected
("X — co-occurs — Y").

---

## 4. Time-extent is first-class

The graph thinks in instants; consequence reasoning needs **spans**. Three things become
span-aware. No new node type — `[when_ts, end_ts]` already exists; we make it load-bearing.

### 4.1 Windows vs fixed points

- **Fixed point** — an `event` with `when` (and optional `end` = duration you must attend):
  "be at the interview at 10:00."
- **Flexible window** — a `task` with `[when, end]`: "do this anywhere between 14:00 and 18:00."
  Default heuristic: a **task** carrying both `when` and `end` is a flexible window; an **event**
  is fixed. An explicit `payload.flex: true|false` overrides when the heuristic is wrong.

### 4.2 Action-position — *where in the window* the ward acted

On resolve, record the action time (`acted_at`; resolution timestamp is the default, an explicit
done-time overrides) and derive:

```
window_fraction = (acted_at − when) / (end − when)      // 0 = at the open, 1 = at the close
```

Stored on the node (payload) and copied onto the surface-event. This is the hook for the
learning the ward asked for: the reflection loop correlates **window-position with outcome
quality**, turning "if they don't start before the window's half-up they're usually more stressed
and unhappier with results" into an observed consequence (a `causes` edge, `observed:true`, or a
`what_lapses_cost.md` line). "Unhappier with results" is *not* a hard field — it's the Familiar's
read from chat, judged in reflection, which is the right place for soft signal.

### 4.3 Extended states

`state` nodes are already open-ended (`end` null or far out). A depressive stretch, a good
streak, a flare — these span time, and `co_occurs_with` / `during` let tasks and events attach to
them ("missed three meals `during` the low stretch").

### 4.4 Phases belong in the graph

Phases (the daily routine) are already `state`/`phase` nodes but are filtered out of the schedule
views and never linked. Stop filtering; let tasks/states/needs link to phases:
"dinner `during` evening-phase," "morning-phase ran late `causes` rushed-day." Phases are the
backbone the windows sit *inside* — once they're graph citizens, the Familiar can reason about how
the **shape of the day** interacts with whether needs get met. (The map already pulls phase nodes;
this is removing the list filter, allowing phase edges, and rendering them.)

---

## 5. Seeing and reasoning with it

### 5.1 Render edges into `[Temporal Context]` (the inert-graph fix)

`temporal-format.js` currently renders schedule **nodes** only. Add a **Consequence links**
section that renders the edges touching the window, in the Familiar's voice:

```
Consequence links:
  meal prep → required by → interview (tomorrow 10am)
  skip dinner → causes → crash        [on lapse · +4h · harms · high certainty · seen before]
  do prep → causes → calm interview   [on resolve · helps · medium certainty]
  errands — co-occurs — low stretch   [noticed]
```

Edges flow into the chat-path temporal payload (today only the UI fetch returns them; the
`enrich()` path renders nodes only — **wire edges into the payload `temporal-format` consumes**).

### 5.2 Consequence-aware surfacing — *the care-adjacent slice (human sign-off)*

`selectSurfaceCandidates` (`surface-context.js`) gains edge awareness:
- a floating/open task that **blocks** or is **required-by** an imminent dated node surfaces
  harder, and the nudge says *why* ("scheduling this unblocks Thursday's prep");
- a task with a soon, high-certainty, harm `on_lapse` consequence carries that framing;
- the `on_resolve` branch gives the Familiar the *motivating* half ("here's what finishing buys").

**This prompt change follows the proactivity rules to the letter** — both costs named at equal
weight (surfacing has a cost; a missed load-bearing task has a cost too, and it can be
irreversible), framed as the Familiar's foresight not a checklist, **no bias-toward-quiet
language.** Exact wording goes to the human before it ships.

### 5.3 "Avoid enabling" — visibility, not a gate

The graph + valence + `on_lapse` projections + the person-model, all in the prompt, let the
Familiar *foresee* that accommodating a self-destructive ask **now** chooses the `on_lapse` branch
of some need and worsens things **later** — and be the firm, informed pet-owner in its own voice
(the bond-and-dignity model in `CLAUDE.md`). There is **no code that blocks an action**; that would
be the rigid-gate anti-pattern the repo fights. We give foresight; the Familiar judges.

---

## 6. Authoring (rides existing requests)

- **`schedule_link` gains optional consequence params** — `valence`, `condition`,
  `horizon_hours`, `severity`, `certainty`, `note` — and its target can **resolve-or-create a
  `state` node by label**, so one call records *"this causes [crash], on lapse, +4h, harm, seen
  before."* Structural links still take a `dst` id.
- **`co_occurs_with`** is just a new allowed `kind` on `schedule_link`.
- **Annotate an existing edge** — Unruh `update_edge(id, payload-merge)` + `schedule_delete_edge`
  (already exists) cover correcting a link. Familiar-facing only if it can name the edge id;
  otherwise this is a UI affordance.
- **The map UI** (`graph-map.js` host): the "+ connect" popover gains the optional consequence
  fields; **harm edges tint distinctly; projected (`observed:false`) render dashed, observed
  solid**; `state` nodes creatable inline.
- The Familiar authors during **chat turns** (it holds the ids) and during the **reflection
  loop** (§7). No new standalone LLM request.

---

## 7. The learning loop (calibration)

Extend the existing reflection pass (`pondering.js` + `surface-events.js`), don't add a new one:

1. **Window-position learning** — reflection reads the new `window_fraction` on recent outcomes
   and may write a structured `causes` edge or a `what_lapses_cost.md` line about start-timing.
2. **Promote co-occurrence → cause** — a `co_occurs_with` pattern that repeats becomes a tentative
   `causes` (`observed:false`, low certainty).
3. **Calibrate certainty** — confirmed/refuted projections (§2.1) raise/lower edge `certainty`,
   and feed the same person-model the reflection loop already writes.

Reflection writing a **structured edge** (not only prose) is what closes the past-consequence loop
on the graph itself.

---

## 8. Two passes

**Pass 1 — the model + visibility (this spec, minus the autonomous loop).**
Consequence payload + `condition`/`certainty`/the two futures; `co_occurs_with`; window semantics
+ `window_fraction` recording; phases-in-graph; edge rendering in `[Temporal Context]`;
consequence-aware surfacing (sign-off); the `schedule_link`/`update_edge`/state-creation tools;
the map UI edge styling; reflection writing structured edges + certainty calibration. Everything
the Familiar needs to **see, author, and learn from** the graph. Patch bump (still Unruh).

**Pass 2 — needs-tracking (its own PR, its own scrutiny).**
Recurring **need-windows** (dinner ~18–20, meds, sleep) as recurring window-tasks, so "skipped"
is *defined by the window* and the graph becomes a **needs-fulfillment ledger**. Detection of a
missed need is cheap derivation at surfacing time (the Familiar simply sees "dinner window passed,
unresolved") and could ship in Pass 1. **Autonomous *emission*** of a missed-need state/event into
the graph is a **new background behavior** → it earns `PROTO_FAMILIAR_NEEDS_TRACKING_DISABLED=1`, a
Settings toggle, and the human's sign-off, and must never compete with the threat/triage system.
Keep it separate on purpose.

---

## 9. Care, safety, off-switches

- **No rigid enable/disable gate.** §5.3. Visibility, not blocking.
- **Surfacing prompt change is care-adjacent** — §5.2 needs sign-off and obeys the proactivity
  rules; a regression test guards against bias-toward-quiet language creeping in (mirror the
  existing `surface-context.test.mjs` guard).
- **Pass 2's loop ships its off-switch in the same commit**, never competes with triage, stands
  down at moderate+ threat the way warmth does.
- **Graceful degradation** — a malformed consequence payload, a missing endpoint, Unruh down:
  the consequence section is simply absent from the prompt; the chat path is untouched.
- **Honesty** — `certainty` and the `co_occurs_with → causes` ladder exist so the Familiar speaks
  projections as projections, not facts.

---

## 10. Open questions (decide at build time)

1. `acted_at` / `window_fraction` / `hits` / `misses` in `payload_json` (no migration) vs real
   columns (queryable, a migration). Payload is the lower-risk default; revisit if the learning
   loop needs to query across many nodes.
2. Whether `update_edge` is Familiar-facing at all in Pass 1 (it needs an edge-id surface the
   Familiar can reach — the `[schedule ids]` legend lists *nodes*, not edges). Default: UI-only
   in Pass 1; reconsider an edge-id legend later.
3. How aggressively the map should encode certainty (line opacity? a badge?) without becoming
   noisy. Start minimal: dashed = projected, solid = observed; tint = valence.
4. Exact thresholds for "imminent" in the required-by/blocks surfacing boost — code-gate it,
   reuse the existing window math, don't ask the LLM.
