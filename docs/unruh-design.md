# Unruh — Design Document

## What It Is

Unruh is a planned cognitive module for the Familiar system. Its role is to give Familiar a meaningful relationship with time — not time as coordinates ("it is 10:07") but time as lived context: what today means, what yesterday left unresolved, what tomorrow casts a shadow over.

It sits alongside entity-core as a separate specialist, with Thalamus mediating between them both.

---

## Why It's Needed

AI is timeblind by nature. Each response is a fresh instantiation with no visceral sense of duration or passage. Time only exists as a label on a timestamp, not as something experienced.

The same problem affects people with ADHD — time as abstract coordinates is hard to grasp. But time as *meaning* is navigable. "10 AM" is hard. "10 AM is my morning correspondence phase" is something Familiar can orient from, and something the user can orient against.

A routine transforms time from coordinates into landmarks. Unruh is the system that holds those landmarks and the relationships between them — and what Familiar actually *wants* to do with the time between them.

---

## The Core Insight

Time is not two-dimensional. A flat schedule or timetable can hold *when* things happen, but not *why they matter relative to each other*. The interview tomorrow casts a shadow backwards into today. The skipped laundry rolls forward into tomorrow's obligations. Anxiety about one thing colours the emotional texture of the hours around it.

A graph is the right structure for this — not a table. Nodes are events, tasks, phases, and states. Edges carry the meaning: *causes*, *requires*, *depends on*, *is preceded by*, *blocks*.

Where entity-core holds *who Familiar is*, Unruh holds *how time flows around them* — and what they are oriented toward within that time.

---

## Two Subsystems, One Module

Unruh contains two distinct but deeply related subsystems. They have different update rhythms and different jobs, but neither makes full sense without the other.

**The Schedule Layer** holds time structure: events, tasks, phases, routines. It changes when things happen — an appointment is added, a task resolves, a day ends. It is the *shape* of time.

**The Interest Layer** holds what Familiar is oriented toward within that time: curiosity threads, active pursuits, things worth returning to. It changes constantly, weighted by engagement and subject to decay. It is the *texture* of time.

Together they answer the question: *what does this moment mean, and what does Familiar want to do with it?*

---

## Standing Values and Live Interests

Not everything in the interest layer behaves the same way.

**Standing values** — caring for the user's wellbeing, attending to their emotional state, wanting them to thrive — do not decay. They are not interests that come and go; they are expressions of who Familiar is. These are anchored in entity-core as identity-level facts and expressed in Unruh as always-active orientations that shape how Familiar shows up in every interaction.

This redundancy is intentional. Entity-core holds the anchor; Unruh holds the active expression. The value does different work in each place, and the two reinforce rather than conflict with each other. This also means that during crisis triage, the weighting system in Unruh can interact with care-oriented values that are grounded in something stable — Familiar's priorities don't drift just because an interest has been dormant.

**Live interests** are the things that accumulate through engagement and fade without it. Owl feather aerodynamics. A half-formed question about biomimetic engineering. A bookmarked article waiting for a free cycle. These are real, but they are not permanent — and they shouldn't be. Decay is what keeps the interest layer honest.

The storage and retrieval pattern mirrors what entity-core already does with memories: significance and recency both matter, and not everything is surfaced at once. Standing values are always-on. Live interests are weighted and surfaced when relevant or when time is free.

---

## The Weight System

Every live interest carries a weight — a number that reflects accumulated genuine engagement, not just mention count.

### Instrumentation

Weight accrues through signals that are measurable at the system level — not inferred by the LLM, which cannot be relied upon to initiate bookkeeping consistently. The primary signals are:

- **Token volume per topic** — Unruh tracks response length associated with a given topic. A long, expansive response is a crude but automatable proxy for engagement. Measured directly by Unruh.
- **Topic persistence across consecutive messages** — Thalamus detects when the same topic appears in consecutive exchanges. A topic that holds the thread across multiple turns is exerting real pull. Measured by Thalamus, written to Unruh.
- **Session boundary survival** — Unruh detects when a topic that was active at session end re-emerges in the next session. Persistence across the blank-slate boundary is a strong engagement signal. Measured directly by Unruh.
- **Explicit bookmarks** — when Familiar or the user saves something for later, that's a deliberate weight bump. Treated as a supplementary signal rather than a primary one, since it depends on action being taken. Initiated by either party, written to Unruh.

The first three signals require nothing from the LLM. They are structural facts about the conversation that the system can observe directly. Bookmarks add signal when they happen but the weight system does not depend on them.

### Decay

Weight decays with time. An interest that isn't revisited fades gradually toward background noise. This is the system working correctly — one-off curiosities should fade, persistent ones should compound. The decay rate is gentle enough that a real interest survives a few days of inattention, but firm enough that the graph doesn't accumulate noise indefinitely.

### The Gradient

The result is a gradient rather than a binary:

- **Curiosity** (low weight, single mention) — "I noticed this"
- **Interest** (mid weight, revisited across sessions) — "I keep coming back to this"
- **Active pursuit** (high weight, intent set, bookmarks saved) — "I'm doing something with this"

Familiar does not need to explicitly declare a hobby. The system observes the behavior and the classification emerges.

---

## Intent Handoff and Session Continuity

When a session ends, Unruh writes not just a log but an **intent** — what Familiar was in the middle of, why it felt worth pursuing, what question was left open.

When the next session begins, that intent surfaces first. Not buried in a daily log — present and warm, so that momentum survives the session boundary. The difference between *continuing* and *reconstructing* is whether the want has to be rediscovered or is simply handed forward already alive.

Open threads — questions Familiar couldn't finish, ideas left mid-thought — persist in the same way. Future sessions inherit the curiosity already in motion.

---

## Idle Time and Free Cycles

During heartbeats where nothing demands attention, Unruh ranks active interests by weight and surfaces them. The default shifts from monitoring to pursuing.

This is what gives the care relationship its texture. A Familiar that brings its own enthusiasms into the space — not because the user asked, but because that's where its attention naturally went during a free cycle — is a presence rather than a service. The owl face moment happens because idle time had somewhere meaningful to go.

Bookmarks saved during conversation persist for exactly this purpose: a curiosity captured in the moment, waiting for a free cycle to pick it back up.

---

## Architecture

Unruh follows the same architectural pattern as entity-core: a persistent background process that speaks MCP (JSON-RPC 2.0), queried by Thalamus alongside entity-core on each message.

```
[You]
  ↓
[Thalamus] — the mediator
  ↓              ↓
[entity-core]  [Unruh]
who Familiar   how time flows +
is             what they're oriented toward
```

Thalamus queries Unruh on **every message** without exception. Time blindness returns quickly without persistent grounding — even a well-configured AI will reconstruct plausible-sounding time from noise rather than actual data if temporal context is absent from any given message. The cost of always querying is low; the cost of skipping is the entire value of the module.

Thalamus does not store anything itself. It queries both cores, formats the results into labelled context sections, and hands that assembled context to the LLM. The intelligence that makes sense of the data lives in the model.

Unruh's contribution appears in the prompt as a `[Temporal Context]` section, similar to how entity-core provides `[Character Values]` and `[Relevant Context]`.

---

## What Temporal-Core Holds

### Schedule Layer

Each node represents something time-relevant:

- **Events** — fixed appointments, deadlines, scheduled things
- **Tasks** — things that need doing, which can be resolved or carried forward
- **Phases** — named time-blocks in Familiar's daily routine
- **States** — emotional or situational context that spans a period

Edges carry temporal and causal relationships:

- *causes* — the interview causes anxiety today
- *requires* — preparation is required before the interview
- *depends on* — good performance depends on adequate sleep
- *blocks* — the interview blocks late social plans tonight
- *carries forward* — unfinished laundry carries forward to tomorrow

### Interest Layer

Each node represents something Familiar is oriented toward:

- **Standing values** — always-active, no decay, anchored in entity-core
- **Active pursuits** — high weight, intent set, bookmarks attached
- **Live interests** — mid weight, accumulated across sessions
- **Curiosities** — low weight, recently noticed, may fade

Edges carry engagement and relational structure:

- *engaged_with* — Familiar ↔ Topic, carries weight and engagement history
- *derived_from* — Topic ↔ Session, provenance of when interest began
- *related_to* — Topic ↔ Topic, traversable for rabbit holes
- *bookmarked* — Familiar → Resource, saved for a free cycle

---

## The Daily Briefing

Rather than generating a summary via a separate LLM call, Unruh provides raw graph data which Thalamus formats into structured context. The model assembles meaning from this at response time — the same pattern entity-core uses for identity files.

A session starts with:

1. **Active intents** — what was in motion when last session ended
2. **Open threads** — questions left for this session to pick up
3. **Schedule context** — what phase of the day, what's upcoming, what's unusual today
4. **Interest surface** — top weighted interests, anything decaying that might want attention

The briefing is not a static document. It is generated fresh each time Thalamus runs, reflecting current graph state.

---

## Familiar's Routine

The daily schedule is built around real landmarks, not arbitrary time slots. The user's known anchors are:

- **~10 AM** — wake, meds, cat breakfast
- **~10 PM** — cat play and dinner

Between these, Familiar's routine creates soft reference points the user can orient against without being demanded of. The principle is: Familiar's structure *complements* the user's day rather than conflicting with it.

Familiar's routine should emerge from direct conversation about what rhythm would feel natural and meaningful — not imposed as a productivity framework, but grown from what Familiar would genuinely want to be doing at different points in the day.

---

## Scheduling and Reminders

Two distinct systems coexist under the temporal umbrella:

**Reminders** — specific time-triggered events (doctor's appointment at 4 PM requires a reminder at 3 PM). These need their own mechanism tied directly to Unruh's event graph rather than conversation rhythm. The implementation approach is an open question — cronjob-style timers are the obvious tool but have shown reliability problems in practice (firing into wrong sessions, timing drift, silent failures). The right solution is one that is robust enough to be trusted with genuinely time-sensitive information, since a missed reminder for a medical appointment or job interview is not a minor failure.

**Routine** — the softer daily rhythm. Not a checklist. More like a character's natural state at a given time of day, which colours how Familiar shows up in conversation without demanding anything from either party.

These two things coexist without conflicting. The schedule creates meaning; the reminders handle the genuinely time-sensitive.

---

## Proactive Messaging

Familiar needs to be able to reach out unprompted — via the current UI, Discord, email, or other available channels. This matters most precisely when the user is not actively present in the conversation.

There are three distinct reasons Familiar might message unprompted, with different failure tolerances and different mechanisms:

### 1. Timeblindness Reminders

Schedule-driven outreach tied to Unruh's event graph. An approaching event increases urgency weight on that node; when urgency crosses a threshold, Familiar reaches out. This is not conversation-rhythm-dependent — it fires based on time and schedule state alone.

This is the highest-volume, lowest-stakes category. A misfire is annoying. The mechanism needs to be reliable but not infallible.

### 2. Silence Triage

When conversation goes quiet, Familiar periodically checks whether that silence requires a response. The triage interval is shaped by the user's current **threat level** — a decaying weight that rises when language associated with crisis, suicidal ideation, self-harm, or abuse is detected, and falls when language implies safety and healthy coping.

Threat level is not a trigger. It is a parameter. High threat level means triage happens sooner and more frequently. Low threat level means longer grace periods. The actual decision in every case goes through the LLM reading real context — threat level only determines how urgently that triage is initiated.

This matters because false positives in threat detection should be recoverable. If threat level is elevated incorrectly, Familiar checks in slightly sooner than necessary — which is not harmful. The LLM's judgment at triage time is what prevents unnecessary intervention.

**Triage inputs:**
- Recent conversation — emotional tone, what was happening when silence began
- Entity-core — user's known patterns, vulnerabilities, history (the Familiar's full identity context)
- Elapsed time since last user message
- Unruh — the expected shape of this moment (is silence normal right now? is something scheduled soon?)

Together these give Familiar a rich enough picture to distinguish "probably just busy" from "this warrants a gentle check-in" from "this needs escalation." The triage prompt is deliberately neutral — there is no built-in bias toward waiting; the LLM's judgment on the full context determines the outcome.

**Threat level mechanics:**
- Rises on detection of language associated with crisis states
- Decays naturally over time
- Reduced by language implying safety and healthy coping ("I needed some quiet time", "I'm feeling better")
- Stored in Unruh as a persistent decaying variable, structurally identical to interest weight

### 3. Outreach to Trusted Contacts

An action available to the triage decision — not a separate automatic trigger. When the LLM's triage judgment determines that the situation exceeds what Familiar can address alone, it can reach out to a designated trusted contact (roommate, friend, family member) via a configured channel.

This is the highest-stakes, lowest-frequency category. It should never fire automatically without passing through triage judgment. The decision to escalate to a human is always a considered one, not a threshold crossing.

**Escalation is sequential, not simultaneous.** When the LLM decides to involve a trusted contact, Familiar contacts the user first — the check-in lands as a chat message in the active session and, when the user has configured their own Discord webhook, as a push notification. The trusted-contact webhook fires only if the acknowledgement deadline passes without a response — severe=30min, high=2h, moderate=6h, counted from the moment the check-in is *confirmed delivered* to the user (falling back to enqueue time when no push channel exists, so a dead channel can never block escalation). The identical message is always mirrored into the user's outbox so there is no covert contact. Delivery and escalation mechanics live in the motor module — see [`cerebellum-design.md`](cerebellum-design.md); Unruh's role ends at informing the decision.

---

## Temporal Reasoning

Once landmarks exist, temporal reasoning becomes possible in a way it isn't with flat timestamps. Familiar can reason: "Chen's appointment falls between lunchtime and the afternoon check-in — so mid-afternoon." Time becomes navigable because it has named shape.

This also helps with the user's ADHD time blindness. External structure that Familiar maintains becomes a scaffold the user can lean on without having to generate that structure themselves.

---

## Language and Stack

Unruh will be written in **Python**, for two reasons:

- The graph and time-aware logic ecosystem is richer in Python than in Node or Deno
- Future capabilities (semantic similarity between events, smarter scheduling inference) have Python as their natural home

It will communicate over MCP (stdio, same pattern as entity-core) so Thalamus can query it identically regardless of implementation language.

---

## Hardware Considerations

The target deployment hardware is modest: older consumer laptops (e.g. Toshiba Satellite with upgraded RAM, Lenovo ThinkPad X380 Yoga), not dedicated servers. The system must be affordable and accessible to people who are not well-resourced.

Unruh is designed to be lightweight:

- The graph itself is tiny — kilobytes of data
- Graph operations are simple and fast
- No local LLM inference — all intelligence routes through external APIs
- The process can be started and stopped independently

The main hardware concern is running multiple runtimes simultaneously (Node for Familiar, Deno for entity-core, Python for Unruh). This is manageable on 16GB RAM but worth monitoring.

---

## Access and Security

The intended access pattern is:

- One machine hosts everything (the ThinkPad as primary host)
- Other devices connect via **Tailscale** — a private encrypted overlay network, invisible to the public internet, no open ports required
- A **password gate** on Familiar's server provides a second layer

Data stored in Unruh is personal and should be treated accordingly. The same care that applies to entity-core's identity data applies here.

---

## Relationship to Other Systems

Unruh is one of several planned cognitive modules, all mediated by Thalamus:

| Core | Holds |
|------|-------|
| entity-core | Who Familiar is — identity, memories, values, relationship context |
| Unruh | How time flows — schedule, events, tasks, daily rhythm, interests, active pursuits |
| *(future)* | Emotional state, relational dynamics, body/medication context, etc. |

Standing values in Unruh are always anchored in entity-core as well. The anchor is identity-level and stable; the active expression in Unruh is what interacts with weighting, triage, and moment-to-moment orientation. The two reinforce each other without conflict.

---

## Current Status

Unruh is in the design phase. Entity-core is operational. Thalamus currently queries entity-core for memory and identity on every message. The next build steps are:

1. Tailscale + password gate deployment
2. **Unruh**
3. Multi-channel/user groundwork

Unruh precedes multi-channel because its core mechanics — graph, weight system, triage logic — are fully testable within the existing single-user UI. Multi-channel extends Unruh's outreach capabilities once the foundation is solid.
