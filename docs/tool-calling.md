# Tool Calling

## Overview

Tool calling lets the LLM invoke client-side functions and receive their results before producing a final response. Proto-Familiar implements the OpenAI function-calling protocol and runs the execution loop entirely in the browser.

---

## Enabling / Disabling

The **Enable tool use** checkbox in the sidebar **Tools** section controls whether the `tools` array is included in each API request. When unchecked, no tools are advertised to the model and it behaves as a plain chat completion.

---

## Built-in Tools

Fourteen tools are always available when tool use is enabled. The first five are read/append tools; the next two are read-only lookups for resolving graph names to ids; the bottom seven are the editing surface for correcting stale entity-core state. Every destructive tool (delete / rewrite / replace) auto-snapshots entity-core before the call — recovery is one click in the **Snapshots** tab of the Knowledge editor.

| Tool | Description | Returns |
|---|---|---|
| `get_datetime` | Current local date, time, and timezone | Human-readable locale string (e.g. `"Tuesday, May 13, 2026 at 02:30:00 PM CEST"`) |
| `get_session_info` | Metadata about the current session | JSON with `startedAt`, `messageCount`, `provider`, `model`, `elapsedMsSinceLastMessage` |
| `save_to_tome` | Save a fact or piece of knowledge into the persistent Tome knowledge base, with trigger keywords | Confirmation string with the assigned entry UID |
| `save_memory` | Write a new time-stamped memory entry to entity-core at a chosen granularity (`daily` \| `weekly` \| `monthly` \| `yearly` \| `significant`) | `"Memory saved."` or an error string |
| `update_identity` | Append a durable fact to an entity-core identity file (`user` or `relationship` category) | `"Identity file updated."` or an error string |
| `find_graph_node` | Look up the graph id(s) for an entity by name. Use before `update_graph_node` / `delete_graph_node` when the entity isn't in the graph block's ids legend | One line per match: `<label> (id=…, type=…) — <description>` |
| `find_graph_edges` | List a node's 1-hop edges with their ids. Use before `update_graph_edge` / `delete_graph_edge` when the edge isn't in the graph block's ids legend | One line per edge: `<from> -<rel>-> <to> (id=…)` |
| `update_memory` | Overwrite an existing memory entry to correct an inaccuracy. Replaces the entry whole — include everything you want kept | Status string |
| `delete_memory` | Permanently delete a memory entry. Use only when the entry is fully wrong / obsolete; prefer `save_memory` (with today's date, contradicting the stale entry) when the change has historical value | Status string + snapshot note |
| `rewrite_identity_section` | Replace one section of an identity file. Use when an existing section is misleading and a clean rewrite serves future-you better than appending a correction | Status string |
| `update_graph_node` | Rename or re-describe a knowledge-graph entity (person / place / project). Use when the label or description is wrong, not for new relationships | Status string |
| `delete_graph_node` | Delete an entity AND all its edges. Only when the node is an error (duplicate, wrong entity); for "no longer related" use `delete_graph_edge` instead | Status string + snapshot note |
| `update_graph_edge` | Change a relationship's type or weight when it still holds but is mis-typed (e.g. "acquaintance" → "close friend") | Status string |
| `delete_graph_edge` | Remove one relationship between two entities while keeping the entities themselves. The right tool for "X is no longer at Y" / "X no longer works with Y" | Status string + snapshot note |

### Graph ids in the prompt

The "Relevant Knowledge from Graph" block in every enriched prompt ends with a compact id legend so the Familiar can resolve names like "Eury protects Chen" into the underlying graph ids without an extra tool call. The legend has two sections:

```
[graph ids — pass these strings to update_graph_node / delete_graph_node / update_graph_edge / delete_graph_edge]
nodes:
  Eury = 1747389234876-a3f2e8b1
  Chen = 1747389234876-c4d8f7a2
edges:
  Eury -protects-> Chen = 1747389234877-e1f9b3c4
```

For entities or edges not in the active block, `find_graph_node` and `find_graph_edges` resolve names → ids on demand.

### Editing principles surfaced to the model

Every editing tool's description carries first-person guidance on **when** to use it. The shared principles, repeated in different forms across the descriptions:

- **APPEND** when the new information adds to an existing record without contradicting it. Append is non-destructive and reversible by deletion.
- **UPDATE / REWRITE** when the existing record is now inaccurate or incomplete in a way that a partial addition wouldn't fix.
- **DELETE** when the record is fully obsolete or was wrong from the start. If the change has historical value ("they were on vacation, now back"), prefer writing a newer contradicting memory instead — the recency-decay scoring demotes the stale entry while preserving the audit trail.
- **If unsure, err toward preservation.** Writing an extra note is cheaper than restoring from a snapshot.

`get_datetime` and `get_session_info` require no arguments. See parameter details for the write tools below.

---

### Write Tool Parameters

#### `save_to_tome`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `title` | string | Yes | Short label for the entry |
| `content` | string | Yes | Text to inject when the entry activates |
| `keywords` | string[] | Yes | 2–8 trigger words/phrases |

Entries are saved to the first enabled Tome (auto-creates "General" if none exist), with `learnedAt` set to the current timestamp.

#### `save_memory`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `content` | string | Yes | Memory text in first-person perspective; use `[chat:auto]`-prefixed bullet points |
| `granularity` | enum | Yes | `daily` \| `weekly` \| `monthly` \| `yearly` \| `significant` |

Requires entity-core to be running. Degrades gracefully (returns an error string) if entity-core is unavailable.

#### `update_identity`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `category` | enum | Yes | `user` \| `relationship` |
| `filename` | string | Yes | Target file, e.g. `user_notes.md` or `relationship_notes.md` |
| `content` | string | Yes | Text to append to the file |

Requires entity-core. Appends to the end of the specified file.

#### `find_graph_node`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | Yes | Entity name or fragment (e.g. `"Chen"`, `"vacation"`) |
| `type`  | string | No  | Restrict matches to a single node type |
| `limit` | number | No  | Max matches (default 10, max 100) |

Calls `graph_node_search` server-side. Returns one match per line in the form `<label> (id=…, type=…) — <description>`, ready to paste into `update_graph_node` / `delete_graph_node`.

#### `find_graph_edges`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `nodeId` | string | Yes | Graph id of the node whose edges to list |
| `depth`  | number | No  | Traversal depth 1–3 (default 1) |

Calls `graph_subgraph` server-side. Returns one edge per line as `<from> -<rel>-> <to> (id=…)`, ready to paste into `update_graph_edge` / `delete_graph_edge`.

#### `update_memory`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `granularity` | enum | Yes | `daily` \| `weekly` \| `monthly` \| `yearly` \| `significant` |
| `date`        | string | Yes | Date of the entry, in the format it was stored (e.g. `YYYY-MM-DD` for daily) |
| `content`     | string | Yes | Full new contents — REPLACES the entry |

Auto-snapshots entity-core, then calls `memory_update`. Use to correct an inaccuracy. To record a change that has historical value, use `save_memory` instead so the old version is preserved.

#### `delete_memory`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `granularity` | enum | Yes | Memory tier |
| `date`        | string | Yes | Date of the entry to delete |

Auto-snapshots, then calls `memory_delete`. Reserve for fully wrong / obsolete entries.

#### `rewrite_identity_section`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `category` | enum | Yes | `self` \| `user` \| `relationship` \| `custom` |
| `filename` | string | Yes | Target file, e.g. `user_notes.md` |
| `section`  | string | Yes | The markdown heading of the section (without leading `#`s), e.g. `"Sleep patterns"` |
| `content`  | string | Yes | Full new body for that section, in first-person voice |

Auto-snapshots, then calls `identity_rewrite_section`. For adding facts, use `update_identity` (append) instead.

#### `update_graph_node`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id`          | string | Yes | Node id (from earlier graph context) |
| `label`       | string | No | New display label |
| `description` | string | No | New description |

Auto-snapshots, then calls `graph_node_update`. Omit fields you want to leave unchanged.

#### `delete_graph_node`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Node id |

Auto-snapshots, then calls `graph_node_delete`. Deletes all edges attached to the node. For "they're no longer at Y" use `delete_graph_edge` instead — the node still exists.

#### `update_graph_edge`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id`     | string | Yes | Edge id |
| `type`   | string | No | New relationship type |
| `weight` | number | No | New strength in [0, 1] |

Auto-snapshots, then calls `graph_edge_update`. For a relationship that USED to be true and is now false, delete instead.

#### `delete_graph_edge`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | string | Yes | Edge id |

Auto-snapshots, then calls `graph_edge_delete`. Both endpoint nodes remain.

---

## Custom Tools

Paste a JSON array of [OpenAI function-calling](https://platform.openai.com/docs/guides/function-calling) tool definitions into the **Custom tools** field in the sidebar:

```json
[
  {
    "type": "function",
    "function": {
      "name": "my_tool",
      "description": "Does something useful.",
      "parameters": {
        "type": "object",
        "properties": {
          "input": { "type": "string", "description": "The input value." }
        },
        "required": ["input"]
      }
    }
  }
]
```

Custom tools are advertised to the LLM like built-in tools. When the model calls one, the execution returns a message explaining the tool has no client-side implementation.

To wire real logic, add entries to `BUILTIN_EXECUTORS` in `public/app.js`:

```js
const BUILTIN_EXECUTORS = {
  // ... existing built-ins ...
  my_tool: ({ input }) => `Result for: ${input}`,
};
```

The executor function receives the parsed arguments object and must return a string (or a value that will be stringified).

---

## The Execution Loop

```
POST /api/chat  (with tools array)
        │
        ▼
Provider responds with finish_reason: "tool_calls"?
   │
   ├── YES
   │     │
   │     ▼
   │   For each tool call in the response:
   │     ├── Execute client-side (BUILTIN_EXECUTORS or "no implementation" message)
   │     └── Render collapsible call/result block in chat
   │     │
   │     ▼
   │   Append assistant message (with tool_calls) + tool result messages
   │     │
   │     ▼
   │   Re-send to provider (round += 1)
   │     │
   │     └── Repeat up to MAX_TOOL_ROUNDS (5) times
   │
   └── NO (normal text response, or 5 rounds exhausted)
         │
         ▼
       Render assistant message → save to history
```

After 5 rounds without a `stop` finish reason, the last assistant reply is used as-is.

---

## Chat Rendering

Tool-call rounds are displayed as compact, collapsible blocks in the chat showing:
- Tool name
- Arguments (formatted JSON)
- Result

These blocks are included in session logs but **stripped from Markdown exports**.

---

## Request Shape

When tool use is enabled, the request to `/api/chat` includes:

```json
{
  "tools": [ ...BUILTIN_TOOLS, ...customTools ],
  "tool_choice": "auto"
}
```

Both fields are forwarded verbatim to the upstream provider.
