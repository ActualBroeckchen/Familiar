# Entity-Core Identity Layer

## What Is Entity-Core?

[entity-core](https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.4.0) is a Deno-based MCP (Model Context Protocol) server that manages persistent identity files, RAG memories, and a knowledge graph for a named AI entity. Proto-Familiar connects to it through `thalamus.js` to ground every LLM request in stable, long-term context that survives session boundaries.

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

The context is split into two regions, placed in the prompt by `server.js` based on how often each one changes — so the upstream LLM's prefix cache covers what's stable and only the dynamic part churns. See [`architecture.md#prompt-cache-aware-assembly`](architecture.md#prompt-cache-aware-assembly) for the full rationale.

### Static block — prepended to the system message

Stable across turns; lives at the top of the prompt so the provider's prefix cache covers it:

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
…
---
Relationship files (from identity/relationship/ directory):
…
---
Custom files (from identity/custom/ directory):
…
```

Each identity file is wrapped in XML tags named after the file's `promptLabel` field. Files are sorted in the same canonical order entity-core uses internally. Sections with no content are omitted.

### Dynamic block — depth-injected as a separate system message

Re-derived every turn (query-dependent or clock-dependent), so it's injected `max(1, messages.length - depth)` positions from the end of the conversation — deep enough that the static prefix stays cacheable, close enough to the user's current question for the model to use:

```
Relevant Memories via RAG:

[1] (from daily/2026-05-12, 87% relevant)
Memory text…

[2] (from weekly/2026-W19, 72% relevant)
Memory text…

---

Relevant Knowledge from Graph:

Node text…
  → edge label → connected node…

---

[Temporal Context]
Current phase: morning correspondence (10:00–13:00)
  14:00 — Chen's appointment
  22:00 — cat play + dinner
```

Default depth = 4. Configurable via the **Context-cache depth** field in the Settings panel (synced across devices via `settings.json`'s `thalamusDynamicDepth`).

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

## Editing the knowledge

The Familiar surfaces the editing side of entity-core through two paths:

- **Knowledge editor** in the sidebar (button **🧠 Open Knowledge editor** under the Knowledge section). Four tabs — Memories, Graph, Identity, Snapshots — that let the user browse, edit, delete, and supersede entries directly. The Graph tab carries full CRUD across two view modes (a classic list/detail browser and a colored dot-and-curve **Map view** with an in-canvas popover editor and `GET /api/entity/graph/full` aggregation behind it). Every destructive op auto-snapshots first; the Snapshots tab is the always-on undo. See [Features → Knowledge editor](features.md#knowledge-editor-entity-core) for the full UI walkthrough.

- **LLM tool calls.** Beyond `save_memory` and `update_identity` (both append-only), the Familiar can call `update_memory`, `delete_memory`, `rewrite_identity_section`, `update_graph_node`, `delete_graph_node`, `update_graph_edge`, and `delete_graph_edge`. Each tool's description teaches the model when to append vs. rewrite vs. delete, and recommends superseding (writing a new contradicting memory) over deleting when the change has historical value. Every destructive tool auto-snapshots before the underlying MCP call, so even a bad model decision is recoverable from the Knowledge editor's Snapshots tab. See [Tool Calling](tool-calling.md#built-in-tools) for the full parameter reference.

The auto-snapshots are pruned by entity-core's own retention policy (`ENTITY_CORE_SNAPSHOT_RETENTION_DAYS`, default 30 days) so this doesn't grow without bound.

---

## Prompt inspector

To see exactly what was sent to the LLM on the previous turn — including the full entity-core block, all lorebook injections, and the conversation history — click the **🔍 magnifying glass** button in the top bar after sending a message. The entity-core block is captured from a `_thalamus` envelope the server attaches to every `/api/chat` response (both streaming and non-streaming), so the inspector shows the actual injected text rather than a re-derived preview that could drift if intervening memory or identity writes have changed what `enrich()` would now return. See [Prompt Inspector](features.md#prompt-inspector) for the full source palette.

---

## API key designation

Entity-core's background **consolidator** (weekly / monthly / yearly memory summaries) makes its own outbound LLM calls — independent of whatever the chat path uses. It reads three env vars from the spawn environment: `ENTITY_CORE_LLM_API_KEY`, `ENTITY_CORE_LLM_BASE_URL`, and `ENTITY_CORE_LLM_MODEL`, falling back to `ZAI_API_KEY` / `ZAI_BASE_URL` / `ZAI_MODEL`. Missing any of the three causes the consolidator to error with `No LLM API key configured (ENTITY_CORE_LLM_API_KEY or ZAI_API_KEY)` — the message names the key but fires for any of the three.

Proto-Familiar wires this for you. In the sidebar's **Connections** section, click **+ entity-core** on any saved connection to designate it as the source. The badge **entity-core** appears next to the row.

When the designation changes, server.js diffs the entity-core creds (id + apiKey + provider + model) before and after the settings save. If anything material changed, it fires `reconnectEntityCore()` on `thalamus.js` — which tears down the entity-core child and respawns it with the new env. The next chat or scheduled consolidation picks up the new key automatically; no Proto-Familiar restart needed.

The connection you designate is independent of the chat path. It doesn't have to be your primary or any fallback. Click the **+ entity-core** button a second time on the same row to clear the designation; click on a different row to move it.

### Env vars Proto-Familiar sets

When you designate a connection, `thalamus.js` resolves the env block via `loadEntityCoreEnv()` (reads `settings.json` directly) and passes it to `StdioClientTransport({ env: ... })`. The MCP SDK merges this with `DEFAULT_INHERITED_ENV_VARS` (PATH, HOME, etc.) so PATH is preserved.

| Env var | Always set? | Notes |
|---|---|---|
| `ENTITY_CORE_LLM_API_KEY` | yes | Bearer token from the designated connection |
| `ENTITY_CORE_LLM_BASE_URL` | yes | Full chat-completions URL (see [providers.js](../providers.js) — entity-core POSTs to this exactly, no path appending) |
| `ENTITY_CORE_LLM_MODEL` | yes | Model name from the connection |
| `ENTITY_CORE_LLM_PROVIDER` | yes | Informational provider tag |
| `ZAI_API_KEY` | only for `zai` / `zai-coding` providers | Alternate name some entity-core builds read |
| `ZAI_BASE_URL` | only for `zai` / `zai-coding` providers | Same |
| `ZAI_MODEL` | only for `zai` / `zai-coding` providers | Same |

If you designate a connection whose provider isn't in `providers.js`'s `PROVIDER_URLS` map, `thalamus.js` logs a warning at boot naming the provider so you can either pick a supported one or add yours to the map.

If you don't designate anything, the env block is empty and entity-core spawns with no LLM credentials — same as before this feature existed. enrichment still works (it doesn't need outbound LLM calls), but the consolidator will fail on its next tick with the error above.

---

## Setup

The one-click installers handle the clone for you (`Proto-Familiar.vbs` on Windows, `Proto-Familiar.command` on macOS, `./install.sh` on Linux). They also pre-cache the Deno module graph so the first server start doesn't stall on downloads. If you'd rather do it by hand:

1. Clone entity-core as a sibling directory next to Proto-Familiar:
   ```bash
   git clone --depth 1 --branch entity-core-v0.4.0 https://github.com/PsycherosAI/Psycheros.git ../entity-core
   ```
   Psycheros is a Deno workspace at this tag, so entity-core itself lives at `../entity-core/packages/entity-core/`. Older releases kept it at the repo root (`../entity-core/src/mod.ts`). `thalamus.js` probes both layouts and prefers the workspace path. Pre-rename installs that used `../entity-core-alpha/` are still detected as a fallback so existing setups keep working without a directory move.

2. Populate the package's `data/` directory — `entity-core/packages/entity-core/data/` for the workspace layout, or `entity-core/data/` for the legacy layout — with identity files following the entity-core README.

3. (Optional but recommended) Pre-cache Deno dependencies so the first launch is instant:
   ```bash
   cd ../entity-core/packages/entity-core   # or just ../entity-core on the legacy layout
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
- Resolves the destination using the same logic as `thalamus.js`: `$ENTITY_CORE_PATH` if set, otherwise probes `../entity-core/packages/entity-core` (Deno-workspace layout) and falls back to `../entity-core` (legacy top-level layout), then repeats both probes under the pre-rename `../entity-core-alpha/` directory for back-compat.
- Reads both installs' `.env` files for `ENTITY_CORE_DATA_DIR` overrides.
- Preserves file timestamps so memory recency ranking stays accurate.
- Refuses to proceed if source and destination resolve to the same path.

> **Stop the server before running this script** to avoid write conflicts with the running entity-core process.
