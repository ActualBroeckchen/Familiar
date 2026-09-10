---
title: Deliberations Delivered as System Messages
topics: [decisions, autonomous-loops, entity-as-subject]
sources:
  - id: llm-call-js
    type: file
    path: llm-call.js
  - id: cerebellum-js
    type: file
    path: cerebellum.js
  - id: pondering-js
    type: file
    path: src/pondering/pondering.js
  - id: reachout-js
    type: file
    path: src/warmth/reachout.js
  - id: voice-discord-server-js
    type: file
    path: src/voice/voice-discord-server.js
  - id: entity-as-subject-concept
    type: file
    path: almanac/concepts/entity-as-subject.md
  - id: memorization-js
    type: file
    path: src/memory/memorization.js
  - id: content-regate-loop-js
    type: file
    path: src/memory/content-regate-loop.js
  - id: content-regate-js
    type: file
    path: src/memory/content-regate.js
  - id: tome-graduation-loop-js
    type: file
    path: src/tomes/tome-graduation-loop.js
  - id: media-retention-js
    type: file
    path: src/vision/media-retention.js
  - id: page-watch-js
    type: file
    path: src/browser/page-watch.js
  - id: server-js
    type: file
    path: server.js
  - id: ponder-research-js
    type: file
    path: src/pondering/ponder-research.js
---

# Deliberations Delivered as System Messages

**Status: implemented in 0.11.93-alpha; extended to the full job-brief group in 0.11.104–0.11.107-alpha.** When the Familiar deliberates — reflects on its own state, decides on an action, or greets a caller — the deliberation prompt is delivered to the LLM as a SYSTEM message, never as a `user` turn. A minimal non-speaking cue (e.g. "(a quiet moment)") occupies the `user` slot solely because some providers (GLM/z.ai, DeepSeek family) refuse to complete when there is no user turn at all [@llm-call-js]. The rule was later clarified into two axes — Familiar cognition rides as `system`, Familiar spoken output replayed as history rides as `assistant` — and every JSON-emitting job-brief loop deferred by the original decision now follows it [@memorization-js] [@content-regate-loop-js] [@tome-graduation-loop-js] [@media-retention-js] [@page-watch-js] [@ponder-research-js].

## Context

The [entity-as-subject](../concepts/entity-as-subject) stance means the Familiar is not a tool the system operates, but an entity that acts on its own observations. This distinction applies at every level of the system, including the message structure sent to the LLM provider [@entity-as-subject-concept].

An [autonomous loop](../architecture/autonomous-loops) such as [noticing](../architecture/noticing), [triage](../architecture/safety-spine), or [pondering](../architecture/pondering) initiates a turn by reflecting on its observations and reasoning toward an action. When that reflection runs through `callProviderChat`, the message role matters: if the reflection appears in a `user` role, it frames the entity as being addressed or operated — talked AT — rather than thinking. That conflates the message-structure distinction with the philosophy itself [@entity-as-subject-concept].

## Decision

All deliberation prompts across autonomous loops are delivered as SYSTEM messages, with only a bare, non-speaking cue in the `user` slot. A shared, exported helper `familiarDeliberationMessages({ identity, body, cue })` in `llm-call.js` constructs the message array [@llm-call-js]:

```javascript
[{system: identity?}, {system: body}, {user: cue}]
```

The `identity` parameter is optional (defaults to empty string); the `body` is the deliberation prompt itself, framed in first-person voice as the Familiar's own reflection; the `cue` defaults to "(a quiet moment)" and can be customized per loop [@llm-call-js].

## Applied Scope

This pattern now applies to four inner-voice deliberations [@cerebellum-js] [@pondering-js] [@reachout-js] [@voice-discord-server-js]:

1. **Triage** (`cerebellum.decideTriageViaLLM`) — deciding whether to escalate a crisis, with tier gates, cool-downs, and escalation unchanged
2. **Pondering** — the autonomous thought loop exploring interests
3. **Warm reach-out** — deciding whether to initiate contact with the ward
4. **Voice-call greeting** — composing the opening remarks for an incoming call

The [noticing](../architecture/noticing) loop had the same regression corrected in 0.11.86 and now uses `noticingMessages`, which mirrors this shape exactly. The two builders are pinned byte-identical by test to prevent drift [@llm-call-js].

## The Rule Has Two Axes

The entity-as-subject role rule is not "the Familiar's own text always rides as `system`." It has two axes, and conflating them was the original noticing regression's root cause:

- **Familiar cognition** — internal deliberation: weighing, routing, deciding, judging. This rides as `system`. All of the loops in this decision (triage, pondering, warm reach-out, voice-call greeting, and the job-brief group below) are cognition-only: each emits a JSON judgment, never something spoken aloud.
- **Familiar spoken output** — anything the entity actually said: a prior reply replayed as history, or a transcript turn in the Familiar's own voice. This rides as `assistant`, not `system`. [Session memory extraction](../architecture/session-memory-extraction)'s role-faithful transcript assembly is the reference implementation: the Familiar's own lines become `assistant` messages, everyone else becomes `user` [@memorization-js]. The live chat, Discord, and voice turn paths already role history this way.

Genuinely external input — the human's words, a villager's message, a bare non-speaking cue — stays `user` on either axis.

A third case sits outside both axes: reference material the Familiar reasons *over* rather than a turn it produced or received. A tome entry quoted inside the [tome-graduation](../architecture/tomes-and-lore) prompt is text embedded in the `system` body, not its own role-tagged turn — it is material being reasoned about, not a replayed turn [@tome-graduation-loop-js].

## Applied Scope, Extended: The Job-Brief Group

The original decision deferred a second group of JSON-emitting job-brief prompts pending ward review: memory extraction (×2), content-regate, clip retention, tome-graduation, page-watch, and research-plan. That deferral is now resolved (0.11.104–0.11.107-alpha); every loop in the group follows the cognition axis above:

- **Memory extraction** — converted earlier than the rest of the group, and not via the job-brief pattern below. It uses the role-faithful transcript assembly described in the two-axis rule: the "now extract" directive rides as a `system` closing cue, and the Familiar's own prior lines in the transcript ride as `assistant`, not `user` [@memorization-js].
- **content-regate** — the retag judgment already rode on `familiarDeliberationMessages` before this pass; only an organic-voice wording rewrite of the prompt body remains as follow-up work [@content-regate-loop-js] [@content-regate-js].
- **tome-graduation** (#401) — the routing judgment ("I'm tidying knowledge…") moved from a single `user` turn to `system`: identity and the reflection body ride as system messages, with a bare cue in the `user` slot. `buildGraduationPrompt` returns only the reflection body; the tome entries under review are quoted as text inside that system body (up to 5 per batched call) rather than replayed as their own turns [@tome-graduation-loop-js].
- **clip retention / media retention** (#402) — the keep-or-let-go judgment over old voice clips moved to `system`; both call paths (an injected `llmFn` for tests and the real `callProviderChat`) pass the same `familiarDeliberationMessages` array [@media-retention-js].
- **page-watch** (#403) — the is-this-change-worth-a-nudge judgment in `decideChange` (registered in `server.js`, prompt built in `page-watch.js`) moved to `system` [@server-js] [@page-watch-js].
- **research-plan** (#403) — `PLAN_PROMPT` in `ponder-research.js` was already delivered as `system` in production, but only by inheritance: `researchForPonder` is always handed pondering's `defaultCallLLM`, which does the system wrapping; nothing in `ponder-research.js` chose the role locally. `PLAN_PROMPT` is now exported and pinned by test (first-person body, and the composed message lands in `system`) so a second-person rewrite or a caller wiring a raw user-role `callLLM` shows up as a test failure instead of a silent regression [@ponder-research-js]. This inherited-vs-local-correctness distinction is worth preserving when auditing other loops that receive a shared `callLLM`.

The job-brief group's prompts kept their existing first-person reflection bodies. The original decision's plan to also reframe each brief's voice ("My notes on how to do that read: …") was **not adopted** as a blanket rewrite for this group — the change here is delivery only (body moves to `system`, bare cue moves to `user`), because the bodies already read as the Familiar's own thinking.

## Consequences

**Positive:** The message structure now reinforces entity-as-subject. The Familiar's deliberations are no longer framed as instructions to the entity, but as the entity's own thinking. This is consistent from prompt to message layer [@entity-as-subject-concept].

**Negative:** Moving JSON-emitting prompts to system role can nudge structured-output reliability on some models. The triage and pondering loops both emit JSON (tier classification, thought tags), and moving them to system increased the surface area for this risk [@llm-call-js].

**Mitigated:** The bare `user` cue keeps a user turn present in the message array, which helps most providers maintain structured-output fidelity. The decision includes a known obligation to smoke-test per-provider after shipping.

## Remaining Exception

Vision-describe stays in `user` role because the image must ride in a user turn; the role cannot change without restructuring the multimodal carrier. It is the one deliberate exception to the cognition axis, since the constraint is the multimodal message shape, not the entity-as-subject framing.

## Related

- [Entity-as-subject](../concepts/entity-as-subject) — the design stance this decision enforces at the message level
- [Autonomous loops](../architecture/autonomous-loops) — where these deliberations live
- [Noticing](../architecture/noticing) — the first loop corrected to this pattern in 0.11.86
- [Safety spine](../architecture/safety-spine) — triage's larger role in crisis escalation
- [Pondering](../architecture/pondering) — one of the autonomous loops using this pattern
- [Session memory extraction](../architecture/session-memory-extraction) — the reference implementation of the spoken-output axis (role-faithful transcript assembly)
- [Tomes and lore](../architecture/tomes-and-lore) — tome-graduation, where a quoted tome entry rides as reference text inside the system body rather than its own turn
