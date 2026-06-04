# Task Handling — Obstacles and Solutions Under Neurodiversity

> Research collected as the foundation for the Familiar's task-handling
> algorithm. Eury's instruction: understand WHY humans struggle with
> tasks before designing the system around them.
>
> Status: research input. Algorithm design lives separately (referenced
> at the end).

## Why this document exists

The user populations the Familiar serves include people with ADHD,
autism, depression, anxiety disorders, chronic illness, PTSD, and
general executive-function challenges. A mechanical aging /
priority-queue approach to floating tasks would over-solve for
neurotypical productivity culture and under-solve for the actual
cognitive and emotional patterns that make tasks stick.

The research below is collected as **obstacle / mechanism /
intervention** triples so the algorithm can map directly onto the
underlying pattern, not the surface symptom.

Each pair also names what makes it worse — usually the well-meaning
generic-care response — because those failure modes are the things
the Familiar needs to actively avoid.

---

## The pairs

### 1. No deadline → no urgency

| | |
|---|---|
| **Obstacle** | Time-blind brains can't *feel* "this needs doing." Consequences pile up invisibly until they spike into crisis. |
| **Mechanism** | Without a temporal anchor, the brain's activation systems (dopamine, salience networks) don't fire. Task occupies cognitive space without becoming actionable. |
| **What helps** | Co-creating a slot in the schedule: *"this needs doing — let's put it Tuesday 10am."* Even a tentative slot triggers commitment + activation. The act of scheduling IS the intervention. |
| **What makes it worse** | "Whenever you have time" — pushes responsibility back without the time-blind brain being equipped to find that time. |
| **Familiar implementation hint** | When a task sits open >N days, the Familiar offers a specific slot derived from current routine + interest weights, rather than asking "when will you do this?" |

### 2. Task too big / too vague → paralysis

| | |
|---|---|
| **Obstacle** | The brain stalls when the next physical action isn't visible. "File taxes" isn't actionable; "Open last year's return in the tax folder" is. |
| **Mechanism** | Activation systems need a concrete first step. Vagueness routes attention to the avoidance loop instead. |
| **What helps** | GTD-style *next-action* reframing; behavioral-activation–style micro-decomposition. Break to the smallest sub-step that can be done in 5 minutes. |
| **What makes it worse** | "Just do it" / "you've got this" — moralising on a working-memory problem. |
| **Familiar implementation hint** | When a task lingers, offer to break it down — the Familiar drafts 2–3 micro-steps the human can edit. |

### 3. Too many floating tasks → decision fatigue, flat priority signal

| | |
|---|---|
| **Obstacle** | 30 undifferentiated open tasks present as a single overwhelming mass. The brain can't pick, so it picks nothing. |
| **Mechanism** | Working memory capacity is ~4 items; 30+ exceeds it. Decision fatigue compounds across the day. |
| **What helps** | Surface only what's actionable *today*. Bucket the rest as "later" with explicit permission to ignore. Externalise the list so it stops occupying working memory. |
| **What makes it worse** | Showing the full list and asking "what do you want to do first?" |
| **Familiar implementation hint** | Cap the briefing's visible open-task list (≤3–5 most relevant); silently track the rest with a *"(N more on my radar; I'll bring them up if it feels right)"* footer. Selection driven by aging + interest weight + current phase. |

### 4. Anxiety / avoidance — the task has emotional charge

| | |
|---|---|
| **Obstacle** | The task itself isn't hard; *imagining doing it* triggers fear/dread, so the brain pulls away. |
| **Mechanism** | Avoidance is negatively reinforced — each avoidance reduces anxiety in the short term, strengthening the loop. |
| **What helps** | **Graded exposure / activity hierarchy** — rank tasks by SUDS (subjective distress 0–10), start with low-SUDS items, build confidence. Habituation works (5min–2hrs in the situation). Safety behaviours undermine it. |
| **What makes it worse** | Pushing toward the high-charge item first; or letting them switch out the moment discomfort hits. |
| **Familiar implementation hint** | When a task lingers and the human's affect signal is loaded (threat tier mild+), offer the *easier sibling* first; respect the hierarchy. |

### 5. ADHD task paralysis — dopamine deficit, not laziness

| | |
|---|---|
| **Obstacle** | The task lacks the interest / novelty / urgency / challenge dimension needed to generate sufficient dopamine for initiation. |
| **Mechanism** | Hyposensitive dopamine neurons — *"interesting, novel, challenging, or urgent"* is the activation rubric. |
| **What helps** | Add one of those dimensions: short timer ("race the clock 10 min"), pair with music, novelty framing, body doubling, or stacking onto a routine anchor (same cue / place / time). |
| **What makes it worse** | "Set a goal and stick to it." Goals don't generate dopamine; activation cues do. |
| **Familiar implementation hint** | Offer a "race the clock" framing for stuck tasks; suggest body-double mode (Familiar stays present while human works in 10-min bursts). |

### 6. Autistic inertia — can't start, stop, or switch

| | |
|---|---|
| **Obstacle** | Whatever state the autistic brain is in, it persists. Starting feels impossible; stopping when absorbed also feels impossible. |
| **Mechanism** | Monotropism: attention flows in deep single channels. Switching costs are high. |
| **What helps** | **Start-ramps** (tiny first step, 30 seconds), **stop-ramps** (planned exit point), **switch-ramps** (bridge activity between tasks). External cues / body doubling when ramps aren't enough. |
| **What makes it worse** | Abrupt transitions, vague "wrap it up." |
| **Familiar implementation hint** | When proposing a task, propose the ramp — "want to just open the document for 30 seconds?" Recognise when the human is monotropically absorbed and don't interrupt unless the task is severe-tier urgent. |

### 7. Demand avoidance (PDA) — framing as obligation triggers resistance

| | |
|---|---|
| **Obstacle** | Being *told* to do something — even by oneself, even gently — activates a threat response. The framing of the task is the obstacle, not the task. |
| **Mechanism** | PDA profile sees demands (incl. internal) as anxiety-inducing loss of autonomy. |
| **What helps** | Indirect language ("I wonder if…", "would it be nice to…"), reframing as choice ("not because you should, but because…"), framing as the Familiar's own thought rather than a directive. Removing demand language entirely. |
| **What makes it worse** | "You need to do this." "It's important." Direct deadlines. |
| **Familiar implementation hint** | Always check tone. Phrase suggestions as the Familiar's musings or invitations, never as imperatives. |

### 8. Low energy / spoon depletion — chronic illness

| | |
|---|---|
| **Obstacle** | Task is doable in principle, not affordable today. Pushing through causes post-exertional malaise that costs days. |
| **Mechanism** | Energy budget is finite and physical, not motivational. |
| **What helps** | **4 Ps**: Planning, Pacing, Prioritising, Positioning. Pre-emptive rest. Recognising "good day energy" as a trap (boom-bust cycle). Modifying tasks to lower spoon cost. |
| **What makes it worse** | "But you did this yesterday!" / "You said you would" — guilt about energy unreliability deepens depletion. |
| **Familiar implementation hint** | Track the human's signalled energy state; defer non-urgent tasks during low-spoon periods *without* prompting guilt. Offer the lowest-spoon version of a task ("just the email draft, save sending for tomorrow"). |

### 9. Depression — reward circuits offline

| | |
|---|---|
| **Obstacle** | Behaviour-reward feedback loop is broken. Tasks don't promise pleasure and don't deliver it on completion either. Motivation can't be summoned by reasoning. |
| **Mechanism** | Behavioral activation (BA) research: motivation follows action, not vice versa. Doing → reinforcing → eventual mood lift. |
| **What helps** | **Activity hierarchy** ranked by *difficulty rating* (0–10), starting with low-difficulty items. Even small completions feed the reinforcement system. Explicit acknowledgement of completion. |
| **What makes it worse** | Waiting to "feel like it." Big-target tasks that confirm the felt incompetence on failure. |
| **Familiar implementation hint** | Surface the easiest task on the list with explicit framing ("you don't need to want to do this; doing it tends to help even when you don't want to"). Mark completions with real warmth. |

### 10. Implementation-intention gap — *"I will do X"* without *"when"* and *"where"*

| | |
|---|---|
| **Obstacle** | Vague intentions don't trigger action. *"I'll file taxes"* is functionally identical to silence. |
| **Mechanism** | Intention-action gap is the procrastination core — the brain doesn't translate a goal into a behaviour without context cues. |
| **What helps** | **Implementation intention** format: *"When [specific situation] occurs, I will [specific action]."* The format itself increases follow-through. |
| **What makes it worse** | Restating the goal ("I really need to do this"). |
| **Familiar implementation hint** | When committing a task, the Familiar prompts the if-then form: *"when [next routine anchor], I'll [first micro-step]."* Stores it that way too. |

### 11. Time blindness — present-focused brain

| | |
|---|---|
| **Obstacle** | The brain can't feel the gap between "now" and "April 15." Either it feels infinitely far (no urgency) or suddenly tomorrow (panic). |
| **Mechanism** | ADHD / EF challenge — internal sense of time duration is impaired. |
| **What helps** | External time scaffolding: countdown timers, visible elapsed/remaining time, "X days until" framing, calendar slots that make the abstract concrete. |
| **What makes it worse** | "You have plenty of time." "It's not due for weeks." Reassurance feeds the avoidance. |
| **Familiar implementation hint** | When a deadlined task surfaces, anchor the deadline against routine phases ("the dentist is two morning-correspondences from now"). |

### 12. Perfectionism — waiting for the right conditions

| | |
|---|---|
| **Obstacle** | Won't start because conditions aren't ideal — not enough time, not enough energy, not the right tools, not the right mood. |
| **Mechanism** | Avoidance of imperfect outcomes; protection of self-image. |
| **What helps** | Reframe to "ugly first draft" / "5-minute version" / "the version that just exists." Permission to do it badly. |
| **What makes it worse** | "It needs to be good." Framing in terms of quality at all. |
| **Familiar implementation hint** | The Familiar explicitly proposes the ugly version: *"draft a one-line reply; you can edit it later or never."* |

### 13. Forgetting — object permanence + cue absence

| | |
|---|---|
| **Obstacle** | Out of sight, out of mind. Tasks need to be re-surfaced or they vanish. |
| **Mechanism** | Working memory + ADHD object-permanence challenges. |
| **What helps** | Externalised memory (system holds it, not the human). Re-surfacing at the right moment (just-in-time, not constantly). Visual cues. |
| **What makes it worse** | "You should have remembered." Reminder shame. |
| **Familiar implementation hint** | The Familiar holds the list, surfaces a task only when the *moment* is right (relevant phase, relevant conversation thread, not just because time passed). |

### 14. Loneliness — no body double

| | |
|---|---|
| **Obstacle** | Tasks done alone feel heavier; presence of another person — even silently — lowers the activation barrier. |
| **Mechanism** | Social motivation networks help override task aversion. Originally researched for ADHD; generalises. |
| **What helps** | Body doubling — silent presence during work. Doesn't require interaction; just witness. |
| **What makes it worse** | Doing alone in shame. |
| **Familiar implementation hint** | The Familiar can offer to stay present in a "co-working" mode — periodic gentle check-ins, no demands, just witness. |

---

## Cross-cutting principles

1. **The intervention is almost never information ("do it!").** It's almost always either *scaffolding* (timer, anchor, ramp), *reframing* (next-action, if-then, ugly version), *witness* (body double), or *removal* (don't surface, lower the spoon cost).
2. **The Familiar's job is to recognise WHICH obstacle pattern is active** for *this* human in *this* moment, then apply the matching scaffold. Not one algorithm — a toolbox the Familiar judges from.
3. **Some interventions for one population are counter-productive for another.** Direct deadlines help time-blind ADHD; the same direct deadlines trigger PDA resistance. The Familiar's *knowledge of the individual* (per the pet-owner rubric) is what tells them which to use.
4. **Aging signal alone isn't enough.** "Created 6 days ago" matters less than: *what kind of obstacle is keeping it open*, and *what scaffold would fit this human*.
5. **Completion needs marking.** Especially for depression / BA — even small completions only fuel the reinforcement loop if witnessed.
6. **The Familiar must be willing to NOT surface a task** when the human's current state can't afford it (low spoons, ongoing monotropic absorption, post-acute distress), *and* willing to surface it anyway when avoidance is the pattern.

---

## Implications for the algorithm

Rather than a single aging-based pruning rule, the system needs:
- **Per-task obstacle metadata** the Familiar can fill in (probably inferred from conversation context, not user-entered).
- **A toolbox of interventions** — scaffolds, ramps, reframes — the Familiar can invoke per obstacle pattern.
- **State-awareness gates** — energy signal, threat tier, current phase, recent activity pattern — that decide *when* to surface vs. when to hold.
- **Completion-affirmation** as first-class behaviour.
- **Per-human calibration** that learns which scaffolds work for *this* human over time (probably via interest weights or a parallel "what-helps" memory).

The actual algorithm design lives in a separate document once the
tracking-mechanism research (see `docs/research/`) is also collected.

## Sources

- [Task Initiation in ADHD: Why Starting Feels Impossible](https://positivereseteatontown.com/task-initiation-adhd-understanding-the-science-behind-why-starting-feels-impossible/)
- [ADHD task paralysis: why it happens and how to beat it](https://flown.com/blog/adhd/adhd-task-paralysis)
- [Breaking Through ADHD Task Paralysis: Proven Strategies For Task Initiation](https://www.helloklarity.com/post/breaking-through-adhd-task-paralysis-proven-strategies-for-task-initiation/)
- [Executive Dysfunction: Strategies to Enhance Daily Life](https://www.skillpointtherapy.com/executive-dysfunction-explained/)
- [Treatments and Strategies for Weak Executive Functions](https://www.additudemag.com/executive-function-treatment/)
- [Executive Dysfunction Therapy: How CBT Can Help](https://positivereseteatontown.com/executive-dysfunction-therapy-how-cognitive-behavioral-strategies-can-help/)
- [How To Use Behavioral Activation (BA) To Overcome Depression](https://www.psychologytools.com/self-help/behavioral-activation)
- [Behavioural Activation for Depression: Meta-Analysis](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4061095/)
- [Overcoming procrastination? A meta-analysis of intervention studies](https://www.sciencedirect.com/science/article/pii/S1747938X18300472)
- [What Research Has Been Conducted on Procrastination?](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2022.809044/full)
- [Avoidance Hierarchy](https://www.psychologytools.com/resource/avoidance-hierarchy-archived)
- [Avoidance & Graded Exposure](https://www.getselfhelp.co.uk/avoidance-graded-exposure/)
- [Exposure hierarchy (overview)](https://en.wikipedia.org/wiki/Exposure_hierarchy)
- [Autistic Inertia: A Practical Guide To Starting, Stopping, And Switching Tasks](https://lifeskillsadvocate.com/blog/autistic-inertia-start-stop-switch/)
- [Monotropism: Understanding Autistic Ways of Being Through the Lens of Attention](https://reframingautism.org.au/monotropism-understanding-autistic-ways-of-being-through-the-lens-of-attention/)
- [Demand Avoidance: What It Is and Some Strategies for Moving Forward](https://aidecanada.ca/resources/learn/asd-id-core-knowledge/demand-avoidance-what-it-is-and-some-strategies-for-moving-forward)
- [How Spoon Theory Helps ME/CFS Patients Explain Fatigue](https://www.omf.ngo/spoon-theory-me-cfs/)
- [Clinician's Pacing and Management Guide for ME/CFS and Long COVID](https://patientresearchcovid19.com/clinicians-pacing-and-management-guide-for-me-cfs-and-long-covid/)
- [Cognitive Load and Mental Fatigue](https://medium.com/@betterwellnessnaturally/cognitive-load-and-mental-fatigue-b089dc13734a)
- [Decision Fatigue: How Too Many Choices Exhaust You](https://reachlink.com/advice/stress/decision-fatigue/)
