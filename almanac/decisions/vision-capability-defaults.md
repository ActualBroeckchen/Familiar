---
title: "Vision capability defaults to BLIND; prove capability via allowlist"
topics: [decisions, vision]
sources:
  - id: vision-js
    type: file
    path: vision.js
---

# Vision capability defaults to BLIND; prove capability via allowlist

**Status**: Shipped in 0.10.89-alpha (PR #275).

**Decision**: When vision capability is unknown or uncached (e.g., `visionCapable: 'auto'`), treat the connection as BLIND unless the model name matches a tight allowlist of known vision families. Require explicit positive evidence (allowlist match, ward 'yes' override, or cached success) before sending images live to an LLM. Default ambiguous cases toward description, never toward live image transmission.

## Context

In 0.10.88-alpha, the vision system used optimistic capability detection. When `visionCapable: 'auto'` was uncached, the materializer assumed the connection could see images and sent them live to the primary model as a probe. If the model couldn't actually handle image modality, it was expected to reject the request with a 4xx error, triggering mid-turn fallback to text stand-ins [@vision-js].

A tester shared a photo. The primary model (GLM, text-only) was active; a vision model (Qwen) was assigned to the vision feature. The materializer sent the image to GLM expecting rejection. GLM did not reject — it accepted the request, had no idea what the image contained, and confabulated a detailed description of the ward's face. This was a trust-break: the ward saw the Familiar gushing about details it invented, triggering them severely.

The root cause was betting safety on a clean error that the provider did not give. Blind models do not always respond with modality errors; some silently fail or return 200 with hallucinated content. Once an image reaches a text-only model, the harm is done: the model has permission to confabulate, and the rejection path (mid-turn fallback) is already too late.

## Decision

The system now defaults to BLIND for any connection whose vision capability is unknown.

**Proof by allowlist**: `looksVisionCapable()` maintains a tight allowlist of known vision-capable model families (e.g., `glm-4v`, `glm-4.6v`). Text-only siblings (bare `glm-4.6`, `glm-5.2`) are explicitly NOT recognized, preventing false positives even when names share a prefix [@vision-js]. Models outside the allowlist are treated as BLIND — their images are described by the vision connection instead of sent live.

**Explicit assignment as override**: A ward can explicitly assign a vision-capable connection to the vision feature (e.g., "use Qwen for image understanding"). This explicit choice honors their word and routes images live to that connection. Omitting an assignment defaults to the primary connection, which may or may not see images — the primary is not a vision choice [@vision-js].

**Cached success as proof**: After a successful live image turn with a previously unknown model, the capability is cached in `tomes/.vision-capability.json` keyed by `provider:model`. Future turns reuse the cached result, avoiding redundant probes [@vision-js].

**Hard confabulation guard**: When an image reaches the materializer with no description (fresh attachment, not yet described), the system injects a hard system-prompt line: the Familiar never guesses, names, or describes what it cannot see; it plainly says it can't see and asks [@vision-js]. This guard rides the shared materialization seam, protecting all surfaces (web, Discord, voice) equally [@vision-js].

## Consequences

**Asymmetry principle**: The system is asymmetric about the cost of being wrong:

- **False negative** (real vision model, treated as BLIND): The model's images are described instead of sent live. Quality cost: descriptions are higher-latency (separate LLM call) and may lack some nuance. Acceptable price.
- **False positive** (blind model, treated as LIVE): The model receives permission to confabulate in response to bytes it cannot parse. Trust cost: the ward sees made-up details and loses confidence. Unacceptable.

The asymmetry drives the design: the cheap-to-be-wrong direction (describe) is the default; the expensive-to-be-wrong direction (live image) requires positive evidence.

**No extra LLM calls for the probe**: Cached successes and the allowlist mean real vision models are recognized without an extra round-trip. The only overhead is checking a local name against a known list [@vision-js].

**Ward agency preserved**: Explicit vision feature assignment and the ward's cached 'yes'/'no' preference are honored, letting them override the conservative default when they know better [@vision-js].

**Safe even when providers change**: Allowlists are conservative and explicit; they can be updated as new vision models ship without risking a silent regression. Text-only model updates (e.g., a new GLM release) are safe by default; they would need to be explicitly added to the allowlist to be treated as vision-capable.

## Lessons

Generalizable design principles for future capability detection work:

1. **Don't bet safety on provider rejection**: "Optimistic capability + rely on the provider to reject" is unsafe when the failure mode is silent. A provider that returns 200 + content instead of a modality 4xx error breaks the fallback assumption. Default to the safe branch (describe, degrade), not the hopeful one (try it live).

2. **Make asymmetry explicit and correct**: When a heuristic can be wrong in both directions, make the asymmetry clear. The cheap-to-be-wrong direction (describe an unknown, graceful degradation) must be the default. The expensive-to-be-wrong direction (send something live to a blind consumer, trust-break) must require positive evidence: allowlist match, explicit user choice, or cached confirmation.

3. **Add hard invariants where describe/stand-in can still fail**: Even when images degrade to descriptions, the model could still confabulate details it's not supposed to know. Add a prompt-level invariant in the shared seam that the model must never guess about unseen content — it must plainly say it can't see and ask. This protection rides every surface equally, not embedded per-UI-layer.

## Related

- [Vision and media](../architecture/vision-and-media) — the architecture that implements this decision, including allowlist checks, explicit assignment, and the confabulation guard injection point.
- [Message attachments ride beside content](message-attachments-format) — the complementary decision that keeps images out of the message string, enabling clean fallback to text-only views.
