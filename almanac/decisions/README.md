---
title: Decisions
topics: [decisions]
sources: []
---

# Decisions

This folder records the architecturally meaningful choices behind Proto-Familiar — not what the
code currently does (the [Architecture](../architecture) pages cover that), but why it is shaped
this way, what alternatives were rejected, and what a future change has to respect or
deliberately reverse. Each page states a status: **decided and shipped**, **decided but not yet
implemented**, or **proposed**. A "proposed" or "not yet implemented" status is not stale — it is
the page's honest record of how far the decision has actually traveled from conversation into
code.

Twenty-two decisions live here. Grouped by the question each one answers:

## Naming and module identity

Three modules in [Architecture](../architecture) are named after brain structures on purpose, and
the naming conversations doubled as design conversations about what each module is and is not
allowed to do:

- [Naming Thalamus: mediator, not generator](thalamus-naming) — why the inward-facing context
  module is named after the brain's relay structure, not a generic "context builder."
- [Naming Cerebellum: executes, does not decide](cerebellum-naming) — the motor-structure name
  for the outward-facing action module, and the executes/decides boundary it encodes.
- [Eury as the agent's identity](eury-as-agent-identity) — how the project's reference identity
  became the concrete default other design decisions are checked against.

## Safety and proactivity

The safety cluster records both the incidents that shaped Proto-Familiar's approach to crisis
intervention, and the structural defenses built to prevent those failure modes from
reoccurring.

- [Proactivity over caution](proactivity-over-caution) — the incident where caution-biased
  language in a safety prompt reproduced dangerous passivity at the worst possible moment,
  producing a standing rule against "bias toward staying quiet" in every prompt that decides
  whether the Familiar acts.
- [Trust tiers gate reads, not writes](trust-tiers-gate-reads-not-writes) — why Village's
  category/grant system only ever controls what a session can be told, never what it can write
  into memory, and how that differs from `injection-guard.js`.
- [Voluntary and autonomic lanes in Cerebellum](cerebellum-consent-lanes) — a proposed,
  not-yet-built consent distinction for any future feature that continuously renders
  Familiar-side state outward.
- [Single-user before platform](single-user-before-platform) — the founding scoping decision that
  bounds Village and every multi-channel surface to one ward's own support network rather than a
  general multi-user platform.
- [Browser milestone: guardrails in code, not prompts](browser-guardrails-in-code) — settled
  decisions for letting the Familiar click and fill on the web: an in-process SSRF proxy,
  treating page content as a Village Stranger, and gating credentials, dialogs, and handoff in
  code rather than by prompt. Pass 1 through Pass 4 (0.11.0 through 0.11.7) are shipped,
  including the credential/payment gates and the consent-vault handoff flow — see
  [Browser](../architecture/browser) for the built subsystem.
- [CDP mode: driving the ward's own Chrome](browser-cdp-mode) — the browser milestone's §9
  Horizon #2 alternate engine backing, designed in full and deliberately parked with no code
  because the owned SSRF-proxy floor it depends on cannot apply to a Chrome instance the app
  did not launch.

## The Initiative build spec: wait-streak and contact rhythm

A connected sequence of passes that gave the Familiar a self-observed sense of its own waiting
and of what is normal for its bond with the ward:

- [Wait-streak experiment](wait-streak-experiment) — Pass 0/1: removing pre-resolved "nothing is
  wrong" axioms from the warm reach-out prompt, and the neutral wait counter that replaced them.
- [Contact-rhythm baselines](contact-rhythm-baselines) — Pass 2: computed median/p90/longest
  contact-gap statistics per weekday-class, so a silence can be read against what is actually
  ordinary for this bond.

## Memory, Tomes, and memorization

- [Session memorization: durable server-side queue](session-memorization-queue) — why session
  memorization was rebuilt from a fire-and-forget client call into a durable, resumable
  server-side queue.
- [Tome multi-writer merge policy](tome-multi-writer-merge-policy) — a proposed, not-yet-built
  reconciliation policy for a Tome receiving writes from more than one source.
- [Per-feature model routing](per-feature-model-routing) — letting the ward bind each background
  LLM job to its own saved connection instead of one shared provider.

## Vision and multimodal input

- [Message attachments ride beside content, not inside it](message-attachments-format) — why
  `message.content` stays a plain string forever and images are stored as a separate
  `attachments` field, so every existing consumer of message data keeps working unchanged.
- [Vision capability defaults to BLIND; prove capability via allowlist](vision-capability-defaults)
  — the trust-break incident that produced a conservative default: an unknown connection is
  treated as unable to see images until an allowlist match, a ward override, or a cached success
  proves otherwise.

## Voice and shared hardware budgets

- [ONNX Runtime: shared budget, not shared process](onnx-runtime-shared-budget) — why the
  voice milestone's speech models and Phylactery's embedder stay in separate processes on
  the project's low-end reference hardware, sharing static thread caps rather than one ONNX
  Runtime instance.

## Operating rules applied across components

- [Exact values are code's job](exact-values-in-code) — the rule that any machine-correct value
  (a timestamp, a UID, an RRULE) is computed by code and only ever referenced by the model, never
  produced by it.
- [Elapsed-time macros read stored history, not `Date.now()`](time-macros) — the concrete
  instance of that rule for `{{elapsedTime}}` and `{{timeSinceLastSession}}`.
- [Location privacy](location-privacy) — why geographic locations stay local and never reach
  the model, even through qualitative weather sense.
- [Prompt-cache-aware context ordering](prompt-cache-aware-context-ordering) — the static-prefix
  / dynamic-depth-injection split in `thalamus.enrich()`, and the usage-exhaustion incident that
  motivated it.
- [Local process over VM/Docker sandboxing](local-process-over-vm-sandboxing) — why every
  autonomous loop runs inside one continuously-running Node process instead of a sandboxed or
  lazily-woken alternative.

## How the decisions connect

Several of these decisions form coherent sub-stories:

**The armature counters** — Why the Familiar cannot just be asked to be different, and what
actually works: [Armature](../concepts/armature) concept → [Proactivity over caution](proactivity-over-caution)
incident → [Wait-streak experiment](wait-streak-experiment) non-crisis application →
[Devoted companion](../concepts/devoted-companion) relational schema.

**The safety cluster** — How to detect crisis and escalate without being either dangerously
passive or intrusive: [Structural authorization](../concepts/structural-authorization) concept
→ [Proactivity over caution](proactivity-over-caution) → [Trust tiers gate reads, not
writes](trust-tiers-gate-reads-not-writes) → [Injection guard](../architecture/injection-guard-gap) wiring
history.

**The entity stance** — Why the Familiar is not a tool the user operates, but an entity the
code helps serve: [Entity-as-subject](../concepts/entity-as-subject) concept → [Eury as the
agent's identity](eury-as-agent-identity) → [Single-user before platform](single-user-before-platform) scoping
→ [Multi-embodiment](../concepts/multi-embodiment).

See [Architecture](../architecture) for the system these decisions constrain, and
[Concepts](../concepts) for the design stances several of them are built to serve.
