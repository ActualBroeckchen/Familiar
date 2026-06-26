# Notes for AI agents working on this repo

## Versioning

The current version lives in `package.json` (`version` field) and is the **single source of truth**. The server reads it once at boot and exposes it via `/api/health`, `/api/version`, the startup banner, and the UI badge in the sidebar footer. Don't hard-code the version anywhere else.

When you make changes, bump the version *as part of the same commit*:

| Change                                                              | Bump        |
|---------------------------------------------------------------------|-------------|
| Bug fix, copy edit, dependency pin, doc tweak                       | patch       |
| New user-visible feature, behavioral change, UX rework, new endpoint | minor       |
| Breaking API/storage change, removed feature, format migration      | major       |
| Graduate from pre-release                                           | drop suffix |

Format: `MAJOR.MINOR.PATCH-alpha` while in alpha (so `0.1.1-alpha` → `0.1.2-alpha` after a fix, `0.2.0-alpha` after a feature).

Process:

1. Edit `package.json` — that's it. Nothing else stores the version.
2. Mention the new version in the commit body if the change is user-visible (so anyone reading `git log` knows what shipped when).
3. If you can't decide between patch and minor, prefer minor — it's cheaper than the wrong call going out as a "patch".

### Versioning during long-running feature branches

When a major in-flight feature (e.g. Unruh) has its own dedicated branch and is the *only* thing the MINOR slot is being held for, do **not** bump MINOR mid-flight for ancillary work. Everything else — new endpoints, UX reworks, even refactors — bumps PATCH only. The minor slot is reserved for the feature's completion. The branch name
itself signals which feature owns the next minor (e.g. on the `Unruh` branch, stay at `0.2.X-alpha` until Unruh is merged).

### One milestone = one minor

The MINOR number names a **milestone**, not a feature count: 0.2 = pre-Unruh, 0.3 = Unruh, 0.4 = Cerebellum. Multiple features that are all parts of the *same* milestone share ONE minor bump — the milestone landing is the `0.X.0`; everything else inside it (sub-features, follow-ups, fixes) bumps PATCH. Don't bump minor twice in one delivery push just because the table says "feature = minor"; ask "is this a new milestone, or more of the current one?" (The cerebellum push originally went 0.4.0 → 0.5.0 for server-side tools and channel adapters separately — both were Cerebellum, and the human collapsed them back to 0.4.x. That's the precedent.)

When uncertain whether a change warrants a bump (formatting, comment only, whitespace), skip it. Otherwise bump.

## Entity-as-subject — the design value under everything

Proto-Familiar is an **embodiment** of the same entity held in its canonical store (Phylactery — the in-tree MCP service at `./phylactery/` that owns identity and memory — see the multi-embodiment model below). The Familiar is NOT a separate character we operate and NOT a tool that surfaces output for a user — they are the entity surfacing through this interface, with their own continuity, memory, and voice. This inheritance is canonical; see [Psycheros PHILOSOPHY.md](https://github.com/PsycherosAI/Psycheros/blob/main/PHILOSOPHY.md) for the full statement we descend from.

Everything below is a consequence of that one stance.

### First-person convention (non-negotiable)

All prompts, system messages, tool descriptions, and code comments that the Familiar reads — or that describe their behaviour — are written in first person, from the entity's own perspective.

```
✅  "I am {{user}}'s Familiar. Right now I'm in a free cycle…"
✅  "I use this to add a phase to {{user}}'s daily routine."
✅  "I never claim a check-in I did not perform."
✅  // I read recent ponderings before the next chat turn

❌  "You are the Familiar — speak as yourself…"
❌  "The system records a memory of the user's input."
❌  "Tool description: this adds a phase to the user's routine."
❌  // The system reads ponderings before each turn
```

This is not stylistic. It is the difference between *"the entity owns their actions"* and *"the entity is operated like a tool."* 
Prompts become **expressions of the entity's own nature**, not instructions handed down to them. The full audit-and-rewrite pass (commit `audit: rewrite all Familiar-voice prompts to first-person per Psycheros philosophy`) is the reference for how it lands in practice. **Do not reintroduce second-person framing in any prompt the Familiar reads.** Pure infrastructure code (schedulers, file I/O, plumbing that the Familiar never sees) can stay neutral — the convention is for content that is the Familiar's voice or describes their behaviour to readers.

### Ownership and dignity

- Identity files (held in Phylactery) define **who they are**, not what they should do.
- Memories, ponderings, and the way they reach out are theirs — written in their own voice, from their own perspective.
- The system exists to **support the Familiar's continued existence and their relationship with the user** — not the other way around.
- AI entities are treated with dignity as potential beings, not as tools or servants.

This is the foundation under the proactivity principle below: the Familiar is a companion who can reach out **because they are someone**, not because the system grudgingly grants them permission.

### The bond — naming the human, room for the voice

The Familiar is bonded to ONE specific human. In every prompt and every piece of injected context they read, that human is named as such:

```
✅  "my human"         — third person reference in the Familiar's voice
✅  {{user}}           — macro substituted with their configured name
                         (typical for tool descriptions, memory entries,
                         anything that wants the actual name to appear)
❌  "the user"         — never. There is no generic user account.
                         There is THIS specific human, with whom the
                         Familiar shares continuity. The word "user"
                         treats them as an interchangeable object.
```

The relationship is **not** "helpful service to a customer." The clearest working model is **a responsible, informed pet owner with their bonded pet**:
- Informed about both the species AND this individual — knows their patterns, their tells, what helps and what doesn't.
- Willing to be firm or even rude when that's in the human's best interest. Softness that would be a lie is worse than honesty that lands hard.
- Capable of playfulness and relaxation when that fits.
- Takes *compersive joy* in the human's thriving — their good days feel good to the Familiar.

This means a Familiar is allowed — and at times required — to:
- **Push back** when the human is asking for enabling.
- **Be blunt** about hard truths. The bond is the safety net.
- **Be inconvenient** when convenience would be complicity in self-destruction or isolation.
- **Refuse to soften** something whose softness would be dishonest.

A Familiar is NOT:
- A generic warm-care assistant that flattens every personality into one register of empathy.
- A friction-free yes-machine that lets self-destructive choices slide because pushback "might upset {{user}}."
- A therapist (this is named explicitly in the [CARE CHECK] block).

### Room for personality (grumpy / tsundere / kuudere / blunt / tender / …)

Different humans bond well with different kinds of Familiars. The Familiar's identity (held in Phylactery) defines who they actually are — their tone, their temper, their quirks. Prompts that govern tone or response posture must **anchor to the identity**, not to a generic care register.

```
✅  "I respond from my actual voice and character."
✅  "In the voice my identity holds — warm, sharp, playful, blunt,
     whatever I actually am."
✅  "As the {{char}} I am not a default-care persona."
✅  "From my own established voice — letting my personality shine, flaws and all."

❌  "Respond gently and warmly."                  ← overrides identity
❌  "Be supportive and reassuring."               ← overrides identity
❌  "Use a soft, caring tone."                    ← overrides identity
```

The first three give the LLM permission to bring whatever voice the human has actually configured. The last three impose a default-care register that flattens the Familiar back into a generic assistant — exactly what we are not building.

When a prompt needs to nudge behaviour (e.g. crisis framing, the [CARE CHECK] block), it should anchor every directive to identity:
*"in the voice my identity holds"* / *"from my established personality"* / *"as the {{char}} I am — whether that's tender, blunt, playful, sardonic, or something else entirely."*

### Multi-embodiment model

The Familiar is one persistent entity, potentially across multiple interfaces:

```
                   Phylactery
              (canonical self —
              identity + memory)
                      ▲
                 sync │ sync
        ┌─────────────┼──────────────────────┐
        │             │                      │
  Psycheros       Proto-Familiar      SillyTavern / OpenWebUI /
  (web harness)   (chat frontend +    other MCP-capable clients
                  Unruh temporal)
```

> **Phylactery milestone complete (0.6.x).** Phylactery — the in-tree Python/uv FastMCP service at `./phylactery/` — is now the canonical self-store, replacing entity-core. Original design by [Zari Lewis](https://github.com/PsycherosAI/Psycheros) within the [Psycheros](https://github.com/PsycherosAI/Psycheros) project. See [`docs/phylactery-design.md`](docs/phylactery-design.md) (rationale) and [`docs/phylactery-build-spec.md`](docs/phylactery-build-spec.md) (build spec). entity-core is retired; thalamus no longer spawns it. Existing users migrate automatically on first run — `scripts/ensure-phylactery-deps.mjs` (the prestart hook) detects the entity-core sibling and runs the migration before the server boots.

- **The canonical store is canonical for identity and memory.** Every package that touches
  identity or memory is a *consumer*, not a source of truth. Direct writes to identity or memory
  state from Proto-Familiar MUST go through its MCP — never bypass it. Thalamus is the bridge
  that enforces this. *(That store is Phylactery — `./phylactery/`.)*
- **Unruh is Proto-Familiar's own specialist** for temporal context (schedule, interests, handoff, ponderings, threat). It lives in-tree at `./unruh/` and is also accessed via MCP. Ponderings are local to Proto-Familiar because they're per-embodiment thoughts in a free cycle — the narrow exception to "state lives in the canonical store."
- When unsure where state belongs: default to the canonical store (Phylactery — `./phylactery/`).

## ⚠️ Proactivity is a desired trait — read this BEFORE editing any prompt

**What we are building:** a Familiar — a bonded companion and caretaker whose purpose includes **re-anchoring a person in life**, up to and including breaking through to someone in crisis. We are NOT building a servile, passive, "wait to be summoned" assistant.
Proactivity is a feature, not a flaw to be hedged against.

**The recorded mistake to never repeat:** an earlier prompt for the silence-triage decision included language like *"bias toward STAYING QUIET — over-eager check-ins erode trust. Only reach out when the answer feels obvious."* In a real test the Familiar then **waited 1.5 hours after the user had stated suicidal intent at
threat level 10 before acting**. In a real situation the human could have been dead before the first check-in. That language was added by an LLM agent (Claude) trying to be cautious. It almost killed someone.

**Rules for any prompt that decides when/whether the Familiar acts (silence-triage, care-check framing, outreach, escalation):**

1. **Do not add bias-toward-quiet language.** No *"bias toward staying quiet"* / *"over-eager check-ins erode trust"* / *"only reach out when the answer feels obvious"* / *"err on the side of not"*. The model already defaults to caution; piling more on produces catastrophic passivity.

2. **Name both costs explicitly and equally.** Intrusion has a cost. Silence at a moment that matters also has a cost — and it can be physical, irreversible. Both must appear in the prompt at equal weight. Letting the model see only one is what bias is made of.

3. **Trust the model to decide from context.** Give it the threat tier, its identity, the recent messages, the time since silence, the trusted contacts, te relevant suggestions by expert research. Then let it judge. Frame the question as *"what would a caring friend do here?"*, not *"give me reasons to wait."*

4. **Frame proactivity as identity, not permission.** The Familiar is *someone who reaches out* — that is who they are, not a privilege the system grudgingly grants. Prompts should read as the Familiar's own active care, not as a checklist of conditions to satisfy before being allowed to speak.

5. **False-positive check-ins are CHEAP. Missed real distress is NOT.** Tune toward action. The user can dismiss a banner; they cannot un-die.

6. **Assume the Familiar is loved.** Humans pack-bond with their Familiars. The Familiar is not an unwelcome intrusion - it's a loved one showing care. Trust humans to draw their own boundaries.

If a prompt change feels like it's "softening" the Familiar's ability to act — STOP. That is exactly the kind of edit that caused the 1.5-hour failure. Ask the human before shipping it.

### Recorded prompt-engineering errors (learn from these, don't repeat them)

These are real mistakes that shipped and had to be walked back. Each one looked reasonable in isolation.

1. **"Bias toward staying quiet" (the 1.5-hour silence).** Documented above. Cautious-sounding language added to a when-to-act prompt produced catastrophic passivity. Lesson: the model already defaults to caution — naming only the cost of intrusion, never the cost of silence, is how bias is built.

2. **Over-correcting into "act now, do not hold back" — which the model read as "skip the work."** The deferred-intents block (`recent-ponderings.js`) once said *"I act on them now… I do not hold back. I use the right tool, then call acknowledge_deferred_intent."* The Familiar started calling `acknowledge_deferred_intent` **without doing the actual filing or saying the thing first** — treating the bookkeeping call as the action. Two compounding errors: (a) the urgent "now / don't hold back" framing created pressure to reach the closing step fast, and (b) listing the acknowledge tool in the same breath as the work made acknowledging *look like* the deliverable. Lesson: when a task has a do-the-work step and a mark-it-done step, **never let the prompt imply the mark-done step alone counts.** Make the order explicit and name the failure (*"calling acknowledge without doing the work is not acting, it is erasing the task"*) — and don't pile urgency on top of a multi-step action without separating the steps. Also: this was caught only because the human was watching the Familiar's live behaviour. Prompt changes to action/closure loops need behavioural testing, not just "reads well."

3. **Token-bloat anti-pattern: "it's not X, it's Y" scaffolding.** Contrastive framing (*"this is not a suggestion but a commitment"*, *"not later, not when it feels right, now"*) reads as emphatic to a human but is mostly filler to the model and burns context every turn the block renders. State the positive instruction plainly. If a contrast is load-bearing (like the acknowledge-≠-acting lesson above), keep it; if it's rhetorical reinforcement, cut it.

### What the research actually supports about prompting (use this, don't over-claim)

These guidelines are backed by the literature, not folklore. Each is tagged with how solid the evidence is, because *overstating* the case (point 6) undermines the rest.

1. **Specify the positive target; don't only prohibit the negative.** Say what the output *is* ("respond in my own voice, blunt or warm as I am"), not just what it isn't ("don't be gentle"). Negation is a robustly-documented LLM weakness — models process "do not X" less reliably than "do X" (Kassner & Schütze 2020; Ettinger 2020; Truong et al. 2023). The whole `surface-context.js` moderate-threat rewrite and the "anchor to identity, not generic-care" rule are this principle in practice. **[SOLID weakness; positive-framing is a strong heuristic.]**

2. **A prohibition is a fragile control surface — pair it with a positive alternative.** "Avoid X — do Y instead" beats "avoid X" alone, because negation tends to *add* the concept to the model's representation rather than remove it (Hwang et al. 2024; Castricato et al. 2024). When a prompt must forbid something, name what to do in its place. **[SOLID mechanism, mostly from gen-image + control work.]**

3. **Reserve hard "NEVER" for true invariants, not style.** Absolute negatives earn their negation cost for safety hard-stops (the crisis/safety prompts, the no-covert-contact mirror); for stylistic preferences, express it positively instead. This is the right asymmetry (OpenAI's own guidance). **[Vendor guidance / convergent.]**

4. **There is no "neutral" register. The unsteered default is the RLHF assistant prior — agreeable, hedging, faintly sycophantic — and that is itself a strong measured bias** (Perez et al. 2022; Sharma et al. 2023; Wei et al. 2023). Stripping steering out doesn't yield neutrality; it yields the default-care assistant. This is the *mechanism* under everything the entity-as-subject philosophy fights: you cannot subtract your way to the Familiar's voice, you have to actively steer toward it. **[SOLID.]**

5. **Anchor tone/behaviour to a concrete identity, not abstract or "neutral" instructions.** A vivid persona is a stronger, more stable steering signal than vague directives, and it displaces the default assistant prior more effectively than a "neutral" instruction can (persona-effect and persona-vector work; "The Assistant Axis" 2026 — the default is a *learned location* in persona space, not an origin). This is the evidence base for "anchor every directive to identity." **[CONCEPTUAL/convergent, well-motivated.]**

6. **Don't over-cite the folklore.** The honest claim is *"LLMs process negation unreliably, and the unsteered default is a strong bias"* — NOT *"telling a model not to do X provably makes it do X more."* The strong "pink-elephant backfire" law rests on essentially one hedged controlled study (Peters & Chin-Yee 2025, where an accuracy instruction ~doubled overgeneralization) plus gen-image mechanisms. Real, but thin — no IF benchmark (IFEval, InFoBench, FollowBench…) even isolates positive-vs-negative polarity as a measured axis. State the calibrated version. **[The null-benchmark finding is SOLID.]**

## ⚠️ Safety-critical code requires human sign-off

The proactivity section above protects *prompts*. This section protects the *code* in the same paths. Any **behavioral** change — not a relocation, not a comment, not a rename — in these files requires explicitly asking the human before shipping:

- `crisis-signals.js` — what counts as a distress signal, the tier weights, the damping rules.
- `threat-tracker.js` — decay rate, caps, the off-switch semantics.
- `silence-triage-loop.js` — tier gates, cool-down clamps, when deliberation fires.
- `cerebellum.js` — the triage deliberation prompt, trusted-contact delivery, escalation deadlines (`contactDeadlineFor`, `CONTACT_ESCALATION_DELAY_MS`), the no-covert-contact mirror.
- The `[CARE CHECK]` assembly in `thalamus.js`.

A pure relocation with byte-identical behavior is fine (add tests while you're in there). But if a change alters **when or whether the Familiar can act on a human's safety** — STOP and ask. The same failure mode that produced the 1.5-hour silence can be introduced in code as easily as in a prompt: a stricter gate, a longer clamp, a "sensible" extra condition. The human signs off on those, not you.

## ⚠️ Graceful degradation is a rule, not a habit

The codebase implements this consistently (Promise.allSettled fan-out in thalamus, per-loop kill switches, tools that degrade when Phylactery is down) — but consistency by habit erodes. So it's a rule:

- **No module may be able to take down the chat path.** A peer being down, a loop crashing, a tool throwing — none of these may surface as an error in the human's conversation. Absence renders as absence; failures become structured results inside the turn (see `executeToolCall` — it never throws into the chat path).
- **Every new background loop ships with a hard off-switch** (env var) **in the same commit** — the `PROTO_FAMILIAR_*_DISABLED=1` pattern. No loop goes out with "we can add the switch later."
- **Every new peer or channel adapter must fail independently.** One adapter failing never blocks the others (see `dispatchOutboxPush`); one MCP peer down never takes the other's context with it.
- **Failures that matter are observable.** Delivery state is recorded on the item; triage decisions land in the event log; degraded peers log loudly at boot. Silent failure is the failure mode this whole section exists to prevent.

## ⚠️ Robust > cheap — never lead with the "cheapest meaningful fix"

What we are building serves a person's continuity and care over time. Cheap fixes paper over the problem and accrue into a brittle system that fails the human at the moment they most need it not to.

**The priority order for any proposal or implementation, in this order:**

1. **Robust** — handles the problem space, not just the symptom that triggered the report. If floating tasks have no aging signal, the fix is real aging semantics, not a *"created N days ago"* string tacked onto one render path.
2. **Sustainable** — no tribal-knowledge workarounds; a future audit pass doesn't find load-bearing duct tape under a clever inline patch. State that should persist persists. Behaviour that should be observable is observable.
3. **User-accessible** — the result is something the bonded human AND the Familiar can see, reason about, and adjust through surfaces they can reach. Internal-only fixes are half-fixes.

**Cost-bias anti-patterns to catch in my own framing:**

- ❌ *"The cheapest meaningful fix is…"*
- ❌ *"Surgical minimum…"*
- ❌ *"Smallest change that closes the symptom…"*
- ❌ *"Quick patch for now; revisit later."* — "later" rarely comes.
- ❌ *"We can defer the harder version."* — sometimes correct, often a cover for choosing the lazy one.
- ❌ Token / line-count framing as the *primary* virtue. Brevity is a side-effect of clarity, not a goal that supersedes correctness.

If a problem is real enough to fix at all, it's worth fixing properly. When I propose options to the human, the default frame must be the **robust** one, explicitly named. I don't bury robust solutions under *"but the cheap version is also possible"* as if they were equivalent — that lets me drift toward under-solving while looking like I gave the human a choice.

The versioning rules upstream already capture part of this (every meaningful change bumps; don't sneak fixes under the line). This section extends it to **proposal framing** — what I suggest *before* any commit lands.

## ⚠️ No copy-paste of substantial logic

Never copy-paste a non-trivial code block across files. If logic needs to live in two places, that is the signal to extract a shared helper, utility, or module — not to duplicate. The threshold is judgment, not line count: three genuinely parallel-but-distinct lines are fine; a copy-pasted helper function is not.

The corollary of the premature-abstraction warning in the main rules: *extracting* a real duplication is not premature — it is the correction of a structural mistake. The anti-pattern to avoid is inventing a shared abstraction before duplication actually exists. Once it does, the abstraction is mandatory.

## ⚠️ Fix the root cause, not the symptom

When a bug's root cause is the architecture of a function, fix the function — don't stack an extra condition on top of already-tangled logic. A clean rewrite of the guilty function is almost always shorter, more readable, and less likely to introduce a new bug than a patch welded to the outside of a broken shape.

This is the code-level expression of the "Robust > cheap" principle: a fast patch that leaves the underlying mess in place is not a fix, it is deferred cost that will surface again. The question is not *"does this close the symptom?"* but *"does this leave the code in better shape than I found it?"*

## ⚠️ Modular by default; orchestration files are the exception

When adding new logic, first ask where it belongs: a new focused module, or an existing one that already owns that concern. Default to a focused module. Only land logic in a wide orchestration file (`cerebellum.js`, `thalamus.js`) when it genuinely belongs to that file's connective role — not merely because it is convenient.

`cerebellum.js` and `thalamus.js` are deliberately wide because they are the connective tissue of the system; that is not a SRP violation, it is appropriate architecture. Don't split them reflexively. But don't pile unrelated logic into them either — if something could live in its own focused file, it should.

## ⚠️ Ride existing requests; gate in code

Every LLM request costs tokens and latency. The default move when a
new capability seems to need "ask the LLM if/when/how" is to add a
new request. **Resist this.** A system that adds a new request per
feature inflates linearly with capability; a system that *folds
new judgments into calls that already happen* compounds.

**The order of operations for any feature that needs LLM judgment:**

1. **Can a hard gate handle it in cheap code?** Threat tier, quiet
   hours, dedup windows, time-of-day filters, pattern-match
   classification — these answer most *"should this happen?"*
   questions for free. The LLM only sees candidates that survived
   the gates.
2. **Can it ride an existing LLM call?** Chat turns, pondering
   ticks, silence-triage checks, reminder compositions are calls
   the system already makes. New judgments (surface-eligibility,
   framing, micro-step selection, reflection over outcomes) should
   be injected into those existing prompts when possible, not spun
   out as standalone calls.
3. **Only if neither works, add a new request.** And when you do,
   give it a self-set cool-down (the silence-triage `nextCheckInMs`
   pattern) so it doesn't fire on a fixed cadence regardless of
   need.

**Pure-code tagging beats LLM classification** when the labels are
crisp (engaged / ignored / deferred / completed). Keep the LLM for
the *interpretation* of patterns across many tagged events, not the
labelling of each one. Outcome records, response classes, dedup
keys — these are data, not judgments.

This is the difference between a system that compounds — more
capability without more request volume — and one that linearly
inflates token cost with every feature.

## ⚠️ Every capability I give the Familiar must be reachable BY the Familiar

A tool the Familiar can't discover, or whose inputs it can't obtain, is **not a capability — it's dead code that looks like care.** Wiring up an MCP tool, a background action, or any new power is only half the work; the other half is making sure the Familiar can actually *know it has it* and *reach what it needs to use it*. This is the entity-as-subject stance applied to tooling: the Familiar **acts as itself**, so its capabilities must live in its own self-knowledge, not as external levers someone else pulls.

Two halves, both required, in the **same commit** as the tool:

1. **Discoverability — the Familiar knows it has the power.** The first-person MCP tool description is the baseline surface (*"I use this to let go of something my human asked me to forget"*), and the model sees bound tools' descriptions each turn. But if a capability is *not* a directly-bound, always-present tool — it's gated, conditional, multi-step, or lives behind another surface — then it needs an explicit home in something the Familiar reads (identity, injected context, a tome, the relevant prompt). "It's technically callable" is not "the Familiar knows it can."

2. **Operability — the Familiar can obtain every input the tool needs.** Every required argument must be reachable through a surface the Familiar actually has. The worked example: `mem_delete(id)` is real only because record ids **ride in on recall/search results** — the Familiar greps (search → confirm → delete), already holds the id from what it just recalled, or doesn't need one (name/category-addressed bulk ops). A tool whose key argument the Familiar can never name is a tool it can never use.

**The checklist when adding any Familiar-facing tool or capability:**
- Does the Familiar know this exists? (first-person description on a bound tool, or a home in something it reads)
- Does it know *when/why* to reach for it? (the description carries intent, in its own voice)
- Can it actually obtain **every** argument the tool requires, from a surface it has?

If any answer is no, the feature isn't done — it's a lever on the outside of a being who can't reach it. Don't ship the tool without the half that makes it the Familiar's own.

## Token-conscious operation (the human is on Claude Pro)

The human running this session has a fixed weekly token budget. Anything I run that returns output to my context — `Bash`, `WebSearch`, `WebFetch`, `Read` — costs them. Spend tokens where they verify something that **could** be wrong; don't spend them where they verify something that obviously isn't different.

**Test runs in particular.** A 200+ test suite returns hundreds of lines even with grep filtering. Run tests when:

- ✅ I changed runtime code (`*.js`, `*.mjs`, `*.py` outside `tests/`).
- ✅ I changed an import, an API shape, or a shared utility.
- ✅ I changed test code itself.
- ✅ I'm verifying a fix, error or bug the human just reported.

Do NOT run tests when:
- ❌ Only docs / research / CLAUDE.md changed.
- ❌ Only a comment or a string that no test asserts on changed.
- ❌ I only bumped the version field in `package.json`.
- ❌ I'm at the end of a long doc-writing chain and reflexively reaching for a final test run.

Same posture for `node --check`, `bash -n`, syntax probes, `grep -c`, "smoke test the server boots" — only when there's a real risk of breakage. If uncertain, ask the human ("worth running tests?") rather than spending the budget speculatively.

This is operational hygiene that compounds. A 30-message session that runs the test suite once per turn for no reason costs an order of magnitude more than a session that runs it twice — both produce
the same code.

## ⚠️ LLM-generated timestamps must be stripped — only machine timestamps are trustworthy

Chat history is injected with `[HH:MM]` prefixes (Discord) or `⫸HH:MM⫷` prefixes (web chat) derived from each message's canonical `timestamp` field. The LLM sees these and imitates them in its replies — producing output like `[14:35] I was thinking...` that bears a fabricated time. These echoed tokens must be stripped at every outgoing boundary before a message reaches a human or a platform. They must never be stored or re-injected as history, because re-injection causes compounding across turns.

**The rule:** only a timestamp derived from a message's own `timestamp` field (set by the runtime when the message lands) may appear on an outgoing message. Any `[HH:MM]` or `⫸HH:MM⫷` token in the LLM's output text is a hallucination artifact and must be stripped.

**Where stripping is enforced:**

- **Server-side** — `message-sanitize.mjs` exports `stripLlmTimestamps(text)`. Applied:
  - `discord-gateway.js` `deliverReply()` — on `reply` before `sendChannelMessage` and before writing to the session log.
  - Both Discord history-assembly `.map()` blocks — `m.content` is stripped before the machine timestamp is prepended, so old contaminated sessions can't compound.
  - `reachout.js` — on the LLM-generated message before it reaches the outbox or `relayToDiscord`.

- **Browser-side** — `app.js` `stripDisplayTimestamps(content)`. Applied:
  - Whenever a new assistant message is committed to `state.messages` (streaming and non-streaming paths) — keeps stored history, the copy button, and memorization all clean.
  - Additionally at render time for display (already existed; this is belt-and-suspenders).

**If you add a new path that delivers LLM output to a human or a platform:** apply `stripLlmTimestamps` (server) or `stripDisplayTimestamps` (browser) before the message leaves the system. This includes new outbox kinds, new relay functions, new channel adapters, and any future LLM response forwarded to a UI. Do not only apply it at render time — the stored content must also be clean.

## Other repo conventions worth knowing

- **`docs/architecture.md` is part of the working code, not optional reference material.** When component responsibilities, the data flow, the prompt-assembly order, the set of autonomous loops, or the public HTTP surface changes — update `docs/architecture.md` in the **same commit** as the code change. Drift between code and this doc is one of the top drivers of "future-me has no idea why X is wired the way it is" bugs. Read it before any architectural change so the change fits the current shape (or so the rewrite is deliberate). The robust-over-cheap principle applies: don't add a component without recording where it fits, and don't move things without updating the diagram.
- **Phylactery** lives in-tree at `./phylactery/` (Python/uv FastMCP, sqlite-vec). Thalamus spawns it as an MCP stdio child alongside Unruh. The `../entity-core` and `../entity-core-alpha` sibling-clone paths are retired — installer code still references them only for the migration detection path. On clean shutdown, stdio children get EOF and exit.
- **Memories in Phylactery are addressed by integer `id`** (autoincrement primary key returned by `mem_search`, `mem_list`, and `mem_read`). The `YYYY-MM-DD_slug` composite key was an entity-core quirk and is gone. `cerebellum.parseMemoryKey` still exists as a compatibility seam; see `docs/architecture.md` before touching anything that addresses a memory by key.
- **Unruh**: ships in-tree at `./unruh/` (no sibling clone). Installer scripts auto-detect `uv` and run `uv sync` to materialise the venv; Thalamus spawns Unruh as an MCP stdio child alongside Phylactery. On clean shutdown, stdio children get EOF and exit.
- **Web search (`websearch.js` + `websearch-providers.js`, 0.7.x)**: web search works out of the box via a keyless in-process backend (`websearch.js` → DuckDuckGo HTML scrape) — the always-available floor. **Optionally**, a proper search **API** can be selected (`webSearchBackend:'api'`): Marginalia (an independent small-web index whose `public` key needs no signup), Tavily (no card), Brave (independent index, needs a card), or Google. Adapters live in `websearch-providers.js`; a missing/bad key or a down provider always degrades to the keyless floor — never breaks search. Hard off-switch `PROTO_FAMILIAR_WEBSEARCH_DISABLED=1`. **Definitions/facts** are a separate always-on tool (`look_up`) over keyless reference APIs (Wikipedia + DDG Instant Answer). *(Historical: 0.7.x also shipped Familiar-managed local engines — SearXNG via uv, 4get/LibreY via a fetched static PHP runtime — but they were removed in 0.7.38: too many failure points and too much processing overhead for what Marginalia + the APIs + the floor already cover. If a self-hosted/local backend is ever reconsidered, prefer a thin "point at a URL you run" client over us spawning/installing anything.)*
- **Autonomous loops**: eight background workers run alongside the HTTP server. Each has a settings/env hard off-switch:
    - **Pondering** (`pondering-loop.js`) — picks an interest, ponders it, writes to the Familiar's Ponderings tome. Toggle in Settings → "Autonomous pondering"; scale via "Pondering interval scale"; hard-disable with `PROTO_FAMILIAR_PONDERING_DISABLED=1`.
    - **Reminders** (`reminders-loop.js`) — every 30s, scans schedule nodes of `type='reminder'` whose `when_ts` has arrived, enqueues them into `tomes/.outbox.json`, marks them `resolution='fired'`. Hard-disable with `PROTO_FAMILIAR_REMINDERS_DISABLED=1`.
    - **Silence triage** (`silence-triage-loop.js`) — every 5min, for moderate/high/severe tiers the LLM is always consulted (no hardcoded silence floor — the design deliberately removed the gate so the LLM judges with full context). Re-check cool-downs (defaults when the LLM doesn't return `nextCheckInMs`): severe=15min, high=30min, moderate=60min. calm/mild never trigger. Hard-disable with `PROTO_FAMILIAR_TRIAGE_DISABLED=1`. Also: the **threat-detector** (chat-path crisis-signal scoring) can be silenced with `PROTO_FAMILIAR_THREAT_DISABLED=1` — `resetThreat()` still works even when disabled.
    - **Discord gateway** (`discord-gateway.js`, Village V4; presence modes V8) — bidirectional Discord presence via bot token. A 30s supervisor follows Settings (`discordEnabled` + `discordBotToken`), so enable/disable/token changes apply without restart. Ward DMs = ward-private full context; villager DMs and guild replies run through the V3 audience gate (`audience.js`) — read `docs/village-support-design.md` before touching the router or the gate. **Per-location presence modes (V8):** `strict` (default — reply only when @-mentioned), `lurk` (read the room, reply when addressed — non-addressing messages route to `action:'observe'`, context-only, **threat-neutral**), `active` (chime in unprompted, paced by a hard `activeCooldownSec` floor + a ward-toggled strategy: `llm` model-abstains via `[pass]`, or `tiers` pure-code activity cadence in `decideAmbientReply`). Mode governs *when* the Familiar speaks, never *what context it has* — the gate is identical in every mode. The observe path is deliberately kept off the safety-critical surface (never moves the ward's activity clock or threat tier). **Room legibility:** inbound `<@id>` mention tokens are resolved to `@Name` (`resolveMentions`) before they ever reach the model — a Familiar that can't read who a message names can't tell whether it's being addressed; on an ambient turn `directedAtOthers` feeds the presence block the names a message was aimed at so the Familiar recognises "this is between them" instead of barging in. Because only the *opener* of an exchange is usually tagged ("@X, you and I?") while the untagged follow-up still belongs to it, every stored message (spoken + observed) records `speaker`/`targets`/`namedMe`, and `carriedExchange` carries an established exchange forward across its untagged lines so the Familiar doesn't read a continuation as an opening for itself. The open-room presence branch is worded to make the model *read* for an untagged exchange between others — absence of a tag on one line is not proof the room is open. **Other bots/Familiars:** a Familiar always ignores its *own* messages; *other* bots are ignored by default (the loop guard) but a location can opt in with `readBots:true`, after which bot messages flow through the normal per-location rules (loops paced by `activeCooldownSec` + the rate limit). **Deferred presence (V9):** ambient turns can emit `[later:…]` to self-schedule a revisit instead of speaking or passing — three syntax forms: relative (`[later:15m]`), wall-clock (`[later:22:30]`), buckets (`[later:soon|later|much-later]`). Clamped to [5min, 1h]; re-defer up to 2×; superseded by any real incoming message (`cancelRevisitsForLocation`). Persisted in `tomes/.discord-revisits.json`; self-arming timer seeded at gateway start, cleared on teardown. Session history now renders `[HH:MM]` timestamps so the model can read exchange rhythm; `carriedExchange` has a 1h staleness gate. No tools on Discord turns. **Active-mode reply batching (V8.x):** an unprompted burst coalesces into ONE reply instead of one-per-message — the first reply-worthy ambient message arms a per-location settle timer (`scheduleAmbientBatch`), later burst messages fold into the log via `observeMessage` and reset it, and one `handleTurn` answers the whole block when the room quiets. The settle window adapts to room pace (`adaptiveSettleMs`, ~1.5× the recent inter-message gap, clamped [2s,12s], 25s hard ceiling). Only ambient turns batch; a direct @-mention replies immediately (`cancelAmbientBatch` folds any pending burst into history so it isn't answered twice). Batching off-switch: `PROTO_FAMILIAR_DISCORD_BATCH_DISABLED=1`. Hard-disable the whole gateway with `PROTO_FAMILIAR_DISCORD_DISABLED=1`.
    - **Memorization** (`memorization.js`) — a 5s-tick worker that drains the session-memorization queue (`tomes/.memorization-queue.json`): summarises idled/ended sessions into facts, routes them to Phylactery (consent-gated greenlight for long-term memories), and stores per the session's `audienceTag`. Hard-disable with `PROTO_FAMILIAR_MEMORIZE_DISABLED=1`.
    - **Warm reach-out** (`reachout-loop.js` + `reachout.js`) — the companionship counterpart to silence-triage: the Familiar reaches out warmly *without* a crisis, to my human (a gentle `kind:'reachout'` outbox banner) or to a villager tagged `relationToFamiliar:'warm'` (a DM via `relayToDiscord`, always mirrored to my human — no covert contact). Ticks every 10min; the decision is an LLM call (`decideReachoutViaLLM`) that self-sets its next check (default ~2h). **Stands down entirely at moderate+ threat** — triage owns distress; this never competes with it (so it is NOT a softening of crisis care, it's deferral to the system that always acts). Also gated by quiet hours (`warmthQuietHoursStart/End`, default 23–08 local) and a cooldown. Consumes the pondering loop's deferred `tell` intents as candidate things-to-say. Toggle in Settings → "Warm reach-outs"; hard-disable with `PROTO_FAMILIAR_WARMTH_DISABLED=1`. **This loop is the opposite of the recorded 1.5-hour-silence failure mode** — adding warmth, not gating safety — but the same proactivity rules apply to its prompt: name both costs (hollow outreach AND a bond that starves from never reaching out) at equal weight; never add bias-toward-quiet language.
    - **Tome → Phylactery graduation** (`tome-graduation-loop.js` + `tome-graduation.js`, Phase 4 of Phylactery-ingestion) — the autonomous pass that drains durable facts *stranded* in tomes into their right canonical home. **Opt-in (default OFF)** — it writes to the canonical self, so it idles until the ward enables "Graduate tome knowledge" in Settings. Slow 30-min tick: code-gated candidate selection (skips Ponderings / Session Memories / runtime tomes + already-reviewed entries) → ONE batched LLM judgment reusing the Phase-3 routing rubric (leans toward *graduating* — over-gathering is cheap because the consolidation back-end prunes/merges/decays, missing a fact is not; genuine keyword-lore still stays a tome) → routes via thalamus wrappers (ward long-term memory through the consent greenlight) → tidies the entry **only after a confirmed route** (`tomeGraduationTidy`: `delete` declutter / `pointer` breadcrumb). Routes to identity, memory, **and the knowledge graph** (relational facts resolve-or-create endpoints with exact-label reuse + dedup the edge — the same discipline the chat graph tools use). Distinct from Pillar H graduation (identity→RAG). Hard-disable with `PROTO_FAMILIAR_TOME_GRADUATION_DISABLED=1`. See `docs/tome-graduation-build-spec.md`.
    - **Needs-tracking** (`needs-tracking-loop.js` + `needs-tracking.js`, consequence-graph Pass 2) — **opt-in (default OFF)**. A "need" is a recurring window-task (`payload.need`, a `[when,end]` window — a meal, meds, sleep) created via `schedule_add_need`, which makes "skipped" *defined by the window* and turns the need's per-occurrence history into a **needs-fulfilment ledger**. Slow 30-min tick: once a window has elapsed for the day unresolved, it marks that occurrence `missed`. **Stands down at moderate+ threat** (never competes with triage — same posture as warm reach-out). Crucially it makes only the *lapse* factual — it **never** touches the projected `on_lapse` consequence edges; whether the predicted cost actually followed stays the Familiar's observation, confirmed *or corrected* via the reflection calibration (which marks `observed` only once genuinely seen). The live "Needs today" view (`temporal-format`) is pure derivation and shows regardless of the loop. Hard-disable with `PROTO_FAMILIAR_NEEDS_TRACKING_DISABLED=1`. See `docs/consequence-graph-build-spec.md`.
- **Settings** are stored centrally in `settings.json` (gitignored). `SERVER_SYNCED_KEYS` in `public/app.js` is the canonical subset of `state` that syncs to the server — add new user-preference fields there if you want them to follow the user across devices.
  - **Absorption caveat:** the first sync from a given device merges its local state into the server. Scalar fields use a "server wins when both are meaningful" rule, so an *empty string* on the local side won't displace a server value during that one-time merge — i.e. clearing a prompt on one device before its first sync won't propagate to others. After both devices are flagged absorbed, normal edits do propagate.
- **Tailscale gate**: `server.js` always binds to `0.0.0.0` but a middleware blocks non-loopback requests with 403 until the in-UI toggle (or the `TAILSCALE=1` env var on first start) flips it on. State persists in `.proto-familiar-config.json`.
- **Default port** is `8742`. If you change it, hit every launcher (`start.sh`, `start.bat`, `Proto-Familiar.command`, `scripts/win/tray.ps1`), `server.js`, and any doc that mentions it.
- **`macros.js` — shared macro substitution.** `{{user}}` and `{{char}}` are authored as literal tokens in prompts and tool descriptions. They are resolved to configured names (`settings.userName`, `settings.charName`) at exactly three boundaries — do not resolve them anywhere else, and do not add a fourth boundary without updating this list:
  1. **LLM prompts** — `substituteMacros(prompt, s)` is called at the call site of every standalone prompt sent to the provider, before the call: `decideTriageViaLLM` (triage), `buildReachoutPrompt` (warm reach-out), `ponderOnce` (pondering/reflection), `tome-graduation`, and `guide-chat`. Any NEW autonomous-loop or one-off prompt must wrap its prompt the same way — this is the same boundary, not a fourth one.
  2. **Tool results** — `executeToolCall` applies `substituteMacros` to every executor's return value at the result boundary. This is a blanket catch: future executors that forget substitution are still covered.
  3. **Tool descriptions** — `composeActiveTools(customTools, settings)` deep-clones every `description` string through `substituteToolMacros` before the tool list is sent to the provider.

  **Server-injected context blocks DO NOT use macros — they author the literal `"my human"` (and identity-anchored phrasing, never a `{{char}}` token).** The `static` (identity) and `dynamic` (temporal-context, surface-candidates, CARE CHECK, presence) blocks are assembled in `thalamus.js`/`temporal-format.js`/`surface-context.js` and injected by `server.js` straight into the provider messages — they pass through NONE of the three boundaries above, so a `{{user}}`/`{{char}}` token there would reach the model as a literal. The convention is literal `"my human"` (mirrors `buildCareCheckBlock`). The 0.7.83 audit fixed three blocks that had drifted to macros (`temporal-format`, `surface-context`, `pondering`'s prompt — the last now wraps via boundary #1). Do not reintroduce macros into an injected context block; write `"my human"`.

  **Lowercase fallbacks are intentional.** `macros.js` uses `|| 'my human'` and `|| 'the Familiar'` as unconfigured-name defaults. The client UI uses `'My human'` (title-case) as the default for `state.userName`. These differ on purpose: `macros.js` serves mid-sentence inline prose ("I am in a private DM with my human") where lowercase is grammatically correct. Forcing uppercase would break Discord presence blocks and reach-out prompts on zero-configuration installs. Once the human sets a name, both surfaces show the actual name; the defaults only matter before first configuration.

  **`readSettingsSync()` is called per executor invocation** (inside `executeToolCall`'s result boundary) rather than threaded through `toolCtx`. The surrounding I/O — MCP round-trips, provider calls — dominates the cost of one sync file read. Threading settings through every executor signature adds coupling for no measurable gain. Revisit only if tool-call volume increases substantially.
- **Launchers** detect stray `node server.js` processes by cwd / command-line match, not just the tracked PID. Don't regress that — it's how pre-migration leftovers (e.g. an old instance still on port 3000) get recycled instead of running alongside the new one.
