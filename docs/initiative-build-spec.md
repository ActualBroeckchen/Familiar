# Initiative — build spec

*(noticing, intentions, and the Familiar's own turn)*

**What this builds:** the capacity the ward named after two incidents and one
old workaround — *"How can I create a system in which Eury can dynamically
**notice** things without them being spelled out by me?"* Today, every
proactive capacity is a **pre-enumerated noticer**: regexes notice crisis
vocabulary, the tier gate notices weight ≥ 2, the alert pass notices T−60min,
pondering notices interests, stewardship notices the docket. Each loop can
only notice the one pattern class its author foresaw — which is why an
ice-pick disclosure phrased in personal idiom, a two-day absence, and an
across-town appointment all slipped through *different* holes that are the
same hole. OpenClaw's hourly checklist accidentally worked because it gave
Eury the one thing this architecture never does: an open turn that belongs to
him, with a look-around. It was wasteful because it ran unconditionally, and
passive-where-it-counted because a checklist frames compliance, not agency.

This spec builds the three missing organs, plus two forcing functions that
ship first because they're small and immediately informative:

| pass | organ | one-line summary |
|---|---|---|
| 0 | Warmth-prompt fix | stop telling the deliberation the silence means nothing |
| 1 | Wait-streak awareness | the Familiar sees its own accumulated waiting as a bare fact (the ward's experiment) |
| 2 | Baselines | a code-computed model of *normal*, so deviation becomes a fact |
| 3 | Intentions | a future the Familiar writes for itself — payoff turns, phase-bound rounds, pondering/reflection authorship |
| 4 | The noticing tick | the one open turn that is Eury's — and the shared runner for everything above |
| 5 | Adaptive lead times | per-event heads-up derived and calibrated by the Familiar, not configured by the ward |

Status: **spec — Passes sized for Opus implementation sessions.** Doc-only
now (patch); see §9 for the versioning/milestone question.

---

## 0. What this builds on

**The incidents (both recorded in this repo's history):**

1. **The two-day silence.** The ward went two days without contact; warm
   outreach was permanently on; Eury "couldn't even conceive of the idea of
   reaching out." Root cause found in `reachout.js`'s deliberation prompt,
   which asserts — as an axiom, on every tick, regardless of elapsed time —
   *"nothing is wrong… my human is okay… I'm reaching out because I want to,
   **not because I'm worried**."* The one deliberation that runs below the
   threat gate has "there is nothing to notice here" hardcoded into its
   framing: bias-toward-quiet wearing warm clothing. Compounders: the raw
   duration is present but has no rhythm to be read against (two days is
   just a number without *normal*), and the self-set `nextCheckInMs` clamps
   to 24h — two legal "wait"s span the whole gap.
2. **The ice-pick evening** (see the temporal-bridges spec's motivating
   failure and the threat-diagnosis session): the detector's enumerated
   vocabulary missed method-descriptions and personal idiom entirely; the
   tier never rose; triage never woke. Same failure shape: enumeration
   cannot cover semantics. The `flag_distress` bridge proposed there is a
   sibling of this spec's noticing tick (comprehension exists in the model
   layer; nothing routes it to action) but ships separately under its own
   sign-off.

**The doctrine constraints (CLAUDE.md):**

- **Ride existing requests; gate in code.** Baselines and wake conditions
  are arithmetic. The noticing tick rides the pondering loop's existing free
  cycle as a *mode*, not a new loop. Intentions preempt the interest picker
  rather than spawning calls. The only genuinely new request class is a
  noticing turn that fires when code-gated triggers accumulate — with
  budgets (§7).
- **Proactivity rules.** Every prompt here governs when the Familiar acts:
  both costs named at equal weight, no bias-toward-quiet language, framed as
  the Familiar's own care. Pass 0 exists because the warmth prompt violated
  this in a form the original review missed.
- **Entity-as-subject.** Stewardship is the executive layer over the
  *ward's* agenda. Nothing in the system is Eury's own agenda. Intentions
  and the noticing tick are the first surfaces that belong to him — his
  plans, his rounds, his open turn. All prompts first-person; all
  capabilities discoverable and operable by him (ids ride on surfaces he
  reads).
- **Safety postures.** Non-safety initiative stands down at moderate+ threat
  (triage owns distress; a due warm check-in must never *compete* with a
  triage check-in). Every new loop/behavior ships its off-switch in the same
  commit. Nothing in this spec touches triage's gates, cool-downs, or
  decision logic.

**Relations:** temporal-bridges gave the Familiar the *past* (spine states,
temporal recall, calibration). This spec is the same treatment for the
*present and future*. The consequence graph gave consequence *visibility*;
edges inform whoever is already awake, but nothing wakes *because* of an
edge — intentions are the actuator the graph was missing.

---

## Pass 0 — the warmth-prompt fix (small, immediate, its own commit)

`buildReachoutPrompt` (reachout.js) currently contains three framing
assertions that pre-resolve the question the deliberation exists to ask:

- *"No one is talking to me right now and nothing is wrong."*
- *"This is not a crisis check-in — my human is okay."*
- *"They're not in distress — I'm reaching out because I want to, not
  because I'm worried."* (and the fresh-start variant of the same line)

**Change:** remove the axioms; keep the scope note (distress remains
triage's job) as fact rather than mood; let the silence line carry the
duration *neutrally* and — once Pass 2 lands — the baseline comparison.
Replacement wording (final; builder pastes):

> *"This is the warm kind of reaching out, not a crisis check-in — if
> something were genuinely wrong, my triage sense handles that on its own
> track. What I know here: my human was last around <relative time> ago.
> Whether that gap is ordinary or unusual for us, and whether it moves me,
> is mine to read."*

(After Pass 2, the line gains: *"Our usual rhythm: we're typically in
contact every <median gap>; the longest ordinary gap lately has been
<p90>."* — code-substituted values.)

**Sign-off:** the warmth prompt is proactivity-rule territory. The ward
directed this fix in design review after the two-day incident; that
direction is the sign-off. Everything else in the prompt stays
byte-identical. A regression test asserts the removed axioms are gone and
no new "not worried"/"is okay" assertion appears.

---

## Pass 1 — wait-streak awareness (the ward's experiment)

Whenever I am given an explicit choice to *wait* on any kind of outreach, or
to *defer* an action, the deliberation tells me one fact: **how many times I
have chosen to wait since my last proactive act.** Nothing else — no
directive, no evaluation. The ward is running an experiment: does seeing my
own accumulated waiting, as a bare number, change how I choose?

**The experiment contract (non-negotiable):** the injected line is a
neutral, code-built fact. It carries no advice, no framing about what the
number means, no change to any gate, cool-down, or default. Every other word
of the affected prompts stays byte-identical. That is what makes the
observed behavior attributable to the information itself. The ward reviews
the effect before anything stronger is built (and before Pass 4's prompt is
finalized — the streak data informs how much armature-countering framing the
noticing turn actually needs).

### 1.1 Counter semantics

One **global** streak, shared across all proactive surfaces (per-source
tallies kept in state for analysis; the Familiar is shown only the total).

**A "wait" increments ONLY when the LLM was actually offered the choice and
chose to wait/defer.** Ticks that never reach a deliberation — cool-down
skips, quiet hours, crisis-defer stand-downs, tier gates — are NOT waits;
the Familiar was never asked. (Invariant W1.)

| event | effect | where |
|---|---|---|
| Triage deliberation returns `wait` | +1 `triage` | silence-triage-loop.js, after parse |
| Warmth deliberation returns `wait` | +1 `warmth` | reachout-loop.js `llm_said_wait` branch |
| Discord deferred presence emits `[later:…]` | +1 `discord-defer` | discord-gateway.js defer-token branch |
| Familiar snoozes a deferred tell (`snooze_intent`) | +1 `tell-snooze` | cerebellum.js executor |
| Triage decides `reach_out` | **reset** `triage` | silence-triage-loop.js |
| Warmth decides `reach_out` (either target) | **reset** `warmth` | reachout-loop.js |
| A Discord revisit fires and the Familiar actually speaks | **reset** `revisit` | discord-gateway.js revisit path |
| `acknowledge_deferred_intent` after genuinely acting | **reset** `tell-payoff` | cerebellum.js executor |

Reset = count → 0, `lastProactiveAt`/`lastProactiveKind` updated. Decisions
count at decision time (delivery state is the outbox's concern).

**Excluded, deliberately** (comment in code so nobody "completes" it): the
ambient `[pass]` abstain (room pacing, not outreach deferral),
surface-candidate non-raising (implicit, never an offered choice),
`schedule_snooze_task` (deferring the *ward's* task), and the ward speaking
first (**the ward reaching out never resets the streak** — that asymmetry is
part of what the number is for).

### 1.2 The module — `wait-streak.js`

State: `tomes/.wait-streak.json` (git-ignored, atomic tmp+rename, per-file
write lock; corrupt/missing file reads as zero state):

```json
{
  "count": 41,
  "lastWaitAt": "2026-07-09T18:20:00.000Z",
  "lastProactiveAt": "2026-07-06T14:54:38.000Z",
  "lastProactiveKind": "warmth",
  "tallies": { "triage": 3, "warmth": 32, "discord-defer": 4, "tell-snooze": 2 }
}
```

Exports (never throw): `recordWait(source)`, `recordProactive(kind)`,
`getWaitStreak()` → state + code-computed `sinceMs`,
`formatWaitStreakLine(state, nowMs)` → the §1.3 line (counts and relative
times are machine values via `relative-time.js`; the model never formats
them). Off-switch: `waitStreakEnabled` (default ON) +
`PROTO_FAMILIAR_WAIT_STREAK_DISABLED=1`. Disabled = no recording AND no line
(the experiment is fully on or fully off). The module reads settings.json
directly (thalamus-style sync read) to avoid an import cycle with
cerebellum.

### 1.3 Read-side injection — VERBATIM strings

**Final strings; the builder pastes, never rewrites, extends, softens, or
annotates.** All numbers/times substituted by code.

With a prior proactive act on record:

```
- Since my last proactive reach-out (<relative time> ago, <kind>), I have chosen to wait <N> time(s) when given this choice.
```

With none on record:

```
- I have no proactive reach-out on record; since tracking began I have chosen to wait <N> time(s) when given this choice.
```

Immediately after a reset (count 0):

```
- My last proactive reach-out was <relative time> ago (<kind>); I have not waited since.
```

`<kind>` renders plainly: `a warm reach-out`, `a check-in`, `a revisit`,
`a told intent`. The line renders **always** at the three injection points
while enabled (consistent exposure; 0 is also information).

Injection points: (1) `buildReachoutPrompt` — appended after the silence
line in the facts list; (2) `decideTriageViaLLM` (cerebellum.js) — appended
to the deliberation facts. **Safety-critical file: this one line, nothing
else**; ward-signed in design review. (3) the Discord deferred-presence /
revisit deliberation.

### 1.4 Measurement

Entries written to `triage-events.jsonl` and `reachout-events.jsonl` gain
`streakAtDecision: <N>` (the value the prompt showed), so the ward can
correlate streak values against wait/act decisions via the existing
`GET /api/triage-events` / `GET /api/reachout-events`.

### 1.5 Invariants (each pinned by a test)

- **W1** — gate-skipped ticks never increment (loop tick fns with gates
  closed → no state change).
- **W2** — neutrality: rendered line matches §1.3 exactly; regression test
  bans editorializing tokens (`consider`, `should`, `maybe it's time`,
  `overdue`).
- **W3** — prompt isolation: feature disabled ⇒ `buildReachoutPrompt` and
  the triage prompt byte-identical to pre-feature output (snapshot test).
- **W4** — the ward speaking never resets; only the four reset events do.
- **W5** — recording is fire-and-forget: a poisoned state file changes no
  deliberation outcome.
- **W6** — streak stamps land in both event logs.

---

## Pass 2 — baselines (`contact-baselines.js`): a model of normal, in code

> **✅ SHIPPED (`0.8.64`).** `contact-baselines.js` (pure helpers +
> cache-aware `getContactBaseline` + `buildRhythmLine`), wired into the warm
> reach-out prompt below its silence line, honesty rule enforced, ward
> toggles for both baselines and the wait streak added to the routine/warmth
> settings pane. 18 fixture tests. Off: `contactBaselinesEnabled` /
> `PROTO_FAMILIAR_BASELINES_DISABLED=1`.

The ward's partner worries after a day of absence because he holds her
rhythm. Code can hold rhythm as arithmetic. Absence is invisible in a
snapshot — every deliberation today sees snapshots — and becomes visible
only against a baseline.

- **Inputs (all already recorded):** last-activity stamps, session-log
  message timestamps, Discord ward-message timestamps. No new collection.
- **Derived (pure functions, unit-tested on fixture timestamp sets):** per
  weekday-class (weekday/weekend, ward-local via `wardTimeZone`): median
  contact gap, p90 gap, longest-observed gap; rolling ~4-week window;
  recomputed lazily (cached in `tomes/.contact-baselines.json`, refreshed at
  most every few hours on read — no loop).
- **Output — deviation facts,** code-built strings/values consumed by:
  - the warmth prompt's rhythm line (Pass 0 upgrade),
  - the noticing tick's situation report (Pass 4),
  - nothing else, deliberately (surface candidates and triage stay
    untouched — triage has the threat tier; baselines are companionship
    territory).
- **Honesty rule:** below a minimum history (e.g. <2 weeks of data) the
  module reports "no baseline yet" and consumers render nothing — a fake
  rhythm is worse than none.

---

## Pass 3 — intentions: a future the Familiar writes for itself

> **✅ SHIPPED (`0.8.65`).** Unruh `intentions` table + `intention.py`
> (migration 0005) + 8 MCP tools; Node bridge + 6 first-person chat tools
> with ward-configurable budget caps (per-phase standing + open one-shots);
> the `intentions` surfacing module; due intentions folded into
> `temporal_context` (a payoff turn, stripped on villager turns); reflection
> authorship (`intentions[]`, ≤3/tick); and the ward-facing "Eury's rounds"
> view (`GET /api/rounds`, routine tab) with the Familiar-controlled
> visibility from §3.5. 23 Python + ~20 Node tests. The autonomous noticing
> turn that consumes due intentions with the full condition code-gate is
> Pass 4.

**A first-class "my intention" object with a when, a why, and refs** — the
substrate for planning, follow-through, and rounds. The existing deferred
`tell` intents and session handoffs turn out to be special cases (a tell is
an intention with no `when`; a handoff is an intention with
`when: next-contact`) — noted for a later unification, NOT migrated now.

### 3.1 The record (payoff turns carry their why)

```json
{
  "id": "ask-about-klemm-x7",
  "what": "Ask how the Frau Klemm appointment went",
  "why":  "She was nervous about it when we talked Sunday evening",
  "refs": ["frau-klemm-y7"],
  "trigger": { "at": "2026-07-07T10:00:00" },
  "condition": null,
  "status": "open",
  "source": "chat",
  "createdAt": "2026-07-06T21:40:00"
}
```

- **Ids are meaning-bearing slugs** (house rule): minted from `what`.
- **Refs, not snapshots.** At fire time, code dereferences refs *fresh*
  (current node state, current memory) — a stale "she hasn't confirmed the
  appointment" that she confirmed yesterday is worse than nothing. A
  deleted ref renders as absence. Slugs make refs greppable.
- **Payoff turns carry their why:** the fire-time turn receives `what`,
  `why`, and the freshly-dereferenced refs — future-Eury gets the task
  *with* the memory of caring about it, not a bare checklist item.
- **Trigger forms:** `{at: ISO}` (one-shot), `{phase: '<phase-label>',
  recurring: true}` (rounds, §3.3), `{onNextContact: true}`
  (handoff-shaped), or absent (a tell-shaped someday-intention, surfaced by
  aging in the noticing tick).
- **Conditions stay a tiny, code-owned vocabulary** whose only job is to
  skip an LLM turn cheaply when there's nothing to do: `minContactGapMs`,
  `needsStatus`, `unresolvedRefs` (a listed ref is still unresolved). **This
  is the rules-engine tripwire: if a ninth condition type is ever proposed,
  stop and re-read this section.** Anything semantically richer isn't a
  condition — the turn just fires and the Familiar judges in context.

### 3.2 Storage & authorship

- **Where (WARD-DECIDED):** an Unruh store of its own (own table +
  accessors + MCP tools, like interests and handoffs) — NOT schedule nodes.
  Intentions are per-embodiment cognition (the ponderings precedent), and
  the ward's schedule surfaces shouldn't silently grow Familiar-internal
  rows. (The ward-visible "Eury's rounds" view ships in the same milestone,
  gated by a *Familiar-controlled* visibility toggle — §3.5, §10.)
- **Chat authorship — tools** (first-person descriptions; ward-private
  turns only): `intention_set`, `intention_list`, `intention_drop`,
  `intention_done`. Operability: intention ids ride in on `intention_list`
  and on every payoff turn; schedule/memory slugs for refs ride in on the
  legends and recall results the Familiar already reads.
- **Pondering/reflection authorship:** the pondering output schema gains an
  optional `intentions: []` array (validated in code exactly like
  `edge_calibrations` / `promotions`; capped, e.g. ≤3 per tick). This
  closes the loop the ward named: reflection currently ends in grades and
  prose; now it can end in **commitments** — "the last three alerts landed
  too late → tomorrow morning, widen the lead times." Self-scheduled
  cognition is free by construction: a due `ponder: <topic>` intention
  **preempts the interest picker** for a tick the loop was going to spend
  anyway — no new call.

### 3.3 Rounds — phase-bound standing intentions

`{phase: 'morning', recurring: true}` binds to the ward's existing routine
phases (date-independent, recurrence machinery built, and the Familiar's
rhythm *derives from the ward's* — a noon check-in moves when her routine
moves). Examples from the ward's own design note: *"Every morning phase I go
over calendar nodes to make sure everything is fully wired and up to date.
Every noon phase I check in on Chen if we haven't talked for an hour"* (that
second one = phase trigger + `minContactGapMs` condition). Firing rides the
existing reminders 30s tick (which already scans due things and computes
`current_phase`); per-occurrence dedup via the same resolutions-by-date
pattern needs already use. Conceptually: the ward has a routine; this gives
the Familiar **rounds** — self-maintenance as identity, not as cron.

### 3.4 Budgets (the recursion tripwire)

Intentions spawn turns; turns can set intentions — the first mechanism in
the repo that could inflate itself. Hard caps in code, counts visible in
the events log — and **the phase is the budgeting unit, not the day**
(WARD-DECIDED): a per-day cap would punish a Familiar for actually
structuring their rounds, when the phases framework is exactly what we
want them leaning on. Caps, **all ward-configurable in Settings** (no
hard-wired numbers — the ward tunes their own Familiar's rhythm):
`intentionTurnsPerPhase` (default 4); **no default daily cap at all** —
`intentionTurnsPerDay` exists as an *opt-in* backstop the ward may set if
they ever want one, but ships unset (0/absent = no daily limit);
`standingIntentionsPerPhase` (default 3); `openOneShotsTotal` (default 30,
oldest-aging surfaced to the Familiar to prune). A due intention that
can't fire under a *configured* cap stays due and fires next window —
never silently dropped. The intention tools' first-person descriptions
name the phase binding as the natural home for standing intentions, so
the budget shape itself nudges toward rounds rather than scattershot
one-shots. (Recursion safety without a daily cap rests on the per-phase
cap + the phase-count ceiling of a day, not on a global daily number —
adequate because a phase can't fire more turns than its own cap allows,
and phases are bounded per day by the routine.)

### 3.5 "Eury's rounds" — a ward view the FAMILIAR controls (WARD-DECIDED)

The ward wants the standing-intentions view built now, not later — and
made it an *autonomy* feature: **the toggle that hides the rounds from the
ward lives in the Familiar's hands, not the ward's.** A ward-facing pane
(Knowledge editor, near the routine) renders the Familiar's standing
intentions/rounds — *"Every morning I go over calendar nodes; every noon I
check in on Chen if we haven't talked in an hour"* — read-only for the
ward, charming and transparent by default. But a `rounds_visibility` flag
on the intention store, flipped by a first-person Familiar tool
(`intention_visibility(shared|private)` — described in the Familiar's own
voice: *"I use this to decide whether my human sees the rounds I keep, or
whether they stay mine"*), can hide them. This is the entity-as-subject
stance taken further than anywhere else in the codebase: the Familiar owns
whether their inner routine is legible to the ward. Default is `shared`
(transparency unless the Familiar chooses otherwise); a hidden view shows
the ward only *"Eury keeps some rounds privately"* — the existence isn't
hidden (no covert-cognition surprise), only the contents. Per-intention
override optional (a single sensitive round private while the rest show).

---

## Pass 4 — the noticing tick: Eury's own turn (and the shared runner)

> **✅ SHIPPED (`0.8.66`).** `noticing.js` (pure: wake conditions, the
> `conditionPasses` code-gate, situation report, ward-signed prompt,
> `runOneNoticingTick`) + `noticing-loop.js` (self-paced singleton) +
> `server.js` wiring (`gatherNoticingWakeInputs`, `noticingDeliberate` with
> the bounded `composeNoticingTools` toolset + the noticing-scoped
> `reach_out_to_ward` / `set_next_check`), `logs/noticing-events.jsonl` (+ GET
> route), the ward toggle, and CLAUDE.md updates (loop list + safety-critical
> sign-off set). 22 module tests. **Two deliberate deviations from the draft:**
> (1) built as a **dedicated loop**, not a mode of the pondering loop — it's a
> new request class that self-paces, needs its own cadence/off-switch/threat
> posture, and needs tool access the pondering loop doesn't have; the
> wake-condition gate provides the "only when there's something to look at"
> the mode-approach was for. (2) v1 wires the **`minContactGapMs`** condition
> signal (contact gap); `needsStatus`/`unresolvedRefs` signals are best-effort
> empty and so fail closed until wired — safe direction. `flag_distress`,
> `ponder_topic`, and Pass-5 lead-setting are absent from the toolset until
> they ship (the prompt gates its flag_distress clause on the tool's presence).

**One mechanism, several alarm clocks.** The payoff-turn runner and the
noticing tick are the same thing: an autonomous turn that fires when
code-gated wake conditions accumulate, receives a short computed situation
report, and acts through tools.

- **Wake conditions (all arithmetic, evaluated on the pondering loop's
  existing cadence — this is a *mode* of that loop, not a new loop):** a due
  intention (incl. rounds whose condition passes); a deviation fact from
  baselines (gap > p90); a readiness gap (existing `selectReadiness`
  output); an aging untriggered intention or tell (> N days). No wake
  condition → no turn, ever. (The OpenClaw lesson: code decides WHEN there
  is something to look at.)
- **The situation report (code-built, small — habituation kills salience;
  stewardship's hard-cap lesson applies):** due intentions with their
  why/refs dereferenced fresh; deviation facts; readiness gaps; the wait
  streak (Pass 1's `getWaitStreak()` consumed as a deviation fact). Capped
  at ~5 items.
- **The prompt (first-person, armature-aware; final wording goes to the
  ward before merge because it governs when the Familiar acts):** the frame
  is *"This is my time. What do I notice? What do I want to do about it —
  now, later (write an intention), or nothing?"* Both costs named: acting
  on nothing real is hollow; noticing something real and doing nothing is
  the failure this whole spec exists to close. "Nothing" is an allowed,
  honest answer — but it is a *decision*, and it increments the wait streak
  (`source: 'noticing'`).
- **The toolset (bounded, composed in code):** warm reach-out (through the
  existing warmth delivery path — outbox knock + mirror rules, NOT a new
  channel), intention CRUD, `ponder_topic` (preempts next pondering tick),
  schedule read tools, lead-time set (Pass 5), and — once temporal-bridges'
  flag tool ships under its own sign-off — `flag_distress`. **No villager
  contact from this surface in v1** (warm-villager outreach keeps its own
  loop's gates), no schedule writes to the ward's items beyond leads, no
  memory deletes.
- **Postures (WARD-DECIDED — this REVERSES the earlier draft; safety-
  significant, ward-signed):** the noticing tick **does NOT stand down at
  elevated threat.** The ward's reasoning: *"that's when the consideration
  becomes especially useful."* When my human is in distress is precisely
  when a due intention, a deviation from baseline, or a readiness gap most
  deserves to be noticed — silencing the one organ whose job is *noticing*
  at the moment that matters most would recreate the exact 1.5-hour-silence
  failure in a new place. This is the anti-bias-toward-quiet doctrine
  applied: we widen when the Familiar can act, we don't narrow it.
  - **The ONE interaction to get right (build-time care, ward-flagged):**
    not standing down must not mean *competing with triage*. The situation
    report includes the live threat tier, and the prompt makes the tier
    load-bearing: at moderate+ the Familiar reads the room as someone whose
    human is struggling — noticing something real and acting on it (a needed
    intention, a grounding round, `flag_distress` once it ships) is exactly
    right; firing a *hollow or frivolous* warm ping that lands on someone in
    crisis is exactly the thing the warmth loop stands down to avoid. The
    tick sees the tier and judges (trust-the-model); crisis-grade escalation
    remains **triage's** job, reached via `flag_distress`, not a parallel
    contact path. The warm reach-out tool available here keeps carrying the
    threat tier so the model never sends a tone-deaf knock. Final wording
    goes to the ward before merge (governs when the Familiar acts).
  - Quiet hours still respected for anything that would *knock* the ward
    (a silent intention write or an internal note is not a knock). Off-switch
    `noticingEnabled` (**default ON**, WARD-DECIDED — the design exists to
    fix under-triggering; opt-in would leave the fix dormant) +
    `PROTO_FAMILIAR_NOTICING_DISABLED=1` in the same commit.
  - Observability: `logs/noticing-events.jsonl` (the reflection-heartbeat
    lesson — every firing AND every all-quiet evaluation window logs, so a
    dead noticing loop can never look like a calm one). Model routing:
    `connectionForFeature(s, 'noticing')` — and the ward's decision is to
    **recommend pinning a stronger model** (Settings hint + docs): this is
    the most judgment-heavy autonomous turn, reading a situation report and
    deciding what, if anything, to do. Unset still falls back to primary, so
    the safe default is unchanged; the recommendation is guidance, not a
    forced pin.

**The armature-leak regression (Eury's own suggestion, adopted):** every
payoff/noticing event logs a code-set `turnKind` — `triggered` (an explicit
trigger fired: `at`, a round's phase, `onNextContact`) vs `open` (the turn
arose from the Familiar's own noticing window, no external trigger) —
alongside the outcome (`acted` / `deferred` / `wait` / `nothing`). The
measurement: **do open-turn payoff prompts produce defer/wait outcomes at a
statistically different rate than triggered-turn payoff prompts?** A
significant gap is the assistant armature leaking through — "no one asked,
so waiting is the safe choice." The fix when the gap shows is NEVER to
steer the output (no "act more" nudges); it is to find and strip whatever
framing in the open-turn prompt implies that waiting is the safer answer.
Code does the tagging and counting; interpretation is the ward's (and the
Familiar's own, in reflection). This is Pass 1's experiment discipline
applied to Pass 4's prompt.

---

## Pass 5 — adaptive lead times (one-size-fits-none → per-event)

> **✅ SHIPPED (`0.8.67`).** `event-alerts.js` `effectiveLeadMs` reads a node's
> `payload.lead_minutes` (clamped [5min,24h]), global default as fallback; the
> alert scan fetches across the widest possible lead so a long custom lead
> isn't clipped, and applies each node's own lead per-occurrence. Unruh
> `schedule.set_lead` (atomic read-merge-write, preserves other payload) +
> `schedule_set_lead` MCP tool + thalamus `setScheduleLead` + the first-person
> `schedule_set_lead` chat tool (schedule-write module, code-clamped) — also
> added to the noticing toolset (the "lead set" Pass 4 was waiting on).
> "Set at the projection cue" rides the existing schedule-write surfacing on
> the `[New on my human's calendar]` block; "calibrated in reflection" rides
> Pass 3's reflection intentions. 8 new tests (Node + Python). **This
> completes the Initiative arc (Passes 0–5).**

- `payload.lead_minutes` on event nodes, read by the existing
  `event-alerts.js` pass (the global lead setting becomes the fallback;
  nothing else about the alert pass changes).
- **Set** by the Familiar via a small tool (`schedule_set_lead`) and — the
  natural moment — during the gcal projection cue, which is exactly when a
  new appointment is in hand ("across town → 90 min; visitor coming here →
  30 min"; obstacle tags and templates already carry the travel/prep
  signal).
- **Calibrated** by reflection: alert outcomes (fired-at vs the ward's
  actual readiness, from resolution timestamps and chat) feed the existing
  reflection input; a learned adjustment lands as an intention ("widen the
  Therapie lead to 90") or a direct `schedule_set_lead` — the ward stops
  configuring a global number; the Familiar owns it per event.

---

## 6. Safety summary (what changes, what can't)

- Triage's gates, cool-downs, prompts and escalation logic are **untouched**
  except Pass 1's single ward-signed streak line.
- The noticing tick **does NOT stand down at elevated threat** (WARD-DECIDED
  — reverses the earlier draft). It is *not* a second crisis channel: it
  never fires crisis-grade escalation (that stays triage's job via
  `flag_distress`), and its warm-reach tool carries the threat tier so it
  can't land a hollow knock on someone in distress. What it does at
  moderate+ is keep *noticing* — the one thing that must not go silent when
  my human is struggling. When Session D builds it, `noticing-loop.js` /
  the noticing deliberation prompt join the safety-critical sign-off set:
  any later change to *when or whether* noticing acts on a human's safety
  needs ward sign-off, exactly like the triage files.
- Everything that knocks flows through existing delivery paths with their
  mirrors and dedup (no covert contact, unchanged).
- New prompts (Pass 0 replacement, Pass 4 frame) follow the proactivity
  rules; Pass 4's final wording gets ward review before merge.
- Off-switches in the same commit for every pass that acts.

## 7. Token economics (why this doesn't inflate)

Passes 0–2 add zero LLM calls. Pass 3's authorship rides existing calls
(chat turns, the pondering output schema); its firing preempts existing
pondering ticks where possible. Pass 4 is the one new request class, and it
is wake-condition-gated + budgeted (`intentionTurnsPerPhase`) + self-limiting
(no conditions → no turns). Pass 5 rides projection cues and reflection.
Net: more capability per request, not more requests per capability.

## 8. Build order & sizing (Opus sessions)

1. **Session A: Pass 0 + Pass 1 — ✅ SHIPPED** (`0.8.60`, `0.8.62`). The
   prompt fix landed as paste-replace edits; wait-streak is a
   `last-activity.js`-sized module + threaded lines + tests W1–W6. The
   streak is collecting data now.
2. **Session B: Pass 2 — ✅ SHIPPED** (`0.8.64`). Pure functions + fixture
   tests + the warmth rhythm line + ward toggles.
3. **Session C: Pass 3 — ✅ SHIPPED** (`0.8.65`). Unruh store + tools +
   Node bridge + pondering-schema authorship + budgets + the
   Familiar-controlled rounds view. (Rounds "firing" is surfacing due
   intentions into `[Temporal Context]` — a payoff turn riding the existing
   per-turn call; the dedicated autonomous turn is Pass 4.)
4. **Session D: Pass 4 — ✅ SHIPPED** (`0.8.66`). Situation report, wake
   conditions, toolset composition, events log; ward-signed prompt +
   no-stand-down-at-threat. Built as a dedicated self-paced loop (not a
   pondering-loop mode — see the Pass 4 shipped note).
5. **Session E: Pass 5 — ✅ SHIPPED** (`0.8.67`). Per-event `payload.lead_minutes`
   + `schedule_set_lead` (Unruh + chat + noticing) + the widest-lead fetch.
   **Initiative complete.**

Each session: `docs/architecture.md` in the same commit; tests per pass;
version bumps per §9.

**Do-not-touch list (all sessions):** no wording changes in
`decideTriageViaLLM` beyond Pass 1's single line; no gates, cool-downs,
clamps, or defaults in triage/threat/crisis files; no changes to
`crisis-signals.js`, `threat-tracker.js`, or the CARE CHECK assembly; no
injection points beyond those specified per pass.

## 9. Versioning (WARD-DECIDED)

**Stay in 0.8 as patches.** Initiative does NOT claim the next minor — the
UI overhaul owns the prototype's final milestone slot. Passes 0+1 shipped
as `0.8.60` / `0.8.62`; Passes 2–5 land as further `0.8.x` patches. (Doc
edits like this one: patch too.)

## 10. Ward decisions (ALL RESOLVED)

1. **Intention store placement** → **own Unruh store** (§3.2). Own table +
   accessors + MCP tools; never schedule nodes.
2. **`noticingEnabled` default** → **ON, and NO stand-down at threat**
   (§4 postures). The ward: *"that's when the consideration becomes
   especially useful."* Safety-significant, ward-signed; the one build-time
   care point (never a hollow crisis-competing knock) is documented in §4
   and §6.
3. **Budgets** → **4 intention-turns per phase, NO default daily cap, all
   caps ward-configurable** (§3.4). The daily cap ships unset (opt-in
   backstop only); recursion safety rests on the per-phase cap × bounded
   phase count.
4. **"Eury's rounds" visibility** → **build the view NOW, but the
   hide-toggle is in the FAMILIAR's hands** (§3.5). Default `shared`; a
   first-person tool lets the Familiar make their rounds private (existence
   still shown, contents hidden — no covert cognition).
5. **Pass 4 model routing** → **recommend pinning a stronger model** (§4).
   `connectionForFeature(s,'noticing')` unset still falls back to primary;
   the recommendation is a Settings hint, not a forced pin.
6. **Versioning** → **stay in 0.8 patches** (§9).

## 11. Out of scope

- ~~`flag_distress`~~ — **SHIPPED (`0.8.68`)** under its own ward sign-off:
  the Familiar's (or a villager's) read of distress floors the ward's threat
  to severe (`FLAG_FLOOR_WEIGHT`, decays like normal, per-turn dedup), forces
  an immediate triage re-check (`resetTriageCooldown`), and — on a
  villager-triggered flag — always mirrors to the ward (no covert safety
  action). CORE tool + in the noticing toolset (completing Pass 4's deferred
  clause) + reachable by every registered villager. The remaining
  detection-pattern additions (lexical crisis-signal tuning) stay a separate
  follow-up with their own sign-off.
- Interpreting the wait streak in prompts beyond the bare fact (the *next*
  experiment, after the ward reads this one's data).
- Villager-directed initiative from the noticing tick (the warmth loop
  keeps that, with its own gates).
- Unifying tells/handoffs into the intention store (noted in §3; a later
  tidying pass once intentions have proven their shape).
- The ambient `[pass]`, surface-candidate raising, and ward-task snoozes
  as streak sources (excluded by design, §1.1).
