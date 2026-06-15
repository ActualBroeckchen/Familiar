# Tool Calling

## Overview

Tool calling lets the LLM invoke the Familiar's tools and receive their results before producing a final response. Proto-Familiar implements the OpenAI function-calling protocol. Since **0.4.0-alpha** the registry, the executors, and the multi-round execution loop all live **server-side** (in `cerebellum.js`, the motor module — see [`architecture.md`](architecture.md)): the loop runs inside a single `POST /api/chat` request, and the browser only *renders* what happened. This is what lets future non-browser channels (e.g. Discord) get tool execution for free.

---

## Enabling / Disabling

The **Enable tool use** checkbox in the sidebar **Tools** section controls whether the app opts the request into the server-side tool loop (`runToolLoop: true`). When unchecked, no tools are advertised to the model and it behaves as a plain chat completion.

---

## Built-in Tools

Thirty-two tools are always available when tool use is enabled: eight read/write tools (including the deferred-intent acknowledger and two on-demand memory-read tools), four graph-lookup and graph-creation tools, seven editing tools for correcting stale Phylactery state, eight temporal tools (schedule + interests, backed by Unruh), two Village tools (look up who's in the ward's Village and add/edit people, with sensitive notes gated to private turns), and three crisis outreach tools for when the Familiar needs to help a user who is in danger during a live conversation. Every destructive tool (delete / rewrite / replace) auto-snapshots Phylactery before the call — recovery is one click in the **Snapshots** tab of the Knowledge editor.

| Tool | Description | Returns |
|---|---|---|
| `get_datetime` | Current local date, time, and timezone | Human-readable locale string (e.g. `"Tuesday, May 13, 2026 at 02:30:00 PM CEST"`) |
| `get_session_info` | Metadata about the current session | JSON with `startedAt`, `messageCount`, `provider`, `model`, `elapsedMsSinceLastMessage` |
| `save_to_tome` | Save a fact or piece of knowledge into the persistent Tome knowledge base, with trigger keywords | Confirmation string with the assigned entry UID |
| `save_memory` | Write a new time-stamped memory entry to Phylactery at a chosen granularity (`daily` \| `weekly` \| `monthly` \| `yearly` \| `significant`) | `"Memory saved."` or an error string |
| `update_identity` | Append a durable fact to a Phylactery identity file (`user` or `relationship` category) | `"Identity file updated."` or an error string |
| `acknowledge_deferred_intent` | Mark a `wants_to_save` intent from the [Deferred intents] block as filed, so it stops resurfacing (see the deferred-action pattern in [`architecture.md`](architecture.md)) | Confirmation string |
| `find_graph_node` | Look up the graph id(s) for an entity by name. Use before `update_graph_node` / `delete_graph_node` when the entity isn't in the graph block's ids legend | One line per match: `<label> (id=…, type=…) — <description>` |
| `find_graph_edges` | List a node's 1-hop edges with their ids. Use before `update_graph_edge` / `delete_graph_edge` when the edge isn't in the graph block's ids legend | One line per edge: `<from> -<rel>-> <to> (id=…)` |
| `list_memories` | Browse stored memories at a given tier, most recent first — for surveying recent entries or finding the key of an entry to update/delete. No arguments required; `granularity` and `limit` are optional | One line per entry: `<tier>/<key> — <title or first 80 chars>` |
| `read_memory` | Read the full contents of one memory entry by its exact address. Use when a summary isn't enough and you need the verbatim body before quoting or updating it. Significant memories use the composite key `YYYY-MM-DD_slug` | Full entry body, or a "not found" string |
| `create_graph_node` | Add a new entity (person, place, project, pet, organisation, …) to the knowledge graph. Returns the new node's id for immediate edge-wiring | `"Graph node created: \"<label>\" (id=…)."` or an error string |
| `create_graph_edge` | Record a relationship between two existing graph nodes. Both endpoints must exist first (resolve or create with `find_graph_node` / `create_graph_node`) | `"Graph edge created: <fromId> -<type>-> <toId> (id=…)."` or an error string |
| `update_memory` | Overwrite an existing memory entry to correct an inaccuracy. Replaces the entry whole — include everything you want kept | Status string |
| `delete_memory` | Permanently delete a memory entry. Use only when the entry is fully wrong / obsolete; prefer `save_memory` (with today's date, contradicting the stale entry) when the change has historical value | Status string + snapshot note |
| `rewrite_identity_section` | Replace one section of an identity file. Use when an existing section is misleading and a clean rewrite serves future-you better than appending a correction | Status string |
| `update_graph_node` | Rename or re-describe a knowledge-graph entity (person / place / project). Use when the label or description is wrong, not for new relationships | Status string |
| `delete_graph_node` | Delete an entity AND all its edges. Only when the node is an error (duplicate, wrong entity); for "no longer related" use `delete_graph_edge` instead | Status string + snapshot note |
| `update_graph_edge` | Change a relationship's type or weight when it still holds but is mis-typed (e.g. "acquaintance" → "close friend") | Status string |
| `delete_graph_edge` | Remove one relationship between two entities while keeping the entities themselves. The right tool for "X is no longer at Y" / "X no longer works with Y" | Status string + snapshot note |
| `schedule_add_event` | Record a one-time (or recurring) appointment on the schedule; surfaces in `[Temporal Context]` as its time approaches | Confirmation string with the node id |
| `schedule_add_task` | Record a task, optionally deadline-bound, with optional `stakes_tier` / `consequence_model`; surfaces until resolved | Confirmation string with the node id |
| `schedule_add_reminder` | Set a time-triggered reminder, delivered as a chat message (and Discord push when configured) when it fires | Confirmation string with the node id |
| `schedule_add_phase` | Add a named block to the daily routine, with an optional texture for how the Familiar shows up during it | Confirmation string with the node id |
| `schedule_resolve` | Mark a schedule node `done` / `cancelled` / `carried_forward`; optional `occurrence_date` resolves one occurrence of a recurring series | Confirmation string |
| `schedule_snooze_task` | Park a task for N minutes (clamped 1min–1week) when {{user}} says "not now" — it stops surfacing, then returns on its own | Confirmation string |
| `interest_bump` | Nudge an interest topic's weight (creates the topic on first bump); feeds the pondering loop | Confirmation string |
| `interest_set_standing` | Promote a topic to a never-decaying standing value | Confirmation string |
| `get_trusted_contacts` | Return the names and channels of any trusted contacts configured in Settings. Call this before `contact_trusted_person` to confirm who is available and get the exact name to pass. | Plain-text list, or a note that none are configured |
| `contact_trusted_person` | Immediately send a message to one of the user's trusted contacts (Discord webhook). Intended for live conversations where the user is actively present but in genuine danger. Every outbound is also mirrored into the user's chat (and pushed to their own webhook when configured) — nothing is covert. | Confirmation string, or an error string on failure |
| `show_crisis_resources` | Surface international crisis-line and safety-resource links as a chat message (and push). Low friction — call early rather than late. No contacts required. | Confirmation string |
| `village_lookup` | See who's in the ward's Village; filter by `category`, `location`, or `name`. Returns each villager's id, relation, notes, and linked graph node. `privateNotes` are disclosed only on ward-private turns and withheld whenever others are present | Plain-text list, or a "no one matches" note |
| `village_upsert` | Add or edit a villager (name, category, relation, pronouns, notes, `privateNotes`, and the `graphNodeId` link to a Phylactery node). Resolves a category name to its id. **Ward-private turns only** — refuses to mutate the registry when others are present | Confirmation string |

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

For entities or edges not in the active block, `find_graph_node` and `find_graph_edges` resolve names → ids on demand. For entities not yet in the graph, `create_graph_node` adds them and returns an id ready for `create_graph_edge`.

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
| `content` | string | Yes | Memory text in first-person, as bullet points starting with `- `. No `[chat:id]` tags on live saves. |
| `granularity` | enum | Yes | `daily` \| `weekly` \| `monthly` \| `yearly` \| `significant` |
| `title` | string | Required for `significant`, ignored otherwise | Short human-readable label (e.g. `"first meeting"`). Used to slug-name the file so each significant memory gets its own `YYYY-MM-DD_slug.md` and does not overwrite previous ones. |

Requires Phylactery to be running. Degrades gracefully (returns an error string) if Phylactery is unavailable. For `significant`, the server auto-derives a slug from the title (or from `content`'s first line if the title is missing) before forwarding to Phylactery, and the confirmation string includes the composite key (`Memory saved (significant/2026-06-11_why-melian-trusts-me).`) — that key is how the entry is addressed later in `update_memory` / `delete_memory`.

#### `update_identity`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `category` | enum | Yes | `user` \| `relationship` |
| `filename` | string | Yes | Target file, e.g. `user_notes.md` or `relationship_notes.md` |
| `content` | string | Yes | Text to append to the file |

Requires Phylactery. Appends to the end of the specified file.

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

#### `list_memories`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `granularity` | enum | No | `daily` \| `weekly` \| `monthly` \| `yearly` \| `significant` — omit to list across all tiers |
| `limit` | number | No | Max entries to return (default 50, max 200) |

Calls `memory_list` server-side. Useful for browsing recent entries or locating an entry's date/key before calling `update_memory` or `delete_memory`. Does not require a search query.

#### `read_memory`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `granularity` | enum | Yes | `daily` \| `weekly` \| `monthly` \| `yearly` \| `significant` |
| `date` | string | Yes | Date of the entry (`YYYY-MM-DD` for daily/weekly/monthly/yearly). **Significant memories use the composite key `YYYY-MM-DD_slug`** — the same format `save_memory` returns and `list_memories` shows. |

Calls `memory_read` server-side. Returns the full verbatim body of the entry. Use this before quoting, updating, or carefully reasoning over a specific entry's contents; for topic-based recall the `[Memory]` block in context already surfaces relevant excerpts.

#### `create_graph_node`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `label` | string | Yes | Display name of the entity, e.g. `"Dr. Okafor"`, `"the allotment"`, `"Aria (cat)"` |
| `type` | string | No | Entity type, e.g. `"person"`, `"place"`, `"project"`, `"pet"`, `"organisation"` |
| `description` | string | No | Short note on who/what this is, in first-person voice |

Check `find_graph_node` first to avoid creating a duplicate with a slightly different label. Returns the new node's id; use it immediately with `create_graph_edge` to wire relationships.

#### `create_graph_edge`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fromId` | string | Yes | Graph id of the source node (the relationship's subject) |
| `toId` | string | Yes | Graph id of the target node (the relationship's object) |
| `type` | string | Yes | Relationship type as a short verb phrase, e.g. `"is_therapist_of"`, `"lives_in"`, `"works_with"` |
| `weight` | number | No | Confidence/strength in [0, 1] |

Both endpoints must already exist — resolve or create them with `find_graph_node` / `create_graph_node` first. For a relationship that has ended, delete or re-type the edge rather than leaving a false one standing.

#### `update_memory`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `granularity` | enum | Yes | `daily` \| `weekly` \| `monthly` \| `yearly` \| `significant` |
| `date`        | string | Yes | Date of the entry, in the format it was stored (e.g. `YYYY-MM-DD` for daily). **Significant memories use the composite key `YYYY-MM-DD_slug`** (as returned by `save_memory` and shown in memory listings) so the right milestone file is targeted. |
| `content`     | string | Yes | Full new contents — REPLACES the entry |

Auto-snapshots Phylactery, then calls `memory_update` (the composite key is split into separate `date` + `slug` parameters). Use to correct an inaccuracy. To record a change that has historical value, use `save_memory` instead so the old version is preserved.

#### `delete_memory`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `granularity` | enum | Yes | Memory tier |
| `date`        | string | Yes | Date of the entry to delete. Significant memories use the composite key `YYYY-MM-DD_slug`. |

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

### Crisis Outreach Tools

These three tools let the Familiar act during a live conversation when the user is actively present but clearly in danger. They are distinct from the **silence-triage loop**, which fires only when the user is quiet. The Familiar is expected to use judgment — these tools come with weighted guidance in their descriptions to make false alarms costly to reach for.

The suggested sequence is: **`show_crisis_resources`** first (no prerequisites, always appropriate), then **`get_trusted_contacts`** to see who is available, then **`contact_trusted_person`** only when the Familiar genuinely believes human presence is needed.

#### `get_trusted_contacts`

No parameters. Reads `trustedContacts` from `settings.json` server-side. Returns names and channels only; webhook URLs are never exposed to the model.

#### `contact_trusted_person`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Exact name of the contact, as returned by `get_trusted_contacts` |
| `message` | string | Yes | 1–3 sentences to that person. Identify yourself as the user's Familiar; describe what you've observed. Specific, honest, not sensationalised. |

Delivers via `cerebellum.deliverToTrustedContact`. Delivery is **immediate** (unlike the silence-triage's deferred escalation path). On success or failure, an `outbound_alert` is enqueued to the user's outbox — injected into their chat and pushed to their own Discord webhook when configured. The user always sees exactly what was sent.

#### `show_crisis_resources`

No parameters. Enqueues a `crisis_resources` outbox item containing links to international hotlines (988/Crisis Text Line/Samaritans/Lifeline AU/findahelpline.com); it appears as a chat message (and push). Deduplicated to one item per hour so repeated calls during a single conversation don't flood the queue.

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

Custom tools are **advertise-only**: the model sees them and may call them, but no executor exists — calls return a structured *"advertised but has no implementation yet"* result into the loop. Use them to let the model *describe* what it would do. (A real extension point is flagged as post-MVP work — see the "Custom tools — advertise-only" design note in [`architecture.md`](architecture.md).)

To wire real logic for a tool today, add a definition to `BUILTIN_TOOLS` and a matching entry to `TOOL_EXECUTORS` in `cerebellum.js`:

```js
export const TOOL_EXECUTORS = {
  // ... existing built-ins ...
  my_tool: ({ input }) => `Result for: ${input}`,
};
```

The executor function receives `(args, ctx)` — the parsed arguments object plus per-request context — and must return a string (or a value that will be stringified). Executors never throw into the chat path: any error becomes a structured failure string the model reads.

---

## The Execution Loop

The loop runs **inside the server's `/api/chat` handling** — one HTTP request per user message, no matter how many rounds the model takes. Internal provider re-calls don't count against the chat rate limit.

```
POST /api/chat  { runToolLoop: true, customTools, sessionInfo, ... }
        │
        ▼  server composes tools = BUILTIN_TOOLS + customTools
Provider responds with finish_reason: "tool_calls"?
   │
   ├── YES
   │     │
   │     ▼
   │   For each tool call in the response:
   │     └── cerebellum.executeToolCall()   (TOOL_EXECUTORS, or the
   │         "no implementation" notice for custom/unknown tools)
   │     │
   │     ▼
   │   Emit a `_toolRound` SSE event (streaming) / collect into the
   │   `_toolRounds` array (non-streaming) — the browser renders the
   │   collapsible call/result block from this
   │     │
   │     ▼
   │   Append assistant message (with tool_calls) + tool result
   │   messages; re-append the [Now] time anchor as the LAST message
   │     │
   │     └── Re-call the provider (round += 1), up to MAX_TOOL_ROUNDS (5)
   │
   └── NO (normal text response, or 5 rounds exhausted)
         │
         ▼
       Stream/return the final response → browser renders + saves history
```

After 5 rounds without a `stop` finish reason, the last assistant reply is used as-is. A mid-loop upstream failure surfaces to the streaming client as a `_loopError` event, which the app treats like any failed request (retry / fallback ladder).

---

## Chat Rendering

Tool-call rounds are displayed as compact, collapsible blocks in the chat showing:
- Tool name
- Arguments (formatted JSON)
- Result

These blocks are included in session logs but **stripped from Markdown exports**.

---

## Request Shape

When tool use is enabled, the app's request to `/api/chat` includes:

```json
{
  "runToolLoop": true,
  "customTools": [ ...userDefinedTools ],
  "sessionInfo": { "startedAt": "...", "messageCount": 12, "provider": "zai", "model": "...", "elapsedMsSinceLastMessage": 4200 }
}
```

The server composes the upstream `tools` array (built-ins + custom) and sets `tool_choice: "auto"`. `sessionInfo` backs the `get_session_info` tool.

Direct API callers that pass their own `tools` / `tool_choice` fields (without `runToolLoop`) get the legacy passthrough: both fields are forwarded verbatim to the provider, a single round runs, and tool results are the caller's responsibility.
