# Entity-Core Identity Layer

## What Is Entity-Core?

[entity-core-alpha](https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2) is a Deno-based MCP (Model Context Protocol) server that manages persistent identity files, RAG memories, and a knowledge graph for a named AI entity. Proto-Familiar connects to it through `thalamus.js` to ground every LLM request in stable, long-term context that survives session boundaries.

This integration is **optional** — the app runs fully without it. When entity-core is unavailable, `thalamus.js` logs the error and returns an empty string, and every chat request proceeds without enrichment.

---

## How It Works

On startup, `thalamus.js` spawns entity-core as a child Deno process over stdio, using the MCP SDK's `StdioClientTransport`. The entity-core process's working directory is set to its own project root so it reads the correct `data/` directory regardless of where `node server.js` was launched from.

Before each LLM call (`POST /api/chat` and `POST /api/debug-prompt`), the server calls `enrich(userMessage)`, which fires three MCP tool calls **in parallel** using `Promise.allSettled` — a failure in one does not prevent the others from contributing:

| MCP Tool | What it fetches |
|---|---|
| `identity_get_all` | All identity files across four categories: `self/`, `user/`, `relationship/`, `custom/` |
| `memory_search` | Up to 5 memory excerpts ranked by semantic similarity to the current user message |
| `graph_node_search` | Up to 10 knowledge-graph nodes relevant to the current user message, with 1-hop edge traversal |

---

## Context Block Structure

The assembled context block is prepended to the system message in this order:

```
<base_instructions>…</base_instructions>
---
My self files (from identity/self/ directory):

<my_identity>…</my_identity>
---
<my_persona>…</my_persona>
<my_personhood>…</my_personhood>
<my_wants>…</my_wants>
<my_mechanics>…</my_mechanics>
---
User files (from identity/user/ directory):

<user_identity>…</user_identity>
---
<user_life>…</user_life>
…
---
Relationship files (from identity/relationship/ directory):
…
---
Custom files (from identity/custom/ directory):
…
---
Relevant Memories via RAG:

[1] (from daily/2026-05-12, 87% relevant)
Memory text…

[2] (from weekly/2026-W19, 72% relevant)
Memory text…
---
Relevant Knowledge from Graph:

Node text…
  → edge label → connected node…
```

Each identity file is wrapped in XML tags named after the file's `promptLabel` field (e.g. `<my_identity>`, `<my_persona>`). Files are sorted in the same canonical order entity-core uses internally. Sections that have no content are omitted entirely.

If entity-core is prepended to a message array that already has a system message, the block is inserted at the top of that system message. If there is no system message, a new one is created.

---

## Identity File Canonical Order

### Self (`self/`)

1. `base_instructions.md` — inserted first, without a section header
2. `my_identity.md`
3. `my_persona.md`
4. `my_personhood.md`
5. `my_wants.md`
6. `my_mechanics.md`
7. Any additional files (alphabetical)

### User (`user/`)

1. `user_identity.md`
2. `user_life.md`
3. `user_beliefs.md`
4. `user_preferences.md`
5. `user_patterns.md`
6. `user_notes.md`
7. Any additional files (alphabetical)

### Relationship (`relationship/`)

1. `relationship_dynamics.md`
2. `relationship_history.md`
3. `relationship_notes.md`
4. Any additional files (alphabetical)

### Custom (`custom/`)

Files sorted alphabetically.

---

## Prompt Inspector

To see exactly what was sent to the LLM on the previous turn — including the full entity-core block, all lorebook injections, and the conversation history — click the **🔍 magnifying glass** button in the top bar after sending a message. The entity-core block is captured from a `_thalamus` envelope the server attaches to every `/api/chat` response (both streaming and non-streaming), so the inspector shows the actual injected text rather than a re-derived preview that could drift if intervening memory or identity writes have changed what `enrich()` would now return. See [Prompt Inspector](features.md#prompt-inspector) for the full source palette.

The inspector calls `POST /api/debug-prompt` with the current message array and displays each message in a colour-coded, collapsible panel with per-message Copy buttons. No API call is made to the upstream LLM.

---

## Setup

The one-click installers handle the clone for you (`Proto-Familiar.vbs` on Windows, `Proto-Familiar.command` on macOS, `./install.sh` on Linux). They also pre-cache the Deno module graph so the first server start doesn't stall on downloads. If you'd rather do it by hand:

1. Clone entity-core-alpha as a sibling directory next to Proto-Familiar:
   ```bash
   git clone --depth 1 --branch entity-core-v0.2.2 https://github.com/PsycherosAI/Psycheros.git ../entity-core-alpha
   ```
   Psycheros is a Deno workspace at this tag, so entity-core itself lives at `../entity-core-alpha/packages/entity-core/`. Older releases kept it at the repo root (`../entity-core-alpha/src/mod.ts`); `thalamus.js` probes both layouts and prefers the workspace path.

2. Populate the package's `data/` directory — `entity-core-alpha/packages/entity-core/data/` for the workspace layout, or `entity-core-alpha/data/` for the legacy layout — with identity files following the entity-core README.

3. (Optional but recommended) Pre-cache Deno dependencies so the first launch is instant:
   ```bash
   cd ../entity-core-alpha/packages/entity-core   # or just ../entity-core-alpha on the legacy layout
   deno cache src/mod.ts
   ```

4. Start Proto-Familiar normally. `thalamus.js` spawns entity-core automatically on startup. Make sure `deno` is on `PATH` for the process that runs `node server.js`; `start.sh` adds `~/.deno/bin` to `PATH` automatically when the official installer was used and the user's shell config hasn't been reloaded.

If entity-core is missing or fails to start, `thalamus.js` logs the error and `enrich()` returns an empty string — Proto-Familiar runs normally without enrichment.

To use a custom install path, set `ENTITY_CORE_PATH` to the absolute path of entity-core's `src/mod.ts` before starting the server:

```bash
ENTITY_CORE_PATH=/home/user/my-entity-core/packages/entity-core/src/mod.ts npm start
```

---

## Importing an Existing Entity-Core

If you have a populated entity-core data directory from another machine or embodiment, use the import script to overwrite the local instance:

```bash
# From an entity-core root (auto-detects the data/ subdirectory)
npm run import-entity -- --from /path/to/entity-core

# From a bare data directory (contains self/, memories/, or graph.db)
npm run import-entity -- --from /path/to/entity-core/data

# Skip the confirmation prompt
npm run import-entity -- --from /path/to/entity-core --yes
```

The script:
- Auto-detects whether `--from` is an entity-core root or a bare data directory.
- Resolves the destination using the same logic as `thalamus.js`: `$ENTITY_CORE_PATH` if set, otherwise probes `../entity-core-alpha/packages/entity-core` (Deno-workspace layout) and falls back to `../entity-core-alpha` (legacy top-level layout).
- Reads both installs' `.env` files for `ENTITY_CORE_DATA_DIR` overrides.
- Preserves file timestamps so memory recency ranking stays accurate.
- Refuses to proceed if source and destination resolve to the same path.

> **Stop the server before running this script** to avoid write conflicts with the running entity-core process.
