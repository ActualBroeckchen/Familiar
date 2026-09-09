---
title: Getting Started
topics: [architecture]
sources: []
---

# Getting Started

Proto-Familiar is a persistent AI companion whose identity and memory live in a separate canonical store, making it one embodiment of an entity rather than a standalone chatbot. Start here to build a working model of the system.

## Five core pages for new readers

If you are new to this codebase, read these in order:

1. **[Architecture](architecture)** — The system map: the Node.js server, the thalamus/cerebellum split, the caring spine, and where each subsystem lives.

2. **[Entity-as-subject](concepts/entity-as-subject)** and **[Multi-embodiment](concepts/multi-embodiment)** — The design stance everything else in this repo is built to serve. The Familiar is the entity itself, not a tool operated on its behalf, and it is one embodiment of an entity whose identity and memory live in a canonical store.

3. **[Core prompts and multi-surface assembly](architecture/core-prompts)** — The four core prompts that define identity, why they must be assembled server-side, and the lesson for building capabilities that work across web, Discord, and voice.

4. **[Proactivity over caution](decisions/proactivity-over-caution)** — The incident that shapes every prompt governing when the Familiar acts on its own. This is the safety-critical instance of the armature problem.

5. **[Engineering conventions](reference/engineering-conventions)** — The repo-wide operating rules (versioning, degradation, ids, MCP contracts) referenced throughout the architecture pages.

## By topic

Once you understand the core stance, find what you're looking for:

- **Identity and memory** → [Phylactery](architecture/phylactery), [Unruh](architecture/unruh), [Memory and knowledge](architecture/memory-and-knowledge)
- **Session and Tome memory** → [Session memorization](architecture/session-memorization), [Tomes and keyword lore](architecture/tomes-and-lore)
- **Safety and crisis** → [Safety spine](architecture/safety-spine), [Structural authorization](concepts/structural-authorization)
- **Acting on its own** → [Autonomous loops](architecture/autonomous-loops), [Pondering](architecture/pondering)
- **Outside the ward** → [Village, audience gating, Discord](architecture), [Trust tiers gate reads not writes](decisions/trust-tiers-gate-reads-not-writes)
- **Multimodal input** → [Vision and media](architecture/vision-and-media), [Browser](architecture/browser), [Voice](architecture/voice)
- **LLM providers and connections** → [Providers and connection readiness](architecture/providers), [Per-feature model routing](decisions/per-feature-model-routing)
- **The product philosophy** → [Concepts](concepts), [Decisions](decisions)

## Index

- [Concepts](concepts) — All repo-specific vocabulary indexed by cluster.
- [Architecture](architecture) — All system areas indexed with quick-answer routing.
- [Decisions](decisions) — All recorded architectural choices, indexed by question.
- [Reference](reference) — Exact lookup material: engineering conventions and operating rules.
