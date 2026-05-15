# Architecture

## Overview

Proto-Familiar is a Node.js application split into a thin Express server and a vanilla-JS single-page frontend. The server's primary job is to proxy LLM requests (avoiding browser CORS restrictions), enrich them with entity-core context, and persist session logs and Tomes.

```
Browser (public/)
    │
    │  HTTP + SSE
    ▼
server.js  (Express, Node 18+, ESM)
    │
    ├── thalamus.js  ──►  entity-core-alpha  (Deno, stdio MCP)
    │
    ├── logs/         (session JSON files, git-ignored)
    └── tomes/        (per-Tome JSON files, git-ignored)
```

## File Structure

```
/
├── server.js            Express server — API proxy, log/tome endpoints
├── thalamus.js          Entity-core MCP bridge — enriches every LLM request
├── package.json
├── .gitignore
│
├── logs/                Session JSON files (auto-created, git-ignored)
├── tomes/               Per-Tome JSON files (auto-created, git-ignored)
│
├── scripts/
│   ├── import-entity.js Import an entity-core data directory into the local instance
│   └── import-tome.js   Convert a SillyTavern lorebook export to Proto-Familiar tome format
│
├── public/
│   ├── index.html       App shell — sidebar, chat pane, all modals
│   ├── style.css        All styling — dark/light themes, responsive layout
│   └── app.js           All frontend logic — state, API calls, rendering, topics, Tomes engine
│
├── docs/                This documentation
│
└── Research/            Background reading on architecture and mental-health AI design
```

## Component Responsibilities

### `server.js`

The Express server handles:
- **`POST /api/chat`** — validates the request, calls `thalamus.js:enrich()` to prepend entity-core context to the system message, then proxies the enriched request to the upstream LLM provider. Supports both streaming (SSE) and non-streaming modes.
- **`POST /api/debug-prompt`** — returns the enriched message array without calling any upstream LLM; used by the prompt inspector UI.
- **Log endpoints** (`/api/log`, `/api/logs`, `/api/logs/:id`, `DELETE /api/logs/:id`) — persist and retrieve session JSON files from the `logs/` directory.
- **Tome endpoints** (`GET /api/tomes`, `POST /api/tomes`, `GET /api/tomes/:id`, `PUT /api/tomes/:id`, `PATCH /api/tomes/:id`, `DELETE /api/tomes/:id`, `DELETE /api/tomes/:id/entries/:uid`) — manage individual Tome files in the `tomes/` directory.
- **`GET /api/health`** — lightweight uptime probe.
- **Static file serving** — serves `public/` at the root.

### `thalamus.js`

The entity-core bridge:
- On startup, spawns `entity-core-alpha` as a child Deno process over stdio using the MCP (Model Context Protocol) SDK. The subprocess is launched with `deno run -A --unstable-cron`, granting it all Deno permissions. For a personal local tool this is fine; in a shared or networked environment consider restricting to `--allow-read=<data-dir> --allow-write=<data-dir> --allow-env` once you have audited the minimum permissions your entity-core build needs.
- Exposes a single `enrich(userMessage)` function called once per chat request.
- Fires three MCP tool calls in parallel (`identity_get_all`, `memory_search`, `graph_node_search`). A failure in any one does not block the others (`Promise.allSettled`).
- Assembles the results into a structured context block and prepends it to the system message.
- Returns an empty string (graceful degradation) if entity-core is unreachable.

### `public/app.js`

All frontend logic in a single ES5-style script:
- **State management** — a plain `state` object holds provider, API key, model, all prompt fields, messages, session metadata, topics, Tome registry + cache, and tool settings.
- **Persistence** — settings and message history are stored in `localStorage`; sessions are also written to the server via `POST /api/log` (fire-and-forget). Tomes are stored server-side in `tomes/`.
- **Message building** — `buildApiMessages()` assembles the full message array for each request: system message (with Tome injections at each position), conversation history, new user turn, post-history prompt.
- **Tome engine** — full SillyTavern-compatible World Info implementation across multiple Tomes: keyword scanning, injection positions, selective logic, timed effects (sticky/cooldown), recursion, and group exclusion. Entries are aggregated from all enabled Tomes before activation.
- **Tool calling loop** — sends tools with each request, executes results client-side, and re-sends up to 5 rounds.
- **Topics** — tracks named conversation slices with coloured gutter bars; triggers LLM-generated summaries saved to a Tome on topic end.
- **Session memorization** — on session close, sends the full conversation to the LLM and saves the extracted topics as entries in the default Tome.
- **UI rendering** — renders messages, tool-call blocks, topic bars, modals, and settings panels.

## Data Flow — Single Chat Request

```
User types message
        │
        ▼
builApiMessages()
   ├── activateTomeEntries()   ← keyword scan across all enabled Tomes → inject at each position
   ├── applyNameVars()          ← {{user}} / {{char}} substitution
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

## Security Design

- **API key handling:** The key travels from browser to `localhost` only. It is never logged or stored by the server — it is used once per request and discarded. The browser persists the key in `localStorage`; do not use the app on shared or untrusted devices.
- **Path traversal prevention:** All file-backed endpoints validate IDs against a strict UUID regex (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`) before constructing any file path. This covers session log IDs, Tome IDs, and Tome entry UIDs.
- **Rate limiting:** `POST /api/chat` enforces a per-IP cap of 20 requests per minute (in-memory, no external dependency) to guard against runaway tool-call loops and accidental public exposure.
- **Prompt inspector endpoint:** `POST /api/debug-prompt` returns the full entity-core enriched context with no authentication. It is intended for local development only — disable or firewall it before any non-localhost deployment.
- **Entity-core permissions:** `thalamus.js` spawns entity-core with `deno run -A`, granting the subprocess all Deno permissions. Acceptable for a personal local tool. For shared deployments, scope to the minimum required flags once audited.
- **Input size limit:** `express.json` is capped at 4 MB. Individual memory and identity write endpoints have tighter per-field caps (8 KB).
- **Local-only default:** The server binds to all interfaces but is not designed to be exposed to the internet without adding authentication middleware.
- **No telemetry:** No data is sent anywhere except the proxied LLM request to the configured provider.
