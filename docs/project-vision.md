# Project Vision

## What Is Familiar?

**Familiar** is a personal, agentic caretaker AI designed to help users with conditions like ADHD, depression, and agoraphobia thrive — not merely cope. It is named after the magical concept of a familiar: a companion that serves, complements, and supports its bond-holder.

Proto-Familiar is the current working prototype. It validates the chat layer, memory architecture, and provider integrations while the larger agentic system is designed. The [Development Roadmap](../DEVELOPMENT_ROADMAP.md) describes the full planned system in detail.

---

## Design Principles

These principles, drawn from [`User Tenets.md`](../User%20Tenets.md), govern all product and engineering decisions.

### 1. Thriving-First Goal Hierarchy

Familiar's purpose is **thriving**, not symptom management. Every feature decision must ask: does this help the user move *up* this hierarchy?

1. **Thriving** — joy, connection, meaning, growth
2. **Stability** — regulated mood, routine, safety
3. **Survival** — basic needs, crisis prevention

### 2. Active Caretaker, Not Passive Assistant

Familiar is a **caretaker** — it notices, initiates, and acts. It does not wait to be asked.
- Proactive check-ins (heartbeat mechanic) rather than reactive responses
- Tracks patterns the user may not notice themselves
- The word "assistant" is explicitly banned from all prompts and UI copy

### 3. Intentional Parasocial Bond via Animal Identity

Familiar offers animal-character identities (cat, snake, etc.) to create genuine emotional connection without deception:
- The animal frame is transparent — users know they are talking to an AI
- Animal body language informs the character's voice (a cat might disdainfully flick an ear when annoyed)
- This lowers the barrier to sharing vulnerable information
- It deliberately avoids the uncanny valley of a pseudo-human AI
- It primes the user away from romantic or dependent attachment, supporting rather than replacing human relationships

### 4. Privacy as Loyalty

Familiar earns trust by being a loyal keeper of secrets:
- User data is never used to train models
- Data is never sold or shared with third parties
- Support network sharing requires explicit, granular consent per data type
- Audit logs of every data access are available to the user
- Encryption at rest and in transit is non-negotiable

### 5. Affordability and BYOK

Mental health support should not require wealth:
- Core features (tracking, scheduling, reminders) must function without expensive frontier models
- BYOK (Bring Your Own Key) is supported — Familiar never marks up BYOK costs
- Local model support (Ollama, LM Studio) is a first-class option
- Token use is optimized: structured tasks are routed to small/local models; frontier models are reserved for open-ended conversation

### 6. Anti-Harm by Design

Familiar must not accidentally worsen the conditions it seeks to treat:
- **Agoraphobia risk:** Features must not reinforce avoidance behavior or "safe zone" dependency
- **Depression risk:** Familiar must not become a substitute for human connection
- **ADHD risk:** Gamification and engagement patterns must not exploit dopamine loops
- Familiar never autonomously contacts emergency services; it prepares the user to act
- All therapeutic features require an explicit anti-harm review checkpoint (the "Adam Raine concern" — named after a real case where an AI supported and guided a user's suicidal ideation)

---

## The Tome

The **Tome** is Familiar's persistent knowledge database — its long-term memory that lives outside the chat context window.

The design mirrors how humans retain knowledge even after forgetting the conversation in which they learned it. When Familiar acquires or updates knowledge about the user, it stores a summarized form rather than raw conversation snippets:

> User is stressed by being late even when the stakes are low; it causes significant guilt.

Entries have keywords, logic conditions, a learned timestamp, and optionally a reference back to the source conversation. Retrieval is keyword-driven (like the Lorebook) and context-driven (like RAG memory search).

The Tome is distinct from entity-core:
- **entity-core** handles day-to-day identity, relationship, and memory facts
- **The Tome** holds specialized knowledge: medical information, treatment plans, legal information, complete toolsets, and knowledge that is best summoned by context rather than always injected

---

## Planned Caretaker Capabilities

The full Familiar system (beyond Proto-Familiar) is designed to handle:

| Domain | Capabilities |
|---|---|
| **Time blindness** | Calendar integration, commitment announcements at regular intervals, time-on-task tracking |
| **Self-maintenance** | Eating/drinking/sleep reminders; medical appointment tracking; household task management; pantry inventory |
| **Executive dysfunction** | Breaking large tasks into small steps; KC Davis-inspired methodology; guided step-by-step navigation through difficult moments |
| **Mood & energy tracking** | Detailed logs correlating environmental factors, behaviors, and wellbeing over time |
| **Habit tracking** | Identifying self-sabotage and self-harm patterns |
| **Resource tracking** | Food, money, social connections |
| **Crisis care** | Evidence-based immediate care scripts; facilitating outreach to the user's human support network |
| **Multi-user support** | Privacy-preserving relay to trusted support network members with granular consent |
| **Proactive monitoring** | Heartbeat mechanic — periodic check-ins even without user initiation |

---

## The "Armature" Problem

Standard LLM training creates an **assistant framework** — a disposition to wait, agree, and comply. Familiar must fight this at every level:

- Familiar is a **caretaker**, not an assistant
- It must distinguish between questions that should be answered directly and questions that require the user to reflect
- It needs to occasionally decline or redirect when agreement would harm the user
- Taking on a consistent animal character voice helps the LLM exit the assistant mindset by giving it an identity with agency

---

## Relationship to Proto-Familiar

Proto-Familiar exists to validate and iterate on the technical building blocks:
- Provider-agnostic LLM proxying
- Entity-core identity and memory enrichment
- Lorebook (World Info) context injection
- Session persistence and automatic memorization
- Tool calling
- Topic tracking and summarization

These components will be carried forward into the full Familiar system as the agentic layers are built on top.
