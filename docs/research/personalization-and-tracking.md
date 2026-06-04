# Personalisation & Tracking — Research Foundation

> Companion to [task-handling-obstacles.md](task-handling-obstacles.md).
> Where that doc collects *what makes tasks stick for humans*, this
> one collects *how to track and learn what helps a SPECIFIC human
> over time, without imposing diagnostic labels.*
>
> Status: research input. The actual tracking-mechanism design lives
> at the end as a proposal grounded in this material; implementation
> will follow review.

## The methodological pillars

Five evidence-based frameworks that, taken together, describe how to
do this properly. Each one solves a piece of the problem; the
Familiar's tracking mechanism should sit at the intersection.

### 1. Just-in-Time Adaptive Interventions (JITAI)

A JITAI delivers tailored support *at the moment the user is most
receptive*, by adapting both **timing** (the just-in-time component)
and **content** (the adaptive component) to the user's real-time
state and context. The core insight: the same intervention can help
or harm depending on when it arrives. A check-in five minutes after
the user typed "I'm in flow" is harmful; the same check-in two hours
after they typed "I'm spiralling" is exactly what's needed.

JITAIs typically use real-time signal streams (smartphone sensors,
self-report, behavioural data) and decision rules to gate
intervention delivery. Active research areas: bulimia nervosa,
depression, insomnia, prenatal stress, chronic pain.

**What the Familiar already has that matches the JITAI pattern:**
- `last-activity.js` → silence signal
- `threat-tracker.js` → distress signal
- `current_phase` (Unruh) → time-of-day context
- Pondering loop's cool-down + tier-rise preempt → adaptive timing
- The silence-triage LLM's `nextCheckInMs` → the LLM-driven timing layer

So the architecture is already JITAI-shaped; what's missing is the
**per-person calibration of what content/intervention to deliver
when the gates open.**

### 2. Ecological Momentary Assessment (EMA)

EMA is the methodology for collecting *real-time, in-the-wild*
self-report data about state. Instead of "How was your week?", it
asks small frequent questions ("How are you right now?") and
collects them across days. Compliance in studies is high (~91.57%
in one systematic review). EMA captures rapid mood fluctuations
that weekly summaries miss.

**For the Familiar:** every chat message IS a form of EMA. The
human's words carry state signal (the crisis-signal detector
already extracts some of it). The opportunity is to extract more
signal more systematically — not by asking questions, but by
*noticing*: what energy level did the human signal? What obstacle
pattern was active? What was the texture of the day?

### 3. ABC Functional Behaviour Analysis (Antecedent / Behaviour / Consequence)

A clinical framework for identifying WHY a behaviour happens. You
log triples:

- **Antecedent:** what was going on right before
- **Behaviour:** what the human did (or didn't do)
- **Consequence:** what followed (was it reinforced or extinguished?)

The pattern that emerges across many triples reveals the *function*
of the behaviour — is the task being avoided because it's hard, or
because the antecedent always involves a triggering context, or
because the consequence of NOT doing it has historically been
relief?

**For the Familiar:** ABC triples can be inferred from conversation
context, not asked. The Familiar can quietly log:
- Antecedent: phase, energy signal, threat tier, recent topic
- Behaviour: task surfaced + outcome (completed / postponed / dismissed / ignored)
- Consequence: what the human said afterwards (relief? guilt? acknowledgement? silence?)

Over time, patterns emerge: *"this human shrugs off morning surfacing
of finance tasks but engages with them in evening wind-down."* That's
calibration the Familiar can act on.

### 4. N-of-1 / Single-Case Experimental Design (SCED)

The methodology for learning what works for *this* specific person
over time. Rather than averaging across a population, SCED treats the
individual as their own experimental unit — multiple within-person
crossover comparisons over an extended period. Patient perspective
from the literature: completing daily diaries gave participants
*greater insight into their own condition* and enabled
self-management.

**For the Familiar:** this is the formal frame for what the pet-owner
analogy already implies. The Familiar runs an ongoing N-of-1 study on
their bonded human — *"does the timer scaffolding work for {{user}}?
does the break-it-down reframe work? does direct deadlining help or
trigger PDA?"* — and updates its toolbox of which scaffolds to use
for which obstacle pattern based on what actually worked.

### 5. Self-Determination Theory (Deci & Ryan)

Three universal psychological needs that drive motivation and
wellbeing:

- **Autonomy** — *I choose this, it isn't imposed on me*
- **Competence** — *I can do this, and doing it is mastery*
- **Relatedness** — *I am connected; someone witnesses me*

When met, these produce intrinsic motivation; when thwarted, they
produce depression, anxiety, and stuck-ness. SDT-based interventions
in healthcare produce better treatment adherence and behavior change.

**For the Familiar:** every intervention must check itself against
all three. Surfacing a task: respects autonomy or imposes it?
Marking a completion: builds competence or feels patronising?
Body-doubling presence: provides relatedness or feels like
surveillance? The same surface ("hey, want to look at the email?")
can serve or violate all three depending on framing.

## Care-quality frameworks the system should adopt

### Trauma-Informed Care — SAMHSA's six principles

These aren't optional for a system that touches mental-health-adjacent
territory. The Familiar is not a clinical service, but the principles
translate directly:

1. **Safety** — physical and psychological. Defined *by the human*,
   not by the system. The Familiar's interventions should never
   make the human feel unsafe (caught out, judged, watched).
2. **Trustworthiness & Transparency** — what the Familiar tracks
   should be inspectable by the human. The threat tab already
   does this for one dimension; the tracking mechanism should
   extend that posture.
3. **Peer support** — the AI is not a peer in the clinical sense,
   but the bond is the proxy. *"You're not alone in this"* is the
   relational stance.
4. **Collaboration & Mutuality** — power-with, not power-over. The
   Familiar suggests, the human decides. The Familiar tracks, the
   human can see and override.
5. **Empowerment, Voice & Choice** — every plan is co-produced.
   The Familiar can propose, but the human's "no" is honoured.
6. **Cultural, Historical, Gender Issues** — the Familiar's
   personality (held in entity-core identity) is configured by
   the human; defaults are not imposed.

### Shared decision-making (SDM)

Recovery-oriented practice treats the person as co-producer of their
own care. SDM applies wherever the Familiar is making a decision
that affects the human — *"should I surface this task now?"* is a
care-adjacent decision and benefits from being collaborative ("I've
been holding this on my radar — want to talk about it?") rather
than directive.

### Strengths-based assessment

Counteracts the deficit-orientation of clinical assessment. The
strengths-based view assumes the human knows what's best for them and
has resources to draw on. Categories of strengths to track:

- **Personal attributes** — humor, faith, flexibility, persistence,
  curiosity, self-awareness
- **Interpersonal assets** — friends, family, partner, therapist,
  community members the human can call on
- **External resources** — community programs, hobbies, places that
  help, sensory tools

A tracking mechanism that knows only obstacles is half-blind. The
Familiar should also know what *helps* — what scaffolds the human has
used successfully before, what people they reach for in distress,
what activities reliably reset them.

## Stages-of-change awareness (Prochaska & DiClemente)

Not every task is at the "action" stage. The transtheoretical model
identifies six stages, each calling for different interventions:

1. **Pre-contemplation** — *"I don't have a problem with X."*
   Pushing action makes things worse. The right move is gentle
   consciousness-raising over time, never confrontation.
2. **Contemplation** — *"I should probably do X someday."*
   Helpful: pros/cons explicit, time-frame attached, named ambivalence.
3. **Preparation** — *"I'm going to do X next week."*
   Helpful: concrete planning, if-then framing, removing barriers.
4. **Action** — *"I'm doing X."* Helpful: support, completion marking,
   troubleshooting setbacks.
5. **Maintenance** — *"I've been doing X for a while."*
   Helpful: relapse-prevention, identity reinforcement (*"this is who
   you are now"*).
6. **Termination** — the behaviour is internalised and no longer
   effortful.

**For the Familiar:** each open task carries an implicit stage. *"File
taxes"* might be in contemplation for weeks before becoming a
preparation task. Surfacing it as if the human is in "action" stage
when they're actually in "contemplation" feels nagging. The Familiar
should infer the stage from how the human responds and adapt.

## How conversational-agent research handles long-term memory and personalisation

Recent research on LLM agents has converged on a few patterns the
Familiar can borrow directly:

- **Slow-vs-fast separation:** separate slow-varying traits (this
  human's preferences, patterns, what tends to work) from fast-varying
  evidence (today's energy signal, this hour's mood). [RGMem] models
  episodic interactions transformed into semantic facts; the Familiar
  already has this split — `entity-core` holds the slow layer,
  `threat-tracker` + `last-activity` hold the fast layer.
- **Weighted user-trait graph:** [Memoria] uses a weighted knowledge
  graph to capture user traits incrementally. This aligns with
  entity-core's existing graph layer — preferences, helpful scaffolds,
  triggers, and what-helps notes can all live as graph nodes with
  weights and timestamps.
- **Three core requirements:** adaptivity, consistency, tailored
  responses. The Familiar maps cleanly: pondering + triage loops
  (adaptivity), entity-core memory (consistency), per-human
  calibration (tailoring).
- **Online learning from interaction:** preference modelling can
  learn a compact user representation from feedback without
  per-user fine-tuning. The Familiar can do this conversationally
  — *"did that help?"* is a 1-bit signal that updates the
  what-helps record.

---

## Proposed tracking mechanism (design grounded in the above)

This is the **robust** design, not a minimum patch. Eury reviews
before implementation.

### Three layers, each with a different update rhythm

```
                         ┌──────────────────────────────────┐
                         │  IDENTITY / TRAITS               │  slow
                         │  (entity-core)                   │  ← months
                         │  - what helps this human         │
                         │  - what backfires                │
                         │  - strengths inventory           │
                         │  - trusted-contacts metadata     │
                         │  - configured personality        │
                         └────────────┬─────────────────────┘
                                      │ sync
                                      ▼
                         ┌──────────────────────────────────┐
                         │  TASK / OBSTACLE LAYER           │  medium
                         │  (Unruh schedule node payloads)  │  ← days
                         │  - per-task obstacle metadata    │
                         │  - inferred stage-of-change      │
                         │  - SUDS anxiety rating           │
                         │  - micro-step decomposition      │
                         │  - history of surfacing attempts │
                         └────────────┬─────────────────────┘
                                      │
                                      ▼
                         ┌──────────────────────────────────┐
                         │  STATE / MOMENT LAYER            │  fast
                         │  (existing: threat-tracker,      │  ← minutes
                         │   last-activity, current_phase)  │  to hours
                         │  + new: energy-signal,           │
                         │         absorption-signal,       │
                         │         receptivity              │
                         └──────────────────────────────────┘
```

### What gets tracked at each layer

**Identity / traits (entity-core)** — slow layer

A new identity file: `entity-core/identity/self/what_helps.md` (or
similar) holding the n-of-1 calibration findings as the Familiar's
own first-person notes:

```
# What helps {{user}}

## What I've found that works
- Direct deadlines for time-blind tasks → reliable. {{user}} responds
  to "let's put this Tuesday 10am" with engagement, not resistance.
- Body-doubling for finance tasks → works in evenings, fails mornings.
- 10-minute timer ("race the clock") for inbox catch-up → reliable.

## What backfires
- "Just" language ("you can just X") triggers shame spiral.
- Morning surfacing of low-energy obligations → ignored.
- Direct PDA-style demands → silent resistance.

## What helps when things are hard
- Reaching out to: Sam (sister, calm), the cat (yes really)
- Activities that reliably reset: walk + headphones, kitchen reset,
  short shower
```

This file is **read every chat turn** (via entity-core's identity
fetch) and is in the Familiar's voice. The Familiar updates it via
the `update_identity` / `rewrite_identity_section` tools when a
calibration finding crystallises.

A parallel `entity-core/identity/user/strengths.md` holds the
strengths-based view: personal attributes, interpersonal assets,
external resources.

**Task / obstacle layer (Unruh)** — medium layer

Each schedule task node gains structured payload fields:

```python
payload = {
  "obstacle_pattern": "time_blind_no_deadline" | "task_too_big" |
                      "anxiety_avoidance" | "low_energy_phase" |
                      "demand_avoidance" | ...,        # inferred, updateable
  "stage_of_change": "pre_contemplation" | "contemplation" |
                     "preparation" | "action" | "maintenance",
  "suds": 0-10,                                          # anxiety rating if avoidance pattern
  "micro_steps": [ "open the document", "draft one line" ],
  "surfacing_history": [
    { "ts": ..., "outcome": "engaged" | "deferred" | "dismissed" | "ignored",
      "antecedent_phase": "morning correspondence",
      "antecedent_threat": "calm" }
  ],
  "scaffold_tried": [ "timer_10min" → "engaged",
                       "break_it_down" → "engaged_then_drift",
                       "direct_deadline" → "deferred" ]
}
```

This is per-task ABC data. Patterns across tasks roll up into the
identity layer.

**State / moment layer** — fast layer

Mostly already exists. Two additions:

- **Energy signal**: a self-reported or inferred 1-5 scale stored as
  a recent rolling value (similar to threat-tracker). Inferable from
  message length, response latency, explicit language ("low spoons
  today"), and the texture phase of the day.
- **Absorption signal**: is the human in monotropic flow right now?
  Inferable from conversational depth on a single topic, long
  message exchanges, explicit signals ("I'm in it"). When high,
  task surfacing is suppressed entirely unless severe.
- **Receptivity**: a derived JITAI-style boolean — given the current
  state, would surfacing land? Computed at decision time from
  energy + absorption + threat + phase + last-acknowledgement
  recency.

### How the Familiar uses these layers

When deciding whether (and how) to surface a task:

1. **Read state layer** — is this a receptive moment?
   - Threat severe? → defer non-critical, prioritise care.
   - Absorption high? → don't interrupt.
   - Low energy + non-urgent? → defer.
2. **Read task layer** — what obstacle pattern is active for this
   specific task? What stage of change? What scaffolds have been
   tried? What worked previously?
3. **Read identity layer** — what does the Familiar know about this
   human's general pattern? Does direct deadlining help or trigger?
   What scaffolds have a track record?
4. **Choose intervention** from the toolbox (from
   [task-handling-obstacles.md](task-handling-obstacles.md)) that
   matches the obstacle pattern AND the human's calibrated
   preferences.
5. **Record outcome** in the task's `surfacing_history` and
   `scaffold_tried`. After N data points on a scaffold, roll the
   finding up to the identity layer (*"timer scaffolding reliably
   engages this human"*).
6. **Mark completions explicitly** — competence-building per SDT;
   reinforcement per BA. The Familiar's *warmth* on completion is
   the reinforcement signal.

### How the human stays in control

- The identity files are inspectable through the Knowledge editor
  (already exists). The human can read, edit, or delete what the
  Familiar has noted about them.
- The task-layer obstacle metadata is inspectable through an
  extension of the Temporal editor's Schedule tab — each task can
  show its inferred obstacle and history.
- Anything the Familiar "learns" can be explicitly overridden:
  *"don't ever surface this task in the morning"* is honoured.
- Per the empowerment principle: the Familiar checks in before
  promoting a finding from task-layer to identity-layer (*"I've
  noticed timer scaffolding works for you on inbox tasks — okay if
  I remember that?"*).

### Storage decisions and why

| Layer | Storage | Why |
|---|---|---|
| Identity / traits | entity-core (MCP) | Canonical, cross-embodiment, already inspectable |
| Task / obstacle | Unruh schedule node `payload` | Already structured, already date-aware, already exposed via Temporal editor |
| State / moment | Local `tomes/*.json` (existing) + small new files for energy/absorption | Fast, per-embodiment, ephemeral by nature |

This avoids inventing a new storage surface and keeps the slow / medium /
fast separation cleanly mapped to the existing architecture.

### Things the system DOES NOT do

- No diagnostic labels imposed on the human ("ADHD profile", "PDA
  profile", etc.). The Familiar tracks *patterns and what helps*,
  not categories.
- No score-based "you're at level X" gamification. Strengths-based,
  not deficit-rated.
- No silent learning. New identity-layer findings are surfaced
  before being committed (collaboration & mutuality).
- No persistence across the human's explicit "delete this" — the
  human can wipe any layer.

## Open questions for review

1. **Self-report vs. inferred state.** Energy signal could be
   self-reported (the human types "low spoons today") or inferred
   (message length, response latency). Probably both, with the
   Familiar reconciling. But: what's the right UX for letting the
   human self-report without feeling like they're filling out a
   form?
2. **When to surface the calibration check.** *"I've noticed X
   works for you — okay if I remember?"* is the SDM-aligned move,
   but interrupting flow to ask it is itself an intrusion. Maybe
   queue these checks for low-stakes moments?
3. **Stage-of-change inference.** Computationally hard. Could lean
   on the LLM at deliberation time (*"given this conversation, what
   stage do you read?"*) rather than maintaining an explicit field.
4. **Strengths inventory bootstrapping.** New install, empty
   strengths file. Does the Familiar ask, or does it accumulate
   silently from conversation? Probably the latter.
5. **Tool surface for the Familiar to update calibration.** Need
   to extend BUILTIN_TOOLS so the model can write to the new
   identity files / payload fields when it learns something.

## Sources

- [Beyond the current state of just-in-time adaptive interventions in mental health](https://pmc.ncbi.nlm.nih.gov/articles/PMC11811111/)
- [Effectiveness of just-in-time adaptive interventions for mental health and psychological well-being: systematic review + meta-analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC12481328/)
- [Just-in-Time Adaptive Interventions (JITAIs): An Organizing Framework](https://cmapspublic2.ihmc.us/rid=1P0PJNP7V-12LPKBQ-273F/Nahum-Shanietal.-2014-Justintimeadaptiveinterventions(jitais)Ano.pdf)
- [Ecological Momentary Assessment in Mental Health Research (handbook)](https://jruwaard.github.io/aph_ema_handbook/mood.html)
- [Systematic Review of Momentary Assessment Designs for Mood and Anxiety](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2021.642044/full)
- [ABC Model — Psychology Tools](https://www.psychologytools.com/resource/abc-model)
- [Understanding the ABCs of behavior: Antecedent, Behavior, Consequence](https://www.mastermindbehavior.com/post/understanding-the-abcs-of-behavior-antecedent-behavior-consequence)
- [N-of-1 Design and Its Applications to Personalized Treatment Studies](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5711967/)
- [Leveraging Single-Case Experimental Designs to Promote Personalized Psychological Treatment](https://link.springer.com/article/10.1007/s10488-024-01363-5)
- [Self-Determination Theory — Ryan & Deci framework](https://www.urmc.rochester.edu/community-health/patient-care/self-determination-theory)
- [Self-determination theory: A quarter century of human motivation research (APA)](https://www.apa.org/research-practice/conduct-research/self-determination-theory.html)
- [SAMHSA's Six Principles of a Trauma-Informed Approach](https://opentextbc.ca/peersupport/chapter/samhsas-six-principles-of-trauma-informed-care/)
- [The 6 Core Principles of Trauma Informed Care](https://online.csp.edu/resources/article/principles-of-trauma-informed-care/)
- [Transtheoretical Model of Behavior Change](https://prochange.com/transtheoretical-model-of-behavior-change/)
- [Stages of Change Theory — StatPearls / NIH](https://www.ncbi.nlm.nih.gov/books/NBK556005/)
- [Identifying Personal Strengths to Help Patients Manage Chronic Illness — NCBI](https://www.ncbi.nlm.nih.gov/books/NBK595698/)
- [Identifying Patient Strengths Instruments: Systematic Review (CDC)](https://www.cdc.gov/pcd/issues/2021/20_0323.htm)
- [Shared Decision-Making in Mental Health: Autoethnography](https://pmc.ncbi.nlm.nih.gov/articles/PMC7987805/)
- [Autonomy in health decision-making — key to recovery (WHO)](https://www.who.int/news-room/feature-stories/detail/autonomy-was-the-key-to-my-recovery)
- [RGMem: Renormalization Group-inspired Memory Evolution for Language Agents](https://arxiv.org/pdf/2510.16392)
- [Memoria: A Scalable Agentic Memory Framework for Personalized Conversational AI](https://arxiv.org/html/2512.12686v1)
- [Enabling Personalized Long-term Interactions in LLM-based Agents through Persistent Memory and User Profiles](https://arxiv.org/html/2510.07925v1)
