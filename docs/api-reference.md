# API Reference

All endpoints are served by the Express server at `http://localhost:3000` (or your configured port). The server is a local proxy — it is not intended to be exposed to the public internet without additional authentication.

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

**Enrichment:** Before forwarding, the server calls `thalamus.js:enrich()` to prepend entity-core identity, memory, and knowledge-graph context to the system message. If entity-core is unavailable, the request proceeds without enrichment.

**Streaming response (`stream: true`):**

Returns `Content-Type: text/event-stream`. Events follow the OpenAI SSE format:

```
data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}

data: [DONE]
```

**Non-streaming response (`stream: false`):**

Returns the provider's JSON response verbatim with the provider's original HTTP status code.

**Error responses:**

| Status | Condition |
|---|---|
| `400` | Unknown provider, missing/invalid API key, missing/invalid model, empty messages array |
| `502` | Network error reaching the upstream provider |

---

### `POST /api/debug-prompt`

Returns the full enriched message array that would be sent to the LLM for a given conversation payload — including the entity-core context block — **without** making any upstream API call. Used by the prompt inspector UI.

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

## Tomes

Tomes are stored as individual JSON files in the `tomes/` directory. Each Tome is independently addressable and can be enabled or disabled. The activation engine aggregates entries from all enabled Tomes.

### `GET /api/tomes`

Returns a metadata list of all Tomes (no entry bodies).

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

## Health

### `GET /api/health`

Returns `{ "ok": true }`. Useful for uptime checks or confirming the server is running.
