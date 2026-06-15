# Proto-Familiar Wiki

Welcome to the project wiki for **Proto-Familiar**, a lightweight self-hosted chat frontend for NanoGPT and Z.ai.

## Start Here

- [Getting Started](Getting-Started.md)
- [Configuration & Features](Configuration-and-Features.md)
- [Server API](Server-API.md)
- [Research Guide](Research-Guide.md)

## What this project is

Proto-Familiar is a local-first chat UI with:

- provider switching (NanoGPT, Z.ai Standard, Z.ai Coding Plan)
- streaming and non-streaming chat
- configurable prompt layers (system/character/user/post-history)
- built-in and custom tool definitions
- session logs stored locally as JSON files
- **Phylactery grounding** — an in-tree local MCP service (Python, run via uv) that prepends a persistent identity layer + RAG memories + a knowledge graph to every request (with a prompt-cache-aware static/dynamic split)
- **temporal context (Unruh)** — an optional sibling module adding a `[Temporal Context]` block: a schedule, weighted/decaying interests + standing values, and session-to-session intent handoff

For full project context, also review the root [README](../README.md) and the [Project Vision](../docs/project-vision.md). Detailed feature docs live under [docs/](../docs/) — this wiki is a quick-start summary that defers to them.
