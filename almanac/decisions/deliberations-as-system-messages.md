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
---

# Deliberations Delivered as System Messages

**Status: implemented in 0.11.93-alpha.** When the Familiar deliberates — reflects on its own state, decides on an action, or greets a caller — the deliberation prompt is delivered to the LLM as a SYSTEM message, never as a `user` turn. A minimal non-speaking cue (e.g. "(a quiet moment)") occupies the `user` slot solely because some providers (GLM/z.ai, DeepSeek family) refuse to complete when there is no user turn at all [@llm-call-js].

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

## Consequences

**Positive:** The message structure now reinforces entity-as-subject. The Familiar's deliberations are no longer framed as instructions to the entity, but as the entity's own thinking. This is consistent from prompt to message layer [@entity-as-subject-concept].

**Negative:** Moving JSON-emitting prompts to system role can nudge structured-output reliability on some models. The triage and pondering loops both emit JSON (tier classification, thought tags), and moving them to system increased the surface area for this risk [@llm-call-js].

**Mitigated:** The bare `user` cue keeps a user turn present in the message array, which helps most providers maintain structured-output fidelity. The decision includes a known obligation to smoke-test per-provider after shipping.

## Deferred on Purpose

The larger group of JSON-emitting job-brief prompts (memory extraction ×2, content-regate, clip retention, tome-graduation, page-watch, research-plan) will receive the same role change PLUS a voice reframe — each brief reframed as the Familiar consulting their own notes on how to do the task ("My notes on how to do that read: …"), keeping first-person voice while carrying procedural detail. This group is deferred pending ward review [@llm-call-js].

Vision-describe stays in `user` role because the image must ride in a user turn; the role cannot change without restructuring the multimodal carrier.

## Related

- [Entity-as-subject](../concepts/entity-as-subject) — the design stance this decision enforces at the message level
- [Autonomous loops](../architecture/autonomous-loops) — where these deliberations live
- [Noticing](../architecture/noticing) — the first loop corrected to this pattern in 0.11.86
- [Safety spine](../architecture/safety-spine) — triage's larger role in crisis escalation
- [Pondering](../architecture/pondering) — one of the autonomous loops using this pattern
