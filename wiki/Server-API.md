# Server API

The server is implemented in `server.js` (Express, Node.js 22+, ESM).

## Base behavior

- Serves static frontend from `public/`
- Proxies chat requests to provider endpoints
- Persists session logs to `logs/`
- Stores Tomes as per-file JSON in `tomes/`
- Runs a persistent server-side memorization worker
- Validates all path-bearing IDs against a single strict UUID regex (`isValidUUID`) before file access

## Endpoints

### `POST /api/chat`

Proxy request to selected provider.

**Body (main fields):**

- `provider` (`nanogpt | zai | zai-coding | google`)
- `apiKey`
- `model`
- `messages`
- `stream` (boolean)
- optional: `temperature`, `max_tokens`, `tools`, `tool_choice`
- optional: `enrich` — enrichment mode (`true`/omitted = full, `"static"` = persona only, `false` = none)

Returns:

- SSE stream when `stream: true`
- JSON response when `stream: false`

### `POST /api/log`

Create/overwrite a session log.

**Body (main fields):**

- `sessionId`
- `startedAt`
- `endedAt` (nullable)
- `provider`
- `model`
- `messages` (array)

### `GET /api/logs`

Returns metadata list for all saved sessions (newest first).

### `GET /api/logs/:id`

Returns full JSON for one saved session.

### `DELETE /api/logs/:id`

Deletes one saved session log.

### Tomes

- `GET /api/tomes` — list all Tomes (metadata + entry count)
- `POST /api/tomes` — create a new Tome (`{ name, description? }`)
- `GET /api/tomes/session-memories` — find or create the special **Session Memories** Tome
- `GET /api/tomes/:id` — full Tome with all entries
- `PUT /api/tomes/:id` — replace entries (optionally update metadata)
- `PATCH /api/tomes/:id` — update metadata only
- `DELETE /api/tomes/:id` — delete a Tome file
- `DELETE /api/tomes/:id/entries/:uid` — delete a single entry
- `POST /api/tomes/default/entries` — append a single entry to the first enabled Tome (used by the `save_to_tome` built-in tool)

### Session memorization

- `POST /api/memorize` — enqueue a memorization job (accepts `application/json` or `text/plain` JSON via `sendBeacon`)
- `GET /api/memorize` — list all jobs (sanitised — no API keys or message bodies)
- `POST /api/memorize/:id/ack` — mark a terminal job as seen by the UI
- `DELETE /api/memorize/:id` — cancel a pending job

### Phylactery write-through

- `POST /api/entity/memory` — write a long-term memory entry (`save_memory` tool). The `/api/entity/*` route prefix is a legacy alias kept for compatibility; the canonical store is Phylactery.
- `POST /api/entity/identity` — append to or update a section of an identity file (`update_identity` tool)

### Unruh (temporal context)

- `POST /api/interest/engage` — record a turn's engagement (open topics + reply length) so interests accrue weight
- `POST /api/session/handoff` — store a session-end intent + open threads for the next session to resume from

Both fire-and-forget; both degrade silently when the Unruh module is absent.

### `POST /api/debug-prompt`

Returns the full enriched message array that would be sent to the LLM, without calling any upstream provider. Used by the prompt inspector.

### `GET /api/health`

Returns `{ "ok": true }`.

For full request/response shapes see [`docs/api-reference.md`](../docs/api-reference.md).
