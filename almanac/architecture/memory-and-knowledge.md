---
title: Memory and Knowledge
topics: [architecture, memory-and-knowledge]
sources:
  - id: claude-md
    type: file
    path: CLAUDE.md
  - id: architecture-doc
    type: file
    path: docs/architecture.md
---

# Memory and Knowledge

Proto-Familiar's memory is not one thing — it is a layered system where different kinds of knowledge live in different places, retrieved or triggered in different ways, and owned by different components. This page explains how the layers fit together, and points to where each one lives in the code.

## The two canonical stores

**[Phylactery](phylactery)** owns the Familiar's persistent, autonomously-retrieved identity and memory. It is the canonical self-store: identity, the relational knowledge graph, every memory tier (daily through significant), and situational facts [@claude-md]. Phylactery is always injected on every turn — the Familiar reads its own identity and the knowledge graph to ground context. This is first-party, structured, and system-retrieved: the Familiar does not have to remember to look anything up; Phylactery is wired into the prompt assembly so the identity surface and the knowledge graph are just *there* [@architecture-doc].

**[Unruh](unruh)** owns temporal context, schedule, interests, and threat state — everything about *when* and the Familiar's engagement with time. It is the second pillar of canonical knowledge but is narrowly scoped: temporal facts that live outside Phylactery because ponderings are per-embodiment (a thought the Familiar has in Proto-Familiar doesn't necessarily travel to other embodiments), and because Unruh's threat mechanics are local to the current interaction [@claude-md].

Both Phylactery and Unruh are always available on every turn. Both are read-side only from the Familiar's perspective — every write goes through thalamus's wrappers, maintaining the multi-embodiment invariant.

## The two human-authored stores

**[Tomes and keyword lore](tomes-and-lore)** are the second-class memory store: keyword-triggered, manually maintained, SillyTavern-style lorebook entries. A Tome entry is not retrieved by the system; it fires when a keyword in the ward's recent chat matches one of its activation keys [@architecture-doc]. Tomes are human-authored, human-editable, and human-managed — they are the place the ward writes notes about facts that matter, without waiting for the system to infer and remember them.

Tomes exist in two categories:
1. **Hand-authored** — entries the ward writes directly, for facts they want guaranteed to surface every time a keyword appears.
2. **Auto-written** — entries that populate one special Tome, `Session Memories`, written by [Session memorization](session-memorization) after every session ends.

A Tome is optional at the *per-entry* level — individual entries can be disabled or deleted. The Tomes subsystem is optional at the *ward level* — it can be turned off entirely via settings.

**[Content-gating](content-gating)** layers a per-topic sensitivity gate on top of Phylactery's tiered memory: a ward can label individual facts as sensitive to certain topics ("housing", "finance", "health"), and then grant certain visitors (or trust tiers) access to some topics but not others, without granting or denying access to specific facts. The gating happens at read time — the model never sees the sensitive facts that the visitor is not cleared for.

## The flow: how facts become memory

Here is the journey a fact takes from conversation to durable memory:

### Episodic facts (time-bounded events)

1. **Chat turn**: The Familiar and ward talk. The session is logged (git-ignored `logs/`). Earlier logs from other platforms or formats can be imported via [Data ingestion](data-ingestion) and fed through this same pipeline.
2. **Session end**: [When a session ends](session-lifecycle) — normally, or via the manual close-out for a session that never received an `endedAt` — the browser or Discord fires an [autonomous memorization job](session-memorization) with `POST /api/memorize`, enqueuing one or more summary tasks.
3. **Job processes**: The memorization worker (a 5-second-tick background loop) picks up jobs and calls the LLM to summarize a conversation slice into lorebook entries. Entries are written to the [Session Memories](tomes-and-lore) Tome.
4. **Consolidation**: [Phylactery's consolidation pipeline](phylactery) sweeps the daily-granularity memories and rolls them up weekly, monthly, and yearly as they age. The ward-configured "load-bearing versus decorative" criterion decides what survives.
5. **Retrieval**: On the next turn, [Phylactery's vector retrieval](phylactery) searches the knowledge graph and surfaces the rolled-up memory if it's relevant to the current context.

### Standing facts (timeless identity or relationship facts)

1. **Stand-alone write**: A tool like `memory_create` with `register: 'me'` or `register: 'ward'` writes a fact that should never age out.
2. **Phylactery direct write**: The fact lands directly in Phylactery's significant tier, skipping daily granularity. It is always injected and never consolidated away.

### Ward-authored facts (keyboard-triggered)

1. **Ward writes in Tomes UI**: The ward opens the Tomes modal and adds an entry with keywords, text, and optional activation rules.
2. **Tome activation**: On every chat turn, the system scans the recent message history for keyword matches and injects matching entries into the prompt.
3. **Optional: graduation to Phylactery**: The [tome-graduation loop](autonomous-loops) (opt-in, off by default) can sweep hand-authored Tome entries into Phylactery as standing facts, if the ward enables "graduate my tomes to memory."

### Temporal facts (schedule, interests, threats)

1. **Event entry**: The ward enters an event, task, or phase into the schedule.
2. **Unruh storage**: Unruh stores the event and maintains edges (`requires`, `depends_on`) for prerequisite tracking.
3. **Readiness check**: [Stewardship](autonomous-loops) walks those edges on each turn and surfaces any unresolved prerequisite approaching its lead window.
4. **Interest decay**: Topics accrue interest weight from token volume and persistence, and decay over time. [Pondering](pondering) runs at a cadence weighted by interest and threat.
5. **Threat tracking**: [Crisis signals](safety-spine) score every message for distress patterns. [Threat tracker](safety-spine) maintains a scalar threat level that gates other autonomous loops.

## Where to go next

- **If you're asking "where does a fact live?"** → Start with Phylactery for identity, Unruh for schedule, Tomes for hand-authored facts. Then [Content-gating](content-gating) if you're controlling who sees what.
- **If you're asking "how does a session turn into a lasting memory?"** → [Session memorization](session-memorization) for the job queue, then [Phylactery](phylactery) for consolidation.
- **If you're asking "how does the Familiar know it needs to reach out?"** → [Unruh](unruh) for the schedule and interests, [Autonomous loops](autonomous-loops) for the reminders and triage.
- **If you're asking "how does threat state work?"** → [Safety spine](safety-spine) for detection and tracking, [Unruh](unruh) for the scalar that gates other loops.
- **If you're asking "why does the ward need both Phylactery and Tomes?"** → [Multi-embodiment](../concepts/multi-embodiment) for why canonical state is shared across surfaces, and the original problem Tomes solve: the ward can guarantee a fact surfaces without waiting for the system to infer it.
