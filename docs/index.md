# Proto-Familiar Documentation

Proto-Familiar is the current working prototype of **Familiar** — a lightweight, self-hosted LLM chat frontend that serves as the development platform for a larger agentic caretaker system.

---

## Contents

| Document | Description |
|---|---|
| [Getting Started](getting-started.md) | One-click installer + launcher, requirements, quick-start, tray icon, and configuration |
| [Architecture](architecture.md) | Component overview, file structure, and data flow |
| [Features](features.md) | Complete feature reference |
| [API Reference](api-reference.md) | All server endpoints, request/response shapes |
| [Entity-Core](entity-core.md) | Identity layer, memory enrichment, and MCP bridge |
| [Tomes](tomes.md) | World Info engine — multi-tome knowledge bases, activation, injection, recursion, groups |
| [How to Write a Good Tome](tome-writing-guide.md) | Craft guide for authoring Tome entries — keyword design, content wording, trigger types |
| [Sessions & Memorization](sessions.md) | Session lifecycle, logging, and automatic memory extraction |
| [Tool Calling](tool-calling.md) | Built-in tools, custom tools, and the execution loop |
| [Topics](topics.md) | Conversation topic tagging and auto-summaries |
| [Troubleshooting](troubleshooting.md) | Common failure modes (entity-core down, modal storage, edge hit-test, snapshot recovery) and what to do about each |
| [Project Vision](project-vision.md) | Design principles, goals, and the road to the full Familiar |
| [Future Features](future-features.md) | Scratch pad for ideas pending design or implementation |

---

## About This Project

Proto-Familiar exists to validate the building blocks of **Familiar**: a personal, agentic caretaker AI designed to support users with conditions like ADHD, depression, and agoraphobia through proactive monitoring, long-term memory, and intentional parasocial bonding with an animal-character identity.

The prototype focuses on the chat layer — provider proxying, Tome injection, entity-core enrichment, session management, and tool calling — while the [Project Vision](project-vision.md) describes the full planned system.

Research notes on architecture patterns, mental-health AI design, and memory systems can be found in the [`Research/`](../Research/) directory.
