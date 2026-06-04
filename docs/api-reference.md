# API Reference

All endpoints are served by the Express server at `http://localhost:8742` (or your configured port). The server is a local proxy — it is not intended to be exposed to the public internet without additional authentication. For accessing the UI from another device, prefer the Tailscale opt-in described in [Getting Started → Access from other devices](getting-started.md#access-from-other-devices-tailscale--lan).

---

## Chat

### `POST /api/chat`

Proxies a chat completion request to the selected LLM provider. Supports both streaming (SSE) and non-streaming modes.

**Request body:**

```json
{
  "provider":    "nanogpt | zai | zai-coding",
  "apiKey":      "sk-...",
  "model":       "gpt-4o-mini",
  "messages":    [{ "role": "user", "content": "Hello" }],
  "stream":      true,
  "temperature": 0.8,
  "max_tokens":  2048,
  "tools":       [...],
  "tool_choice": "auto"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | string | Yes | One of `"nanogpt"`, `"zai"`, `"zai-coding"` |
| `apiKey` | string | Yes | Your API key for the chosen provider |
| `model` | string | Yes | Model name (e.g. `"gpt-4o-mini"`, `"glm-4.7"`) |
| `messages` | array | Yes | OpenAI-compatible messages array |
| `stream` | boolean | No | `true` for SSE streaming, `false` (default) for full response |
| `temperature` | number | No | Sampling temperature |
| `max_tokens` | number | No | Maximum response tokens |
| `tools` | array | No | OpenAI function-calling tool definitions |
| `tool_choice` | string/object | No | Tool choice directive (e.g. `"auto"`) |
| `enrich` | boolean/string | No | Enrichment mode. `true`/omitted = full (identity + memory + graph + temporal, and consume any surfaced session handoff); `"static"` = persona/identity only (no memory/temporal, no handoff consumption — used by the handoff summariser so its note is in character without the dynamic context); `false` = none. |

**Enrichment:** Before forwarding, the server calls `thalamus.js:enrich()`, which returns the entity-core + Unruh context split into two parts for prompt-cache efficiency (see [`architecture.md`](architecture.md#prompt-cache-aware-assembly)):

- **`static`** — base instructions + identity files. Prepended to the system message (stable across turns, so the provider's prefix cache covers it).
- **`dynamic`** — RAG memories, knowledge-graph excerpt, and Unruh temporal context. Injected as a separate `system` message `depth` positions from the end of the conversation, so per-turn churn doesn't invalidate the static prefix. Depth comes from the `thalamusDynamicDepth` setting (default 4).

If entity-core and Unruh are both unavailable, the request proceeds without enrichment.

**Streaming response (`stream: true`):**

Returns `Content-Type: text/event-stream`. The first `data:` line is a `_thalamus` envelope describing what this request was enriched with (omitted entirely when `enrich()` returned nothing); the remaining events follow the OpenAI SSE format:

```
data: {"_thalamus":{"static":"<my_identity>…","dynamic":"Relevant Memories…","depth":4,"injectedAt":3}}

data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}

data: [DONE]
```

The envelope shape is `{ static, dynamic, depth, injectedAt }`: the two context blocks plus the depth used and the actual index the dynamic block landed at (so the prompt inspector can render both regions in their real positions). Clients should route on the presence of `_thalamus` and skip the normal `choices` parsing for that line.

**Non-streaming response (`stream: false`):**

Returns the provider's JSON response with the provider's original HTTP status code. On a successful response the server parses the JSON and attaches a top-level `_thalamus: { static, dynamic, depth, injectedAt }` field (omitted when `enrich()` returned nothing or the upstream body wasn't JSON).

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Unknown provider, missing/invalid API key, missing/invalid model, empty messages array |
| `502` | Network error reaching the upstream provider |

---

### `POST /api/debug-prompt`

Returns the full enriched message array that would be sent to the LLM for a given conversation payload — including the entity-core context block — **without** making any upstream API call. Available for offline previewing. The live prompt inspector no longer uses this endpoint; it reads the `_thalamus` envelope that `POST /api/chat` attaches to every response, so it reflects the actual injection rather than a re-derived preview.

**Request body:**

```json
{ "messages": [...] }
```

**Response:**

```json
{ "messages": [...] }
```

The same messages array with entity-core enrichment prepended to the system message (or inserted as a new system message if none was present).

**Error responses:**

| Status | Condition |
|---|---|
| `400` | `messages` is missing or not a non-empty array |

---

## Central settings

User preferences (prompts, names, saved connections including API keys, tomes settings) are stored centrally on the server so opening Proto-Familiar on a second device pulls the same configuration. The browser's `localStorage` is used as a fast offline cache; the server is the source of truth.

### `GET /api/settings`

Returns the persisted settings JSON.

**Response:** `{ "settings": <object> }` — or `{ "settings": null }` if nothing has been saved yet.

### `PUT /api/settings`

Replaces the persisted settings JSON with the supplied object (atomic write via tmp + rename).

**Request body:** `{ "settings": { ... } }` — must be a non-array object.

**Response:** `{ "ok": true }`

**Error responses:**

| Status | Condition |
|---|---|
| `400` | `settings` is missing, not an object, or serialised payload exceeds 2 MB |
| `500` | Failed to write the file |

Stored at `./settings.json` in the project root (git-ignored). The frontend POSTs an updated copy on every preference change, debounced by ~500ms.

---

## Tailscale toggle

### `GET /api/tailscale`

Returns the current state of the "Access from other devices" toggle plus any auto-detected Tailscale identifiers.

**Response:**

```json
{
  "enabled":   false,
  "port":      8742,
  "hostname":  "my-laptop.tail1234.ts.net",
  "ipv4":      "100.x.y.z",
  "available": true
}
```

`hostname` / `ipv4` are `null` when the `tailscale` CLI isn't installed or returns nothing. `available` reflects whether the CLI ran successfully.

### `POST /api/tailscale`

Updates the toggle and persists it to `.proto-familiar-config.json`. Returns the same shape as `GET`.

**Request body:** `{ "enabled": true }`

**Error responses:**

| Status | Condition |
|---|---|
| `400` | `enabled` is missing or not a boolean |
| `500` | Failed to persist config file |

When `enabled` is `false`, the gate middleware drops every non-loopback request with `403`. When `true`, any device that can reach the host on the configured port can use the proxy — there is no per-device auth, so only flip on when you trust the network.

---

## Session Logs

### `POST /api/log`

Creates or overwrites the log file for a session. Called automatically by the frontend after every message (fire-and-forget).

**Request body:**

```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "startedAt": "2026-05-11T14:30:00.000Z",
  "endedAt":   "2026-05-11T17:12:00.000Z",
  "provider":  "nanogpt",
  "model":     "gpt-4o-mini",
  "messages":  [
    { "role": "user",      "content": "Hello", "timestamp": "2026-05-11T14:30:05.000Z" },
    { "role": "assistant", "content": "Hi!",   "timestamp": "2026-05-11T14:30:07.000Z" }
  ]
}
```

`endedAt` may be `null` while the session is still active.

**Response:** `{ "ok": true }`

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Invalid session ID (must be a UUID) or `messages` is not an array |
| `500` | File system write failure |

---

### `GET /api/logs`

Returns metadata for all sessions, sorted newest-first. Message bodies are **not** included.

**Response:**

```json
[
  {
    "sessionId":    "550e8400-e29b-41d4-a716-446655440000",
    "startedAt":    "2026-05-11T14:30:00.000Z",
    "endedAt":      "2026-05-11T17:12:00.000Z",
    "updatedAt":    "2026-05-11T17:12:05.000Z",
    "provider":     "nanogpt",
    "model":        "gpt-4o-mini",
    "messageCount": 12
  }
]
```

---

### `GET /api/logs/:id`

Returns the full session JSON for the given UUID, including all messages.

**Response:** The raw session JSON object (see `POST /api/log` body shape above).

---

### `DELETE /api/logs/:id`

Deletes the session log file for the given UUID.

**Response:** `{ "ok": true }`

---

### `GET /api/triage-events`

Returns the full history of silence-triage decisions, newest first. Each entry is one tick of the 5-minute triage loop, regardless of whether the Familiar acted. Stored as newline-delimited JSON at `logs/triage-events.jsonl`; returns an empty array when the file doesn't exist yet.

This is the audit trail for debugging the silence-triage system — you can see every decision the LLM made (or every reason it was skipped), how long the silence was at the time, and what the threat tier was.

**Response:**

```json
[
  {
    "threat":    { "tier": "high", "weight": 4.2 },
    "silenceMs": 3840000,
    "reason":    "llm_said_wait",
    "decision":  { "action": "wait", "message": null },
    "acted":     false,
    "at":        "2026-06-01T03:14:00.000Z",
    "loggedAt":  "2026-06-01T03:14:01.123Z"
  },
  {
    "threat":    { "tier": "high", "weight": 4.2 },
    "silenceMs": 4140000,
    "reason":    "reached_out",
    "decision":  { "action": "reach_out", "message": "Hey, I've been thinking about you…" },
    "acted":     true,
    "at":        "2026-06-01T03:19:00.000Z",
    "loggedAt":  "2026-06-01T03:19:01.456Z"
  }
]
```

**`reason` values:**

| Value | Meaning |
|---|---|
| `low_threat` | Threat tier is calm or mild — triage doesn't run at those tiers |
| `no_activity` | No user activity recorded yet this session |
| `too_recent` | Silence hasn't crossed the tier's threshold yet |
| `reached_out` | Rate-limiter: the Familiar already reached out recently |
| `llm_said_wait` | LLM deliberated and chose not to reach out this tick |
| `acted` / (empty `reason` with `acted: true`) | The Familiar reached out |

**`decision`** is `null` for ticks where the LLM wasn't called (low_threat / no_activity / too_recent / reached_out). For LLM-driven ticks it contains at minimum `{ action: "wait" | "reach_out", message }`. When the LLM proposed a deferred trusted-contact escalation, `decision.meta.pendingContact` holds `{ name, message, channel }` and `decision.meta.contactDeadlineTs` is the UNIX ms deadline.

---

## Crisis Outreach (Live Conversation)

These two endpoints back the crisis outreach tools — invoked by the Familiar during an active conversation when the user is present but in danger. They are distinct from the silence-triage loop (which fires only when the user is quiet).

### `POST /api/contact-trusted-person`

Immediately delivers a message to one of the user's configured trusted contacts. Unlike the silence-triage deferred escalation path, delivery is not conditional on the user's acknowledgement — it is intended for situations where the Familiar has judged, during a live exchange, that human presence is needed now.

Every delivery (and every failed attempt) is also written to the outbox as an `outbound_alert` banner so the user can see exactly what was sent.

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Exact name of the contact, matching one entry in `settings.json → trustedContacts` |
| `message` | string | Yes | The message to send. Delivered as-is. |

**Response:**

```json
{ "ok": true, "channel": "discord" }
```

On error (contact not found, webhook delivery failure):

```json
{ "ok": false, "channel": "discord", "error": "discord 400: …" }
```

Even on delivery failure the attempt is recorded in the outbox.

---

### `POST /api/crisis-resources`

Enqueues a `crisis_resources` outbox banner containing international crisis-line and safety-resource links. The banner appears in the user's chat the next time the outbox is polled.

Deduplicated by a 1-hour bucket key — repeated calls within the same hour return the existing item's id without creating a duplicate.

**Request body:** none required.

**Response:**

```json
{ "ok": true, "id": "<uuid>", "deduped": false }
```

`deduped: true` means an identical unacknowledged banner was already in the queue; `id` is the existing item's id.

---

## Tomes

Tomes are stored as individual JSON files in the `tomes/` directory. Each Tome is independently addressable and can be enabled or disabled. The activation engine aggregates entries from all enabled Tomes.

### `GET /api/tomes`

Returns a metadata list of all Tomes (no entry bodies). Files inside
`tomes/` whose name starts with `.` (e.g. `.memorization-queue.json`,
which the memorization worker uses for its persistent job queue) are
skipped, as are files that parse but lack an `id` field.

**Response:**

```json
[
  {
    "id":          "550e8400-e29b-41d4-a716-446655440000",
    "name":        "World Lore",
    "description": "Geographical and cultural facts.",
    "enabled":     true,
    "entryCount":  14
  }
]
```

---

### `POST /api/tomes`

Creates a new Tome.

**Request body:**

```json
{
  "name":        "Character Notes",
  "description": "Optional description.",
  "enabled":     true
}
```

`name` is required. `description` is optional (defaults to `""`). New tomes are always created enabled.

**Response:** `{ "id": "<new tome uuid>" }`

**Error responses:**

| Status | Condition |
|---|---|
| `400` | `name` is missing or blank |
| `500` | File system write failure |

---

### `GET /api/tomes/session-memories`

Returns metadata for the special **Session Memories** tome, creating it if it doesn't exist yet. This is the system tome that receives all session memorization output — both the worker-driven Auto-summarize path and the user-driven Manual topics path. Always present, always at the same logical name; the underlying file id remains stable across calls.

The find-or-create routine is shared with the memorization worker (`memorization.js#findOrCreateSessionMemoriesTome`) via a process-wide mutex, so concurrent callers (e.g. the worker processing a queued job and the client opening the manual viewer) can't produce duplicate tomes.

**Response:**

```json
{
  "id":          "550e8400-e29b-41d4-a716-446655440000",
  "name":        "Session Memories",
  "description": "Auto-generated entries from past conversations. Created on first session memorization.",
  "enabled":     true,
  "entryCount":  12
}
```

**Error responses:**

| Status | Condition |
|---|---|
| `500` | File system read/write failure during find-or-create |

> Registered before `GET /api/tomes/:id` so the literal segment isn't shadowed by the UUID-validated route.

---

### `GET /api/tomes/:id`

Returns the full Tome including all entries.

**Response:**

```json
{
  "id":      "550e8400-e29b-41d4-a716-446655440000",
  "name":    "World Lore",
  "enabled": true,
  "entries": {
    "<uid>": { ... entry object ... }
  }
}
```

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Invalid Tome ID format |
| `404` | Tome not found |

---

### `PUT /api/tomes/:id`

Replaces the `entries` map of an existing Tome. Optionally updates metadata fields in the same call.

**Request body:**

```json
{
  "entries": { "<uid>": { ... } },
  "name":    "Optional new name",
  "enabled": true
}
```

Only `entries` is required. Any additional top-level fields (`name`, `description`, `enabled`) are merged into the stored Tome metadata.

**Response:** `{ "ok": true }`

---

### `PATCH /api/tomes/:id`

Updates Tome metadata only (does not touch entries).

**Request body:**

```json
{
  "name":        "New name",
  "description": "Updated description.",
  "enabled":     false
}
```

All fields are optional; only provided fields are updated.

**Response:** `{ "ok": true }`

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Invalid Tome ID format |
| `404` | Tome not found |
| `500` | File system write failure |

---

### `DELETE /api/tomes/:id`

Deletes the Tome file permanently.

**Response:** `{ "ok": true }`

---

### `DELETE /api/tomes/:id/entries/:uid`

Removes a single entry from a Tome by UID and rewrites the Tome file.

**Response:** `{ "ok": true }`

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Invalid Tome ID or entry UID format |
| `404` | Tome or entry not found |

---

### `POST /api/tomes/default/entries`

Adds a single entry to the first enabled Tome (or creates a "General" Tome if none exists). Used by the `save_to_tome` built-in tool so the model can write knowledge back mid-conversation.

**Request body:**

```json
{
  "comment":   "Short label",
  "content":   "Entry body — required, max 16 KB.",
  "keys":      ["keyword1", "keyword2"],
  "learnedAt": "2026-05-11T14:30:00.000Z"
}
```

`content` is required (max 16 KB). `keys` may be a string array or a comma-separated string. `comment` defaults to `"Auto-saved entry"` if omitted. `learnedAt` defaults to the current server time.

**Response:** `{ "ok": true, "tomeId": "<uuid>", "uid": "<new entry uid>" }`

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Missing/blank `content`, `content` exceeds 16 KB, or `comment` is not a string |
| `500` | File system write failure |

---

## Session memorization

The memorization queue is implemented in `memorization.js` and runs as an in-process worker on the server. Jobs persist to `tomes/.memorization-queue.json` so they survive tab close, idle rollover, and server restart. See [`sessions.md`](sessions.md#session-memorization) for the lifecycle and triggers.

### `POST /api/memorize`

Enqueue a memorization job. Accepts both `application/json` and `text/plain` JSON (the latter is what `navigator.sendBeacon` uses from the browser's `beforeunload` handler).

**Request body:**

```json
{
  "sessionId":    "550e8400-e29b-41d4-a716-446655440000",
  "scope":        "session | topic",
  "topicId":      "<topic id, when scope = topic>",
  "topicLabel":   "<user-supplied topic label, when scope = topic>",
  "messageRange": { "start": 0, "end": 42 },
  "messages":     [ /* role + content turns */ ],
  "provider":     "nanogpt",
  "apiKey":       "sk-...",
  "model":        "gpt-4o-mini"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionId` | string (UUID) | Yes | Session the memorization belongs to |
| `scope` | string | Yes | `"session"` for full-session memorization, `"topic"` for a topic-bounded range |
| `topicId` | string | When `scope = topic` | Identifier of the topic being memorized |
| `topicLabel` | string | Optional | When the user named the topic themselves, the worker injects a "focus topic" block into the summarizer prompt so the generated entry centers on that topic. Omit (or pass `null`) for auto-named topics (`"Topic 1"`, etc.) — the client suppresses the field for those automatically. |
| `messageRange` | object | When `scope = topic` | `{ start, end }` indices into the supplied `messages` array |
| `messages` | array | Yes | Conversation turns to summarise (user/assistant only — tool plumbing is filtered server-side) |
| `provider` / `apiKey` / `model` | string | Yes | Provider credentials the worker uses for the LLM call |

**Response (`202 Accepted`):**

```json
{ "jobId": "550e8400-e29b-41d4-a716-446655440000", "deduped": false }
```

`deduped` is `true` when an active job with the same `sessionId + scope + topicId + messageRange` already exists, in which case `jobId` is the existing job's id.

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Invalid session ID, malformed body, or fewer than 2 readable messages |

---

### `GET /api/memorize`

List every job in the queue. API keys and message bodies are stripped from the response.

**Response:**

```json
[
  {
    "id":            "<job uuid>",
    "sessionId":     "<session uuid>",
    "scope":         "session",
    "topicId":       null,
    "status":        "pending | processing | done | failed",
    "attempts":      0,
    "createdAt":     "<ISO>",
    "nextAttemptAt": "<ISO>",
    "result":        { "entryCount": 3 },
    "error":         null,
    "acknowledged":  false
  }
]
```

---

### `POST /api/memorize/:id/ack`

Mark a terminal (`done` or `failed`) job as seen by the UI. Acknowledged jobs are pruned 24 hours later.

**Response:** `{ "ok": true }`

**Error responses:**

| Status | Condition |
|---|---|
| `400` | `id` is not a UUID |
| `404` | Job not found or not in a terminal state |

---

### `DELETE /api/memorize/:id`

Cancel a pending job. Jobs already in `processing` cannot be cancelled.

**Response:** `{ "ok": true }`

**Error responses:**

| Status | Condition |
|---|---|
| `400` | `id` is not a UUID |
| `409` | Job not found or already running |

---

## Entity-core

These endpoints write through to the entity-core MCP subprocess via `thalamus.js`. They are exposed for the built-in `save_memory` and `update_identity` tools and degrade gracefully (`502`) when entity-core is unavailable.

### `POST /api/entity/memory`

Writes a new memory entry to the long-term memory system.

**Request body:**

```json
{
  "content":     "Memory text.",
  "granularity": "daily",
  "date":        "2026-05-11"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `content` | string | Yes | Memory body (max 8 KB) |
| `granularity` | string | Yes | One of `daily`, `weekly`, `monthly`, `yearly`, `significant` |
| `date` | string | No | Anchor date for the memory (defaults to today) |

**Response:** `{ "ok": true }`

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Missing/blank `content`, `content` exceeds 8 KB, or invalid `granularity` |
| `502` | entity-core unavailable |

---

### `POST /api/entity/identity`

Appends to or updates a section of an identity file.

**Request body:**

```json
{
  "category": "user",
  "filename": "user_notes.md",
  "heading":  "Preferences",
  "content":  "Prefers morning meetings.",
  "mode":     "append"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `category` | string | Yes | One of `self`, `user`, `relationship`, `custom` |
| `filename` | string | Yes | Simple `.md` filename (letters, numbers, underscores) |
| `content` | string | Yes | Content to write (max 8 KB) |
| `mode` | string | No | `append` (default) or `update_section` |
| `heading` | string | When `mode = update_section` | The heading whose section should be replaced |

**Response:** `{ "ok": true }`

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Invalid category, filename, missing content, or missing heading when `mode = update_section` |
| `502` | entity-core unavailable |

---

### Knowledge editor endpoints

The endpoints below back the **Knowledge editor** modal in the sidebar and the LLM-callable editing tools (`update_memory`, `delete_memory`, `rewrite_identity_section`, `update_graph_node`, `delete_graph_node`, `update_graph_edge`, `delete_graph_edge`). Every destructive op (`PUT`, `PATCH`, `DELETE`) auto-snapshots entity-core before the underlying MCP call, so a mistake is always recoverable via the snapshots endpoints. All return `502` when entity-core is unavailable; reads return entity-core's JSON verbatim.

#### Memory

| Method & path | Purpose | Body / query |
|---|---|---|
| `GET /api/entity/memories` | List memories. Query: `granularity` (optional, one of the five tiers), `limit` (1–100, default 50) | — |
| `GET /api/entity/memories/:granularity/:date` | Read one memory | — |
| `PUT /api/entity/memories/:granularity/:date` | Overwrite the memory's content (auto-snapshots) | `{ "content": "…", "editedBy": "user-edit" }` (≤ 16 KB) |
| `DELETE /api/entity/memories/:granularity/:date` | Delete the memory (auto-snapshots). Query: `instanceId`, `slug` (optional) | — |
| `POST /api/entity/memories/supersede` | Write a new dated memory contradicting an old one, prefixed with `[supersedes <granularity>/<date>]`. Preserves history; recency-decay demotes the stale entry | `{ "content": "…", "granularity": "daily", "supersedes": { "granularity": "daily", "date": "2026-05-15" } }` |

#### Identity

| Method & path | Purpose | Body |
|---|---|---|
| `GET /api/entity/identity` | All identity files grouped by category | — |
| `PUT /api/entity/identity/:category/:filename/sections/:section` | Rewrite the body of one markdown section (auto-snapshots) | `{ "content": "…" }` (≤ 16 KB) |

#### Graph

| Method & path | Purpose | Body / query |
|---|---|---|
| `GET /api/entity/graph/nodes` | List graph nodes. Query: `type` (optional), `limit` (1–500, default 200), `offset` | — |
| `GET /api/entity/graph/search` | Text search across graph nodes (backs the `find_graph_node` LLM tool). Query: `q` (required), `type` (optional), `limit` (1–100, default 10) | — |
| `GET /api/entity/graph/nodes/:id/subgraph` | Node + 1-hop neighbours and edges (backs the `find_graph_edges` LLM tool). Query: `depth` (1–3, default 1) | — |
| `GET /api/entity/graph/full` | All nodes + all deduplicated edges in one payload (backs the Knowledge editor's Map view). Walks each node's 1-hop subgraph under a 16-worker concurrency cap and drops edges whose endpoints fall outside the (possibly type-filtered) visible set so the rendered legend matches what's drawn. Query: `type` (optional), `limit` (1–500, default 500) | — |
| `POST /api/entity/graph/nodes` | Create a new node via `graph_node_create`. At least one of `label` / `type` / `description` is required | `{ "label"?: "…", "type"?: "…", "description"?: "…" }` |
| `PATCH /api/entity/graph/nodes/:id` | Update label / type / description (auto-snapshots) | `{ "label"?: "…", "type"?: "…", "description"?: "…" }` |
| `DELETE /api/entity/graph/nodes/:id` | Delete the node and its edges (auto-snapshots). Query: `permanent=1` for hard delete | — |
| `POST /api/entity/graph/edges` | Create a new edge via `graph_edge_create`. `fromId` and `toId` are required and must differ; `weight` is clamped to `[0, 1]` | `{ "fromId": "…", "toId": "…", "type"?: "…", "weight"?: 0.5 }` |
| `PATCH /api/entity/graph/edges/:id` | Update edge type or weight (auto-snapshots) | `{ "type"?: "…", "weight"?: 0.85 }` |
| `DELETE /api/entity/graph/edges/:id` | Delete one relationship; both endpoint nodes remain (auto-snapshots) | — |

Creates do not auto-snapshot — they are additive and reversible via the matching `DELETE`.

#### Snapshots

| Method & path | Purpose |
|---|---|
| `GET /api/entity/snapshots` | List available snapshots |
| `POST /api/entity/snapshots` | Create a snapshot now (user-triggered; in addition to the auto-snapshots before destructive ops) |
| `POST /api/entity/snapshots/:id/restore` | Restore one snapshot — overwrites current memory / identity / graph with its contents |

---

## Interest layer

### `POST /api/interest/engage`

Records a turn's engagement into Unruh's interest layer (Milestone 5). The frontend calls this fire-and-forget after each completed turn; it never blocks or fails the conversation, and degrades silently when Unruh is unavailable.

**Request body:**

```json
{
  "topics": [{ "label": "owl aerodynamics", "spanMessages": 6 }],
  "responseChars": 1840
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `topics` | array | Yes | Currently-open topic markers. Each `{ label, spanMessages }`. Empty array → no-op. Deduped by label (largest span wins); capped at 32 entries. |
| `topics[].label` | string | Yes | Topic label; the interest node is looked up / created by this. |
| `topics[].spanMessages` | number | No | How many messages the topic has been open for (persistence signal). |
| `responseChars` | number | No | Length of the turn's final assistant reply (token-volume signal; chars ≈ tokens × 4). |

**Weight formula** (`interestEngagementDelta` in `server.js`): `min(responseChars / 1500 × 0.1, 0.5)` (token volume) `+ min(spanMessages × 0.05, 0.3)` (persistence). The per-topic delta is forwarded to Unruh's `interest_record` tool with `source: "chat"`, which applies decay-then-add.

**Response:** `{ "ok": true, "recorded": [{ "topic": "...", "delta": 0.23, "ok": true }] }`. `recorded[].ok` is `false` when Unruh was down for that bump.

---

## Session handoff

### `POST /api/session/handoff`

Stores a session-end handoff in Unruh (Milestone 6) so the next session resumes mid-thought. The frontend calls this fire-and-forget when a session ends, after summarising the conversation into an intent + open threads via the chat LLM (using `enrich: "static"` so the summary is in the Familiar's voice). Degrades silently when Unruh is unavailable.

**Request body:**

```json
{
  "intent": "I was helping you outline the thesis intro; you were stuck on the hook",
  "threads": ["lead with the anecdote or the statistic?", "tighten the second paragraph"],
  "sessionId": "f1e2d3c4-..."
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `intent` | string | No | One-sentence "what you were doing last", in the Familiar's voice. |
| `threads` | string[] | No | Unfinished questions/tasks. Blank entries are dropped. |
| `sessionId` | string | No | Source session id (provenance). |

A handoff with neither intent nor threads is a no-op (no hollow "Last session:" header). Writing a new handoff supersedes any prior unconsumed one. The next session's first `/api/chat` surfaces it at the top of `[Temporal Context]` and marks it consumed so it doesn't repeat.

**Response:** `{ "ok": true }` (`ok: false` when Unruh was down).

---

## Health & version

### `GET /api/health`

Returns `{ "ok": true, "version": "<package.json version>" }`. Useful for uptime checks or confirming the server is running.

### `GET /api/version`

Returns `{ "version": "<package.json version>" }`. Read once at startup from `package.json`. The UI uses this to populate the sidebar footer badge.
