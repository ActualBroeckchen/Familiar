# Architecture — start here

New to this repo? Read this first. It's the **map**: what the pieces are, where
to look, and how the ~150 root files group into a handful of domains. For
component-level depth (data flow, prompt-assembly order, every loop and
endpoint) read [`docs/architecture.md`](docs/architecture.md) once this page has
oriented you.

> **Layout:** the domain modules live under **`src/<domain>/`** — one folder per
> domain in the map below (`src/voice/`, `src/browser/`, `src/schedule/`,
> `src/safety/`, …). The **~20 files still at the repo root are the app core**:
> the entry point (`server.js`), the connective tissue (`thalamus.js`,
> `cerebellum.js`), and cross-cutting helpers (`macros.js`, `providers.js`,
> `llm-call.js`, `tool-surfacing.js`, `slug-ids.js`, `relative-time.js`,
> `repo-root.js`, `own-files.js`, …). That split is deliberate — root = the app
> spine, `src/` = the domains. (History of the move: [`docs/repo-organization-plan.md`](docs/repo-organization-plan.md).)

## What Proto-Familiar is (in one breath)

A local Node server (`server.js`) that runs a chat + voice frontend for an AI
"Familiar," backed by two in-tree Python/uv MCP services it spawns —
**Phylactery** (`./phylactery/`, the canonical identity + memory store) and
**Unruh** (`./unruh/`, temporal/schedule) — plus a web UI (`./public/`) and a
set of always-on background workers ("loops"). Product/user intro is in
[`README.md`](README.md); the philosophy that drives the code style is in
[`CLAUDE.md`](CLAUDE.md).

## The five-minute tour (read in this order)

1. **`server.js`** — the entry point. HTTP + WebSocket surface, boots everything,
   wires the chat turn. Start here to see what exists.
2. **`thalamus.js`** — the bridge to the MCP services and the assembler of
   injected context (identity + memory + temporal + care blocks). The "what does
   the model see each turn" file.
3. **`cerebellum.js`** — the tool layer: every Familiar-facing tool's definition
   and executor, plus `composeActiveTools` / `executeToolCall`. Wide by design.
4. **The safety spine** — `crisis-signals.js` → `threat-tracker.js` →
   `silence-triage-loop.js` + `noticing.js`. How distress is scored and acted on.
   **Changes here need human sign-off** (see CLAUDE.md).
5. **`call-engine.js`** — the platform-neutral heart of a live voice call;
   `voice-web-adapter.js` / `voice-discord-adapter.js` are transport-only.

## Source map — the root files by domain

Every root `*.js`/`*.mjs` belongs to one of these. (This is also the target
`src/` layout in the reorg plan.)

| Domain | What it is | Representative files |
|---|---|---|
| **core / orchestration** | entry, MCP bridge, tools, prompts, providers, macros | `server.js`, `thalamus.js`, `cerebellum.js`, `organs.js`, `core-prompts.js`, `macros.js`, `providers.js`, `llm-call.js`, `injection-guard.js` |
| **safety** ⚠️ | distress scoring + when/whether to act (human sign-off) | `crisis-signals.js`, `threat-tracker.js`, `silence-triage-loop.js`, `noticing.js`(+`-loop`), `outgoing-filter.js`, `wait-streak.js` |
| **memory / knowledge** | ingestion, coverage, content-gating, graph vocab | `memorization.js`, `memory-coverage.js`, `memory-sweep-loop.js`, `content-tags.js`, `content-regate.js`(+`-loop`) |
| **voice / audio** (~34) | live calls, ASR/TTS, diarization, room-sound, enrolment | `call-engine.js`, `audio-worker*.{js,mjs}`, `voice-*.js`, `voiceprints.js`, `voices.js` |
| **discord / village** | gateway, the people/rooms registry, audience gating | `discord-gateway.js`, `village.js`, `villager-consent.js`, `audience.js`, `knocks.js` |
| **schedule / temporal** | recurrence, alerts, needs, day rhythm (Unruh-facing) | `recurrence.js`, `event-alerts.js`, `temporal-format.js`, `needs-tracking.js`(+`-loop`), `reminders-loop.js`, `stewardship.js` |
| **google calendar** | one-way sync + write-back | `gcal-*.js` |
| **browser / reading** | the Familiar's own web browser + page reading | `browser-*.js`, `cdp-launcher.js`, `page-watch.js`(+`-loop`), `reader-router.js`, `reddit-reader.js` |
| **web search / weather** | keyless + API search, forecast | `websearch.js`, `websearch-providers.js`, `weather-*.js` |
| **vision / media** | image understanding, media store + retention | `vision.js`, `media.js`, `media-retention.js`(+`-loop`), `zai-vision.js`, `gemini-file-api.js` |
| **pondering / interests** | the Familiar's own thought loop + surfacing | `pondering.js`(+`-loop`,`-cadence`), `ponder-*.js`, `interest-picker.js`, `surface-context.js` |
| **tomes (lorebook)** | keyword lore + graduation into canon | `tome-store.js`, `tome-lore.js`, `tome-macros.js`, `tome-graduation.js`(+`-loop`), `manual-tome.js` |
| **warmth / reach-out** | non-crisis proactive contact | `reachout.js`(+`-loop`), `reach-out-log.js` |
| **sessions / own-files** | session logs, unification, self-file access | `session-log.js`, `session-bindings.js`, `own-files.js`, `last-activity.js` |
| **ward / consent** | connections, the memory-consent queue | `ward-connections.js`, `ward-consent-queue.js` |

The **background loops** all follow one pattern — a `*-loop.js` worker with a
hard `PROTO_FAMILIAR_*_DISABLED` env off-switch. They're enumerated in
[`docs/architecture.md`](docs/architecture.md) ("Autonomous loops").

## Directory legend

| Path | What lives here |
|---|---|
| root `*.js` / `*.mjs` | the Node server modules (see the domain map above) |
| `public/` | the browser UI (`app.js`, `index.html`, `style.css`, worklets) |
| `phylactery/` | in-tree Python/uv MCP service — canonical identity + memory |
| `unruh/` | in-tree Python/uv MCP service — temporal / schedule |
| `voicebox/` | the local TTS engine assets/runtime |
| `scripts/` | dev + install helpers, and the audits (`audit-wiring.mjs`) |
| `tests/` | the Node test suite (`node --test tests/*.test.mjs`) |
| `docs/` | **authoritative developer docs** — `architecture.md` + the build specs |
| `wiki/` | **user-facing** guides (Getting-Started, Server-API, Config) — mirrors the GitHub wiki |
| `almanac/` | the generated CodeAlmanac wiki (the *why*; see CLAUDE.md) — read via `codealmanac`, not by hand |
| `Research/` | background design essays and notes (not code docs) |
| `logs/`, `media/`, `tomes/`, `voices/` | **runtime state** (mostly git-ignored); not source |

## Running it

- Install + start: `./start.sh` (or `start.bat`) — prestart hooks materialise the
  Python venvs and free the port. Default port **8742**.
- Tests: `npm test` (`node --test tests/*.test.mjs`).
- Wiring audit: `npm run audit:wiring` (catches dead lookups, undocumented
  off-switches, duplicate dispatch keys, etc.).
- Version is the single source of truth in `package.json` (`version`).

## Conventions you must know before editing

These are load-bearing and enforced by review/tests — the full rationale is in
[`CLAUDE.md`](CLAUDE.md):

- **First-person, entity-as-subject** prompt voice (never "you are the Familiar").
- **Safety paths need human sign-off** (the files marked ⚠️ above).
- **Graceful degradation** — no module may take the chat path down; every loop
  ships an off-switch.
- **Code owns exact values** (timestamps, ids, calendar strings), not the model.
- **Model-facing ids are readable slugs**, not UUIDs.
