---
title: "ONNX Runtime: Shared Budget, Not Shared Process"
topics: [decisions, voice, phylactery]
sources:
  - id: voice-build-spec
    type: file
    path: docs/voice-build-spec.md
  - id: audio-worker
    type: file
    path: audio-worker.mjs
  - id: embed-py
    type: file
    path: phylactery/src/phylactery/embed.py
  - id: architecture-doc
    type: file
    path: docs/architecture.md
---

# ONNX Runtime: Shared Budget, Not Shared Process

**Status: decided, and shipped as far as Pass 1 goes.** Proto-Familiar runs two independent
ONNX Runtime consumers on the same reference hardware — Phylactery's `fastembed`
(`all-MiniLM-L6-v2`) embedder for memory retrieval, and the [Voice](../architecture/voice)
milestone's speech models (`sherpa-onnx-node`) — and decided against merging them into one
process to share a single ONNX Runtime instance. Instead they share a *budget*: static
per-model thread caps and process isolation, with the audio side already carrying its own
env-configurable caps in `audio-worker.mjs` [@audio-worker]. Live two-way conversation (Pass 2:
streaming ASR, barge-in, the compute governor) is not yet built, but the isolation shape this
decision produced already ships in Pass 1's TTS path.

## Context

Both consumers exist because of the same accessibility scoping: the reference machine is a
ThinkPad X380 Yoga (4c/8t U-series, 15 W, no GPU), chosen because it is the best hardware
available to the maintainer, standing in for the low-end, hand-me-down machines the project's
target wards are disproportionately likely to run it on [@voice-build-spec]. On hardware like
that, an extra always-resident model process is not free, so "should these two ONNX consumers
share a runtime" was a real question, not a hypothetical optimization.

The build spec's first draft of §2 justified putting the audio models in a separate child
process (`audio-worker.mjs`) with a single argument: native inference is blocking C++, and
in-process it would stall `server.js`'s event loop. That argument is true, but it is an
argument about `server.js` specifically. Phylactery's embedder does not run in `server.js` — it
runs inside Phylactery's own Python child process [@embed-py] [@architecture-doc] — so the
event-loop argument said nothing about whether audio and embedding could share a runtime with
each other. Read at face value, the argument was mistaken for ruling out all ONNX co-location,
when it only ruled out one specific one. This gap was found by tracing the argument during a
later development session, not by a design review that set out looking for it.

## Decision

Audio and embedding stay in separate processes, and what they share is a budget, not a
runtime: `audio-worker.mjs` sets ONNX Runtime intra-op thread caps at session creation (VAD 1,
ASR 2, TTS 2, speaker/KWS/LID 1, all capped under `audioThreads` = 3), configurable at the
process boundary via `PF_AUDIO_THREADS*` env vars so a ward can tune by ear without editing
code [@audio-worker] [@voice-build-spec]. This is deliberate, for three separable reasons that
answer three different questions [@voice-build-spec]:

1. **Against co-locating with `server.js`:** the original event-loop argument, which is real but
   narrow — it protects the Node event loop specifically, and stops there.
2. **Against co-locating with Phylactery's embedder:** ONNX Runtime's thread pool is
   per-process — there is no mechanism for two processes to share one scheduler. Genuine
   runtime sharing would require physically merging the processes: either audio moves into
   Phylactery (Python), or the embedder moves into the audio worker (Node). Both were rejected.
   Audio into Phylactery would put a crash-prone real-time native pipeline inside the canonical
   self-store, so a barge-in bug could restart the ward's memory and identity store, not just a
   call. Embedding into the audio worker would make Phylactery's dedup, recall, and
   consolidation depend on a Node process that only exists when voice is enabled, breaking
   modular-by-default. Separately, the two workloads are largely **serial within a turn** — VAD
   and ASR run while the ward speaks, the embed runs at enrichment, the provider call is a
   network wait with the CPU idle, TTS runs after the reply text exists — so a shared scheduler
   would rarely have two live consumers to arbitrate between. The overlaps that do exist are
   narrow and already bounded by static caps: barge-in (cheap VAD running against TTS) and group
   calls (at most 2 ASR decode streams, `voiceMaxDecoders`).
3. **Isolation buys supervision.** The audio worker is restarted on crash with backoff
   [@audio-worker]; a shared process would mean an audio crash restarts the memory and identity
   store along with it.

## Consequences

Two `onnxruntime` native libraries load on disk instead of one (the Python wheel Phylactery
uses, and the `sherpa-onnx-node` prebuilt), and two thread pools run that cannot see or arbitrate
against each other. That is coarser than a genuine shared scheduler would be, but it cannot
deadlock, and [Voice](../architecture/voice)'s later footprint measurements found the Python
venvs (Phylactery's and [Unruh](../architecture/unruh)'s combined) already cost more disk than
the entire default voice install — the two-process shape was not, in practice, the dominant cost
this project's accessibility framing worried about. The static caps in `audio-worker.mjs` are
the concrete, already-shipped result of reason 2 above; Pass 2's compute governor (barge-in,
live interference measurement between a call and a concurrent `mem_search`) extends the same
budget-sharing shape to the harder simultaneous case, rather than revisiting whether to share a
runtime at all.

## Related

- [Voice](../architecture/voice) — the milestone this decision constrains; see its interference
  budget section for how Pass 0 measured the one case (a live call plus a concurrent
  `mem_search`) this decision predicted would rarely contend.
- [Phylactery](../architecture/phylactery) — the other ONNX Runtime consumer, and the canonical
  self-store this decision keeps isolated from a real-time native pipeline's crash risk.
- [Local process over VM/Docker sandboxing](local-process-over-vm-sandboxing) — a different
  process-boundary decision in this project; that one keeps autonomous loops inside one process
  for simplicity, while this one deliberately adds a process boundary for crash isolation. Read
  together they show process count here is chosen per case, not by a single blanket rule.
