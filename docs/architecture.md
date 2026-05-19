# Architecture

## Overview

Proto-Familiar is a Node.js application split into a thin Express server and a vanilla-JS single-page frontend. The server's primary job is to proxy LLM requests (avoiding browser CORS restrictions), enrich them with cognitive-module context (entity-core for identity + memory + graph; Unruh, in development, for temporal context), and persist session logs and Tomes.

```
Browser (public/)
    │
    │  HTTP + SSE
    ▼
server.js  (Express, Node 18+, ESM)
    │
    ├── thalamus.js       ──►  entity-core  (Deno, stdio MCP)   — identity / memory / graph
    │                     ──►  Unruh        (Python via uv, stdio MCP) — schedule / interests
    ├── memorization.js   ──►  persistent queue + worker for session memorization
    ├── providers.js          shared chat-completions URL map
    │
    ├── logs/         (session JSON files, git-ignored)
    └── tomes/        (per-Tome JSON files; queue file .memorization-queue.json git-ignored)
```

Thalamus is a **plural-peer mediator**: each cognitive module is a separate stdio MCP child process spawned at server boot. Failures degrade independently — entity-core down doesn't take Unruh out, and vice versa — and `enrich()` fans out across whichever peers are connected via `Promise.allSettled`. Empty results omit their section entirely; the LLM only sees scaffolding when there's something to put in it.

## File Structure

```
/
├── server.js                Express server — API proxy, log/tome/memorize endpoints, settings
├── thalamus.js              MCP bridge — spawns entity-core + Unruh, enriches every LLM request
├── temporal-format.js       Pure renderer for Unruh's payload (split out for testability)
├── memorization.js          Session-memorization queue + worker (persistent, retrying)
├── providers.js             Shared chat-completions URL map (used by server.js + thalamus.js)
├── package.json
├── .gitignore
│
├── logs/                    Session JSON files (auto-created, git-ignored)
├── tomes/                   Per-Tome JSON files (auto-created, git-ignored)
│
├── unruh/                   In-tree Python module (Unruh — temporal context, WIP)
│   ├── pyproject.toml       uv-managed Python project, deps locked in uv.lock
│   ├── src/unruh/server.py  MCP server exposing health_check + temporal_context tools
│   ├── data/                SQLite + state (auto-created, git-ignored)
│   └── tests/               pytest contract tests on the tool return shapes
│
├── scripts/
│   ├── import-entity.js     Import an entity-core data directory into the local instance
│   ├── import-tome.js       Convert a SillyTavern lorebook export to Proto-Familiar tome format
│   ├── ensure-unruh-deps.mjs npm prestart hook: materialise unruh/.venv if missing
│   └── ensure-port-free.mjs npm prestart hook: auto-recycle stale Proto-Familiar on the port
│
├── tests/                   Node test suite (run via `npm test`)
│
├── public/
│   ├── index.html           App shell — sidebar, chat pane, all modals
│   ├── style.css            All styling — dark/light themes, responsive layout
│   └── app.js               All frontend logic — state, API calls, rendering, topics, Tomes engine
│
├── docs/                    This documentation (incl. unruh-design.md + unruh-implementation-plan.md)
│
└── Research/                Background reading on architecture and mental-health AI design
```

## Component Responsibilities

### `server.js`

The Express server handles:
- **`POST /api/chat`** — validates the request, calls `thalamus.js:enrich()` to prepend entity-core context to the system message, then proxies the enriched request to the upstream LLM provider. Supports both streaming (SSE) and non-streaming modes. Attaches a `_thalamus` envelope (`{ entityContext }`) to every successful response — on the non-streaming path as a top-level JSON field, on the streaming path as the first SSE `data:` line, so the prompt inspector can show the actual injected text.
- **`POST /api/debug-prompt`** — returns the enriched message array without calling any upstream LLM; available for offline preview. The live prompt inspector reads the `_thalamus` envelope from `/api/chat` instead, so what it shows reflects the actual injection rather than a re-derived preview that could drift after intervening memory or identity writes.
- **Log endpoints** (`/api/log`, `/api/logs`, `/api/logs/:id`, `DELETE /api/logs/:id`) — persist and retrieve session JSON files from the `logs/` directory.
- **Tome endpoints** (`GET /api/tomes`, `POST /api/tomes`, `GET /api/tomes/:id`, `PUT /api/tomes/:id`, `PATCH /api/tomes/:id`, `DELETE /api/tomes/:id`, `DELETE /api/tomes/:id/entries/:uid`) — manage individual Tome files in the `tomes/` directory.
- **Memorization endpoints** (`POST /api/memorize`, `GET /api/memorize`, `POST /api/memorize/:id/ack`, `DELETE /api/memorize/:id`) — enqueue, list, acknowledge, and cancel session-memorization jobs. The `POST` endpoint accepts both `application/json` (fetch) and `text/plain` JSON (sendBeacon, used in the browser's `beforeunload` handler).
- **`GET /api/health`** — lightweight uptime probe.
- **Static file serving** — serves `public/` at the root.

### `memorization.js`

Server-side session-memorization queue:
- Loads / persists a JSON queue at `tomes/.memorization-queue.json` (atomic write via `tmp` + rename, single-writer mutex). Git-ignored because each job contains the user's API key.
- A single in-process worker ticks every 5 seconds, picks the next `pending` job whose `nextAttemptAt` has elapsed, calls the configured LLM provider directly (same `PROVIDER_URLS` map as `server.js`), parses the JSON response, and writes entries to the dedicated **Session Memories** Tome — creating it if it doesn't exist yet.
- Writes go through a per-Tome-file mutex (`withTomeLock`) so concurrent jobs writing to the same Tome serialise their read-modify-write cycles and never clobber each other.
- Failed jobs retry with exponential backoff (5s → 30s → 2m → 10m → 30m, max 5 attempts), then transition to `failed`. Jobs left in `processing` after a server restart are automatically requeued.
- Idempotency: enqueueing a job with the same `sessionId + scope + topicId + messageRange` as an already-active job returns the existing `jobId` with `deduped: true`.
- Terminal jobs (`done` / `failed`) stay in the queue with their result/error until the client acknowledges them, then are pruned after 24 hours.

### `thalamus.js`

The cognitive-module mediator. Currently bridges two specialists; designed to grow into more.

- On startup, spawns `entity-core` (Deno) and `Unruh` (Python via `uv`) as separate child processes over stdio using the MCP (Model Context Protocol) SDK. entity-core is launched with `deno run -A --unstable-cron`, granting it all Deno permissions — fine for a personal local tool, restrictable to `--allow-read=<data-dir> --allow-write=<data-dir> --allow-env` for shared deployments. Unruh runs via `uv run python -m unruh`; `uv` is resolved via `resolveUvBinary()`, which probes common install locations so the spawn works even when PATH doesn't carry uv (e.g. GUI launchers on Windows).
- Exposes a single `enrich(userMessage)` function called once per chat request. It fires four MCP tool calls in parallel — entity-core's `identity_get_all`, `memory_search`, `graph_node_search`, plus Unruh's `temporal_context` — and **returns the results as `{ static, dynamic }` so server.js can place them where the upstream LLM's prefix cache wants them** (see [Prompt-cache-aware assembly](#prompt-cache-aware-assembly) below). Each call is wrapped in `Promise.allSettled` so any one failing doesn't take the others out. Unruh's call is additionally wrapped in a 2-second `Promise.race` timeout so a slow Unruh can't block the chat path. Empty sub-blocks are omitted entirely.
- Resolves entity-core's API key from the user-designated saved connection (see [Entity-Core → API key](entity-core.md#api-key-designation)). When the designation changes, `server.js` calls the exported `reconnectEntityCore()` which tears down the child and re-spawns it with fresh env (`ENTITY_CORE_LLM_API_KEY`, `_BASE_URL`, `_MODEL`, and `ZAI_*` aliases for z.ai providers). No server restart required.
- Reconnect-with-backoff on the Unruh child: on close, schedules retries with exponential backoff (1s, 2s, 5s, 10s, 30s; max 10 attempts; counter resets on success). Entity-core uses the same `reconnectEntityCore()` path manually.
- Returns an empty string (graceful degradation) if both peers are unreachable. Pre-existing exports for the Knowledge editor (`listMemories`, `createMemory`, `updateGraphNode`, etc.) still work and target entity-core directly.

### `public/app.js`

All frontend logic in a single ES5-style script:
- **State management** — a plain `state` object holds provider, API key, model, all prompt fields, messages, session metadata, topics, Tome registry + cache, and tool settings.
- **Persistence** — settings and message history are stored in `localStorage`; sessions are also written to the server via `POST /api/log` (fire-and-forget). Tomes are stored server-side in `tomes/`.
- **Message building** — `buildApiMessages()` assembles the full message array for each request: system message (with Tome injections at each position), conversation history, new user turn, post-history prompt.
- **Tome engine** — full SillyTavern-compatible World Info implementation across multiple Tomes: keyword scanning, injection positions, selective logic, timed effects (sticky/cooldown), recursion, and group exclusion. Entries are aggregated from all enabled Tomes before activation.
- **Tool calling loop** — sends tools with each request, executes results client-side, and re-sends up to 5 rounds.
- **Topics** — tracks named conversation slices with coloured gutter bars; triggers LLM-generated summaries saved to a Tome on topic end.
- **Session memorization** — enqueues a job to the server (`POST /api/memorize`) on idle timeout, manual Clear, tab close (`beforeunload` via `navigator.sendBeacon`), topic end, or the **Memorize now** button. Polls `GET /api/memorize` every 30 seconds (and on window focus) to toast completed or failed jobs, then ACKs them. The LLM call and Tome write happen entirely server-side in `memorization.js`.
- **UI rendering** — renders messages, tool-call blocks, topic bars, modals, and settings panels.

## Data Flow — Single Chat Request

```
User types message
        │
        ▼
builApiMessages()
   ├── activateTomeEntries()   ← keyword scan across all enabled Tomes → inject at each position
   ├── applyNameVars()          ← {{user}} / {{char}} / {{elapsedTime}} / {{timeSinceLastSession}} substitution
   └── assembles system + history + new user turn + post-history prompt
        │
        ▼
POST /api/chat  { provider, apiKey, model, messages, stream, tools, … }
        │
        ▼  server.js
enrich(lastUserMessage)            ← thalamus.js
   ├── identity_get_all  ──►  entity-core (MCP)
   ├── memory_search     ──►  entity-core (MCP)
   └── graph_node_search ──►  entity-core (MCP)
        │
        ▼
Prepend entity-core block to system message
        │
        ▼
fetch(providerURL, enrichedPayload)
        │
        ▼  SSE stream or JSON
Tool calls?
   ├── YES → execute client-side → append results → re-send (up to 5 rounds)
   └── NO  → render assistant message → save to localStorage + server
```

## Prompt-cache-aware assembly

LLM providers (z.ai, OpenAI, Anthropic) all cache the longest common prefix across consecutive requests and bill the cached region at a fraction of the normal rate (z.ai, for example, drops cached input tokens by ~90%). For Proto-Familiar this matters: the entity-core identity layer is multi-kilobyte and barely changes within a session, so caching it is a big save — but only if we don't accidentally put per-turn-dynamic content in front of it.

`thalamus.js:enrich()` returns the context as two strings:

| Block | What's in it | Lifetime | Where server.js puts it |
|---|---|---|---|
| `static` | base_instructions + all identity files (self / user / relationship / custom) | Stable across turns within a session (changes only when identity files are edited) | Prepended to the system message at index 0 |
| `dynamic` | RAG memory matches + knowledge-graph excerpt + `[Temporal Context]` | Re-derived every turn (RAG is query-dependent, temporal is clock-dependent) | Inserted as a separate `role: 'system'` message at `max(1, messages.length - depth)` |

The depth defaults to 4 and is configurable via the `thalamusDynamicDepth` setting (1–50, synced via `SERVER_SYNCED_KEYS`). Smaller values place the dynamic block closer to the current question (better model attention to the retrieved memories); larger values move it further back (more conversation history above the injection becomes cache-stable).

`injectDynamicAtDepth(messages, dynamicContent, depth)` in `server.js` is a pure helper that does the array splice; `tests/depth-inject.test.mjs` covers its behaviour including the load-bearing invariant *"messages[0..injectedAt-1] is the same reference as the input"* — without that invariant, the prefix-cache claim is hollow.

The `_thalamus` envelope returned to the client carries `{ static, dynamic, depth, injectedAt }` so the prompt inspector can render each block with its own color (purple for static, teal for dynamic) at the exact position the server placed it.

---

## Security Design

- **API key handling:** The key travels from browser to `localhost` only. It is never logged or stored by the server — it is used once per request and discarded. The browser persists the key in `localStorage`; do not use the app on shared or untrusted devices.
- **Path traversal prevention:** All file-backed endpoints validate IDs against a strict UUID regex (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`) before constructing any file path. This covers session log IDs, Tome IDs, and Tome entry UIDs.
- **Rate limiting:** `POST /api/chat` enforces a per-IP cap of 20 requests per minute (in-memory, no external dependency) to guard against runaway tool-call loops and accidental public exposure.
- **Prompt inspector endpoint:** `POST /api/debug-prompt` returns the full entity-core enriched context with no authentication. It is intended for local development only — disable or firewall it before any non-localhost deployment.
- **Entity-core permissions:** `thalamus.js` spawns entity-core with `deno run -A`, granting the subprocess all Deno permissions. Acceptable for a personal local tool. For shared deployments, scope to the minimum required flags once audited.
- **Input size limit:** `express.json` is capped at 4 MB. Individual memory and identity write endpoints have tighter per-field caps (8 KB).
- **Local-only default + runtime gate:** The server binds to `0.0.0.0` but a middleware rejects every non-loopback request with `403` until the in-UI Tailscale toggle is flipped on. Effective behaviour out of the box matches the historical localhost-only bind. `/api/debug-prompt`, the entity-core knowledge editor API, and the toggle endpoint itself (`POST /api/tailscale`) are all unauthenticated, so the toggle should stay off unless you trust everyone on the network. Don't expose to the public internet without adding authentication middleware.
- **No telemetry:** No data is sent anywhere except the proxied LLM request to the configured provider.
