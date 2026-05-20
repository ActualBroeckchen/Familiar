# Familiar
I've decided to make this public while I work on it so others can access the research.

---

## Proto-Familiar — Chat Frontend

The current version lives in `package.json` as the single source of truth; the server reads it at boot and exposes it via `/api/version`, `/api/health`, the startup banner, and the sidebar footer badge. While in alpha, the version is in the `0.2.x` series (the minor slot is reserved for the next major milestone — see [`docs/unruh-implementation-plan.md`](docs/unruh-implementation-plan.md)).

A lightweight, self-hosted chat UI for [z.ai](https://api.z.ai) and [NanoGPT](https://nano-gpt.com). Runs entirely on your machine — your API key never leaves `localhost`.

### Requirements

The one-click installer handles every prerequisite on supported platforms (auto-installing via `winget` on Windows or the official one-liner installers elsewhere). Install manually only if you prefer to drive each tool yourself:

- [Node.js](https://nodejs.org/) 18 or newer
- [Deno](https://deno.com/) 2+ (for the entity-core identity layer)
- [uv](https://docs.astral.sh/uv/) (for the Unruh temporal-context module; ships its own Python)
- [Git](https://git-scm.com/) (for cloning entity-core)

### Quick Start (one double-click)

| OS | First-run | Launch | Stop |
|---|---|---|---|
| **Windows** | Double-click `Proto-Familiar.vbs`. The installer auto-installs Node, Deno, Git, and uv via `winget` (no admin needed — `--scope user`); when winget is missing or fails, each tool falls back to its official one-liner or download page. Then runs `npm install`, clones entity-core, syncs Unruh's Python venv, and creates Desktop + Start Menu shortcuts (idempotently — re-running picks up anything missing without overwriting what's there). | Double-click the **Proto-Familiar** Desktop shortcut (or `Proto-Familiar.vbs`). A tray icon appears; the browser opens automatically. Left-click the icon to re-open the browser. | Right-click the tray icon → **Quit**. Cleanly stops Proto-Familiar, entity-core, and Unruh. |
| **macOS** | Double-click `Proto-Familiar.command` in Finder. First run installs dependencies (Deno via the official installer, uv via Astral's one-liner); subsequent runs just start it. | Double-click `Proto-Familiar.command`. Browser opens automatically. The launcher auto-recycles any stale Proto-Familiar holding the port before starting. | Press **Ctrl-C** in the Terminal window, then close it. |
| **Linux** | Run `./install.sh` once. It auto-installs Deno + uv (via the official one-liner installers), runs `npm install`, clones entity-core, syncs Unruh's Python venv, and registers a **Proto-Familiar** entry in your application menu. | Search **Proto-Familiar** in your app launcher, or `./start.sh`. | `./stop.sh` |

Everything runs locally at **http://localhost:8742** — your API key never leaves your machine. Set `PORT=8080` (env var, or `PORT=8080 ./start.sh`) to change the port. Any way you launch — double-click, `./start.sh`, or `npm start` — Proto-Familiar will auto-recycle a stale instance of itself holding the port before binding, and trigger the installer if Node deps or Unruh's venv are missing.

**Access from other devices (Tailscale / LAN):** click the globe icon in the top bar (next to the prompt-inspector magnifier) to toggle external access on. While on, the UI is reachable at the displayed Tailscale hostname / IPv4 (auto-detected from the `tailscale` CLI if installed) from any device on your tailnet. While off (the default), non-loopback requests get a 403 — same effective posture as the historical localhost-only bind. The setting persists in `.proto-familiar-config.json`. Tailscale provides the auth and encryption — on a plain LAN with no Tailscale, anyone on the network can hit the proxy and use your API key, so only flip it on when you actually need cross-device access on a trusted network. See [docs/getting-started.md#access-from-other-devices-tailscale--lan](docs/getting-started.md#access-from-other-devices-tailscale--lan).

**Central settings:** prompts, names, model picks, and saved connections (including API keys) live in `settings.json` on the machine running the server, not in each browser. Opening Proto-Familiar on a second device pulls the same configuration from the server, so you don't have to re-enter anything. Edits sync back on every change; the browser's `localStorage` is just a fast offline cache.

**Updating an existing install:** re-run the same installer. It detects `node_modules/` and switches to update mode. Before any git op runs, `tomes/`, `logs/`, entity-core's `data/` directory, `.proto-familiar-config.json` (Tailscale toggle state), and `settings.json` (central user settings) are copied to `.pf-backups/<timestamp>/` as a safety net. Then `git pull --ff-only` on Proto-Familiar (refuses non-FF merges; your work tree stays put on conflict), `git fetch && checkout <pinned tag>` on entity-core (whose `data/` is gitignored, never touched), idempotent `npm install` + `deno cache` + `uv sync` (the Unruh Python venv). Node / Deno / Git / uv are reinstalled if missing in either mode; shortcut and desktop-entry creation are now idempotent too — re-running picks up anything that's missing without overwriting what's there. See [docs/getting-started.md#updating-an-existing-install](docs/getting-started.md#updating-an-existing-install) for the protection table.

**Manual / advanced:**

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start          # production
npm run dev        # auto-restarts on file changes
```

Open **http://localhost:8742** in your browser.

Open the Settings panel (☰), choose your provider, paste your API key, pick a model, and start chatting.

To run on a different port, set the `PORT` environment variable before starting:

```bash
PORT=8080 npm start
```

### Wiki

Project wiki pages are available in [`/wiki`](wiki/):

- [Home](wiki/Home.md)
- [Getting Started](wiki/Getting-Started.md)
- [Configuration & Features](wiki/Configuration-and-Features.md)
- [Server API](wiki/Server-API.md)
- [Research Guide](wiki/Research-Guide.md)

---

### Features

| Feature | Details |
|---|---|
| **Providers** | NanoGPT (OpenAI-compatible) · Z.ai Standard API · Z.ai Coding Plan |
| **Saved connections** | Multiple named provider/key/model combos in the Connections sidebar. Mark one **Primary**, any others **fallback** (ordered list, tried when primary returns empty), and one **entity-core** — its API key is passed to the entity-core child as `ENTITY_CORE_LLM_API_KEY` so its consolidator can call out for embeddings / weekly summaries. Changing the designation re-spawns entity-core automatically, no restart needed |
| **Entity-core enrichment** | Automatically grounds every request in a local [entity-core](https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2) MCP server. The context is split for prompt-cache efficiency: a **static** block (full identity layer, XML-wrapped) is prepended to the system message, while a **dynamic** block (RAG memories + knowledge-graph excerpt + temporal context) is depth-injected so per-turn churn doesn't invalidate the cached prefix. Depth is the `thalamusDynamicDepth` setting (default 4) |
| **Temporal context (Unruh)** | Sibling Python MCP module (`unruh/`, alpha — see [`docs/unruh-design.md`](docs/unruh-design.md)) that adds a `[Temporal Context]` block with three layers: **schedule** (current phase + upcoming events/tasks), **interests** (standing values that always surface + live interests that accrue weight from chat engagement and decay over days), and **session handoff** (at session end the conversation is summarised into an intent + open threads, surfaced at the top of the next session so the Familiar resumes mid-thought). The handoff summary is opt-out via the **Session handoff** setting |
| **Knowledge editor** | Sidebar **🧠 Open Knowledge editor** modal with four tabs: Memories (browse / edit / delete / supersede by date), Graph (full CRUD on nodes and edges across two view modes — see next row), Identity (per-section editor across self / user / relationship / custom files), Snapshots (one-click restore of any auto- or user-created snapshot). Resizable from the bottom-right corner with the size remembered per-modal; only the ✕ closes it. Every destructive op auto-snapshots entity-core first |
| **Knowledge graph (Map view)** | The Graph tab's **List / Map** toggle switches to a canvas rendering of the entire graph as colored dots and curves. Node hue encodes type (deterministic per-graph palette spread across 24 hues so adjacent type names don't collide); edge hue encodes relationship type, with saturation / lightness / alpha scaled to the edge's weight. Wheel to zoom, drag to pan, hover for a tooltip (hit-tested against the actual Bézier curve), zoom past ~1.4× to see every label. Click a dot to open a draggable popover editor: label / type / description with autocompletion, a weighted edge list with inline ✎ edit and ✕ delete, and an **+ Add edge** form with target-label and relationship-type autocompletion. **+ Node** in the toolbar creates a node inline. Layout preserves positions across reloads so adding an edge doesn't reshuffle the map |
| **Diagnostics report** | Sidebar **🩺 Generate diagnostic report** opens a client-side plain-text snapshot — system info (UA, hardware, network, viewport, timezone), Proto-Familiar state (provider, model, session, counts), a live `/api/health` round-trip, the last sent prompt's provenance, and a bounded ring buffer of recent in-app events (errors, console warnings, send/receive checkpoints, tool executions). Copy or download as `.txt`. Nothing leaves the browser. Common failure modes and their fixes live in [`docs/troubleshooting.md`](docs/troubleshooting.md) |
| **Prompt inspector** | Click the 🔍 button in the top bar after any message to see the complete prompt actually sent to the LLM, color-coded by source — entity-core **static** block (purple) and depth-injected **dynamic** block (teal), each captured live from the response rather than re-derived, plus each lorebook injection by position, base system / character / user profile, post-history prompt, and the conversation history |
| **Streaming** | Server-sent event streaming by default; toggle off for full-response mode |
| **Prompt macros** | `{{user}}` / `{{char}}` insert configured names; `{{elapsedTime}}` is the time between the two most recent user messages in this session (so the LLM can detect when the user returns after a long absence — surfaces once both messages are in saved history); `{{timeSinceLastSession}}` is the gap since the previous session ended. All durations render as `5m`, `2h 14m`, `3d 4h`, etc. |
| **System prompt** | Free-text field or import from `.txt` / `.md` / `.json` |
| **Character profile** | Injected into the system message after the system prompt |
| **User profile** | Injected into the system message after character profile |
| **Post-history prompt** | Appended as a final user turn immediately before each AI response |
| **Tool calling** | LLM can invoke built-in tools (`get_datetime`, `get_session_info`, `save_to_tome`, `save_memory`, `update_identity`) or custom tools you define; multi-round loop up to 5 rounds |
| **Custom tools** | Paste a JSON array of OpenAI-compatible function definitions; executed client-side |
| **Topics** | Track named conversation threads with coloured gutter bars; start/end retroactively by clicking any message; parallel topics supported |
| **Topic summaries** | On topic end, an AI-generated summary is reviewed, edited, and saved to a Tome with auto-suggested keywords |
| **Tomes** | Plug-and-play multi-tome knowledge base — each Tome is an independent file you can enable/disable; the full SillyTavern-compatible World Info engine (keyword injection, 5 injection positions, selective logic, recursion, timed effects, group exclusion) aggregates entries across all enabled Tomes; see [docs/tomes.md](docs/tomes.md). Both the entries list and the per-entry editor are resizable (size remembered per-modal in localStorage); only the ✕ closes them |
| **Message timestamps** | Every message is stamped `HH:MM` (today) or `Mon DD HH:MM` (older) |
| **Session logging** | Conversations saved as JSON files in `logs/` with start + end timestamps |
| **Session browser** | In-app Logs modal to view, load, or delete any past session |
| **Session auto-end** | After 3 hours of inactivity the session is closed and a new one starts automatically |
| **Session memorization** | Sessions are queued for memorization on idle timeout, manual clear, tab close, topic end, or via the **Memorize now** button; a server-side worker calls the LLM, extracts 1–8 distinct topics, and saves each as an entry in the dedicated **Session Memories** Tome. Jobs survive tab close and server restart, with exponential backoff retry on failure |
| **Per-session Memorize** | Each row in the Logs modal has a **Memorize** button that opens a chooser: **Auto-summarize** runs the worker over that session and shows the entry count inline, while **Manual topics** opens the session read-only so you can mark topic ranges by hand and review each entry before saving |
| **Export** | Download conversation as a Markdown `.md` file (tool-call turns are omitted) |
| **Themes** | Dark / light toggle |
| **Responsive layout** | Full sidebar on desktop · Full-screen slide-in panel on mobile |
| **File import** | Load any prompt field from a plain-text, Markdown, or JSON file |

---

### Supported Providers & Models

**NanoGPT** — `https://nano-gpt.com`

Suggested models (type any valid model name in the field):
`gpt-4o`, `gpt-4o-mini`, `chatgpt-4o-latest`, `claude-opus-4-5`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `gemini/gemini-2.5-pro`, `gemini/gemini-2.0-flash`, `deepseek/deepseek-r1`, `deepseek/deepseek-v3`, `meta-llama/llama-3.3-70b-instruct`

**Z.ai — Standard API** — `https://api.z.ai`

Suggested models: `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`, `glm-4.5`, `glm-4.5-air`, `glm-4-flash`, `glm-z1-rumination`

**Z.ai — Coding Plan** — uses a separate quota endpoint (`/api/coding/paas/v4/…`).

Suggested models: `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`, `glm-4.5-air`

All three providers share the same OpenAI-compatible `chat/completions` format; the server selects the correct endpoint based on your provider choice.

---

### Session Logging

Every conversation is a **session**. Sessions are stored as JSON files under `logs/` next to `server.js`. The `logs/` directory is created automatically on first run and is git-ignored.

Each log file is named `<uuid>.json` and contains:

```json
{
  "sessionId":  "...",
  "startedAt":  "2026-05-11T14:30:00.000Z",
  "endedAt":    "2026-05-11T17:12:00.000Z",
  "provider":   "nanogpt",
  "model":      "gpt-4o-mini",
  "updatedAt":  "2026-05-11T17:12:00.000Z",
  "messages": [
    { "role": "user",      "content": "...", "timestamp": "2026-05-11T14:30:05.000Z" },
    { "role": "assistant", "content": "...", "timestamp": "2026-05-11T14:30:07.341Z" }
  ]
}
```

**Session lifecycle:**

1. A new session begins when the app starts (or when you clear history).
2. Each time you send a message, `lastMessage` is updated to the current time and a 3-hour inactivity countdown resets.
3. If 3 hours pass with no new message, the session is stamped with `endedAt` and saved; a fresh session starts automatically, and memorization begins in the background (see below).
4. If you close the tab and reopen it after 3+ hours, the same check runs on startup: the old session is finalised silently and a new one starts.
5. Manually clearing the chat (the **Clear** button) also closes and memorizes the current session before starting a fresh one.

You can browse, load, delete, or **memorize** any past session at any time via the **☰ Logs** button in the Chat section of the sidebar. The per-row **Memorize** button opens a chooser with **Auto-summarize** (run the worker over the whole session and toast the result) and **Manual topics** (open the session in a read-only viewer with topic-mark buttons and review each entry before saving). Both write to the **Session Memories** tome.

#### Session memorization

Memorization is a **server-side queued job** that survives tab close, idle rollover, and server restart. The browser submits a payload to the server, the server-side worker calls the configured LLM, and entries are written to the dedicated **Session Memories** Tome (auto-created on first use). The model is asked to identify distinct topics and return structured JSON shaped by the [tome-writing-guide](docs/tome-writing-guide.md). Each topic becomes a lorebook entry containing:

- A concise **title** (used as the entry comment)
- **Familiar-perspective bullet content** — the Familiar's own first-person notes-to-self: a one-sentence framing line followed by action bullets ("what I will do") and one or two prohibition bullets ("what I will NOT do"), using `{{user}}` where the user's name belongs
- **3–8 conversational trigger keywords** — phrases the user would actually say when this situation recurs, not topic labels
- A suggested **sticky** value sized to how long the situation typically persists

Between 1 and 8 entries are created per memorization job. A brief on-screen toast confirms how many were saved once the job completes (e.g. *"3 lorebook entries memorized from the last session."*); a separate toast surfaces any failure.

**When memorization is enqueued:**

| Trigger | Scope |
|---|---|
| 3-hour idle timeout | The full session that just closed |
| Manual **Clear** button | The full session being cleared |
| **Memorize now** button (Chat sidebar) | The current session, on demand, without ending it |
| Closing the tab mid-session (`beforeunload`) | The current session, delivered via `navigator.sendBeacon` |
| Ending a topic (**□ Topic end**) | Only that topic's message range |
| Logs modal **Memorize → Auto-summarize** on any past session | The full historical session — chooser modal shows live status, entry count on success, or the failure reason |
| Logs modal **Memorize → Manual topics** on any past session | Each topic the user closes in the read-only viewer — one LLM call per topic, reviewed before saving (no worker queue involved) |

**Conditions and limits:**
- Jobs with fewer than 2 readable messages are rejected — too short to be worth summarising.
- If no API key is configured, memorization is skipped.
- The queue is persisted to `tomes/.memorization-queue.json` (git-ignored). It contains the API key on disk; matches the existing local-only posture of `logs/` and `tomes/`.
- Failures retry with exponential backoff (5s → 30s → 2m → 10m → 30m, max 5 attempts) before the job is marked failed and toasted to the user.
- Concurrent jobs writing to the same Tome are serialised by a per-file mutex on the server, so entries are never clobbered.
- Identical jobs (same session, scope, topic, and message range) are deduplicated, so retrying or double-triggering is safe.
- Entries created by memorization are indistinguishable from hand-crafted lorebook entries and can be edited, disabled, or deleted in the Lorebook modal.

---

### Tool Calling

The **Tools** section in the sidebar controls how the LLM interacts with client-side functions.

#### Enabling / disabling

The **Enable tool use** checkbox controls whether the `tools` array is sent with each request. When unchecked, no tools are advertised to the model and it behaves as a plain chat completion.

#### Built-in tools

| Tool | What it does |
|---|---|
| `get_datetime` | Returns the current local date, time, and timezone. |
| `get_session_info` | Returns session start time, message count, provider, model, and ms since last message. |
| `save_to_tome` | Saves a fact learned during the conversation as a new entry in the first enabled Tome, with trigger keywords for future activation. |
| `save_memory` | Writes a new time-stamped entry to entity-core's long-term memory at the chosen granularity (`daily`/`weekly`/`monthly`/`yearly`/`significant`). |
| `update_identity` | Appends a durable fact to one of entity-core's identity files (`user_notes.md` or `relationship_notes.md`). |
| `find_graph_node` | Looks up the underlying graph id for an entity by name (e.g. `"Chen"` → `1747...c4d8`). Used before the editing tools when the entity isn't in the prompt's graph-ids legend. |
| `find_graph_edges` | Lists a node's 1-hop edges with their ids, ready to paste into the edge editing tools. |
| `update_memory` | Overwrites an existing memory entry to correct an inaccuracy. Auto-snapshots first. |
| `delete_memory` | Permanently deletes a memory entry. Use only when fully obsolete; prefer `save_memory` (contradicting newer entry) when the change has historical value. Auto-snapshots first. |
| `rewrite_identity_section` | Replaces one section of an identity file. Stronger than the append-only `update_identity` when an existing section has gone stale. Auto-snapshots first. |
| `update_graph_node` | Renames or re-describes an entity in the knowledge graph. |
| `delete_graph_node` | Deletes a knowledge-graph entity and ALL its edges. For "no longer related" prefer `delete_graph_edge`. Auto-snapshots first. |
| `update_graph_edge` | Changes a relationship's type or weight. |
| `delete_graph_edge` | Removes one relationship between two entities while keeping the entities. Auto-snapshots first. |

All fourteen tools are always available when tool use is enabled. `get_datetime` and `get_session_info` take no arguments; the others accept the parameters described in [`docs/tool-calling.md`](docs/tool-calling.md). The eleven entity-core tools (everything except `get_datetime`, `get_session_info`, and the Tome-writing `save_to_tome`) degrade gracefully if entity-core is unreachable. Each editing tool's description carries first-person guidance on when to append vs. update vs. delete — the model is told to err toward preservation when uncertain, and to supersede stale memories with a newer dated entry rather than deleting outright when the change has historical value. The enriched prompt's graph block ends with a compact id legend so common edits don't need a `find_graph_*` round-trip.

#### Custom tools

Paste a JSON array of [OpenAI function-calling](https://platform.openai.com/docs/guides/function-calling) tool definitions into the **Custom tools** field. The objects must follow the standard `{ type, function: { name, description, parameters } }` shape.

Custom tools are advertised to the LLM like built-in tools, but their execution returns a message saying the tool has no client-side implementation. Use custom definitions to let the model *describe* what it would do, or extend `BUILTIN_EXECUTORS` in `app.js` to wire real logic.

#### How the loop works

1. The request is sent to the provider with the tools array and `tool_choice: 'auto'`.
2. If the response has `finish_reason: 'tool_calls'`, each requested tool is executed locally.
3. A compact collapsible block is rendered in the chat showing the call name, arguments, and result.
4. The assistant message + tool results are appended to the conversation and the request is re-sent.
5. Steps 2–4 repeat up to **5 rounds**. After 5 rounds without a normal response, the last assistant reply is used as-is.

Tool-call turns are stored in the session log but are stripped from chat exports.

---

### Topics

Topics let you tag a slice of conversation with a label and track it with a coloured bar in the message gutter.

- **Start a topic** — click the **+ Topic** button in the input bar, give it a name (or leave blank), and messages from that point forward are grouped under it. Multiple topics can run in parallel.
- **End a topic** — click the **□ Topic end** button that appears on any message while hovering, or click the active topic pill above the input bar. If multiple open topics include that message, a picker appears. The summary review dialog always opens, even with no API key — it drops into a blank manual form with a hint when auto-generation isn't possible.
- **Retroactive start** — click the **▷ Topic start** button on any past message to begin a topic from that point instead of the present.
- **Open topic indicator** — the gutter bar for an open topic extends to the bottom of the message list with a pulsing dot, keeping it visible while it is still active.
- **Auto-summary** — when a topic ends, the LLM is prompted in the style of [docs/tome-writing-guide.md](docs/tome-writing-guide.md): conversational trigger keywords, Familiar-perspective bullet content, and a suggested sticky value. If you named the topic yourself, the label is forwarded to the summarizer as a "focus topic" so the entry centers on that subject and skips tangential threads. You can edit any field and save it to a Tome as a new entry.

---

### Lorebook

The Lorebook is a persistent knowledge base that injects context into the prompt automatically when relevant. It implements a full SillyTavern-compatible World Info engine.

#### Activation

An entry activates when its **primary keys** match in the scan corpus (recent messages + new user input). The number of messages scanned is controlled by **Keyword scan depth** in the Lorebook sidebar section.

Key syntax:
- Plain text — matched as a substring (respecting case/whole-word settings)
- `/pattern/flags` — matched as a JavaScript regular expression

#### Injection positions

| Position | Where the entry's content is inserted |
|---|---|
| ⬆ Top of system message | Before everything else in the system message |
| ↑ Before character profile | Between the system prompt and `[Character Profile]` |
| ↓ After character profile | Between `[Character Profile]` and `[User Profile]` |
| ⬇ Bottom of system message | After all other system message content |
| @ At chat depth | Spliced directly into the conversation history at `depth` messages from the end, as a `system`, `user`, or `assistant` message |

#### Selective logic

Enable **Require secondary key match** on an entry to add a second set of keys that gate activation:

| Mode | Behaviour |
|---|---|
| AND ANY | Primary match + **at least one** secondary key matches |
| NOT ANY | Primary match + **no** secondary key matches |
| AND ALL | Primary match + **all** secondary keys match |
| NOT ALL | Primary match + **at least one** secondary key does not match |

#### Timed effects

- **Sticky N** — once activated, the entry continues injecting for the next N messages even if keywords are no longer present.
- **Cooldown N** — after sticky expires (or after a normal activation ends), the entry is suppressed for N messages before it can trigger again.

#### Recursion

When **Enable recursion** is on, activated entries' content is itself scanned for more keyword matches in up to **Max recursion steps** additional passes. Per-entry controls:

| Flag | Effect |
|---|---|
| Prevent recursion | This entry's content is not added to the recursive scan corpus |
| Delay until recursion | This entry only activates during a recursive pass, not the initial scan |
| Exclude from recursion | This entry is not checked during recursive passes |

#### Group exclusion

Set a **Group name** on multiple entries to make them compete: only the entry with the highest **Weight** (ties broken by lowest insertion order) activates. Use this for mutually exclusive location descriptions, relationship states, etc.

#### Per-entry overrides

Each entry can override the global **Scan depth**, **Case sensitive**, and **Whole-word** settings by setting an explicit value in the entry editor. Leave blank to inherit the global default.

#### Probability

Set **Probability (0–100)** to randomly skip an entry even when its keywords match. 100 (default) means it always activates when triggered.

#### Managing entries

Open **☰ View entries** in the sidebar Lorebook section. Use **+ New** to create a blank entry, **Edit** to open the full editor on any existing entry. Entries created by the topic summary flow start with `before_char` position and the keywords you chose at summary time.

---

### Server API Reference

The Express server runs on `localhost:8742` (or whatever you set `PORT` to) and exposes the following endpoints.

#### `POST /api/chat`
Proxies a chat request to the chosen provider.

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
`temperature`, `max_tokens`, `tools`, and `tool_choice` are all optional. Returns an SSE stream when `stream: true`, otherwise returns the provider's JSON response verbatim. `tools` and `tool_choice` are forwarded to the provider as-is.

#### `POST /api/debug-prompt`
Returns the full enriched message array that would be sent to the LLM for a given conversation, without making any upstream API call. Used by the prompt inspector UI.

**Request body:** `{ "messages": [...] }` — the same messages array that would go to `/api/chat`.

**Response:** `{ "messages": [...] }` — the same array with entity-core enrichment prepended to the system message.

#### `POST /api/log`
Creates or overwrites the log file for a session.

**Request body:**
```json
{
  "sessionId": "<uuid>",
  "startedAt": "<ISO>",
  "endedAt":   "<ISO> | null",
  "provider":  "...",
  "model":     "...",
  "messages":  []
}
```

#### `GET /api/logs`
Returns a JSON array of session metadata (no message bodies), sorted newest-first.

```json
[
  {
    "sessionId":    "...",
    "startedAt":    "...",
    "endedAt":      "... | null",
    "updatedAt":    "...",
    "provider":     "...",
    "model":        "...",
    "messageCount": 12
  }
]
```

#### `GET /api/logs/:id`
Returns the full session JSON for the given UUID.

#### `DELETE /api/logs/:id`
Deletes the session log file. Returns `{ "ok": true }` on success.

#### `GET /api/health`
Returns `{ "ok": true }`. Useful for uptime checks.

#### Tomes — `GET/POST /api/tomes`, `GET/PUT/PATCH/DELETE /api/tomes/:id`, `DELETE /api/tomes/:id/entries/:uid`, `POST /api/tomes/default/entries`, `GET /api/tomes/session-memories`

The lorebook is a multi-Tome system: each Tome is an independent JSON file in `tomes/` that can be enabled/disabled and contains its own entries. The full request/response shapes are documented in [`docs/api-reference.md`](docs/api-reference.md#tomes). The special **Session Memories** Tome is auto-created on first session memorization.

#### Session memorization — `POST/GET /api/memorize`, `POST /api/memorize/:id/ack`, `DELETE /api/memorize/:id`

Queue endpoints for server-side memorization jobs. Full shapes in [`docs/api-reference.md`](docs/api-reference.md#session-memorization).

#### Entity-core — `POST /api/entity/memory`, `POST /api/entity/identity`

Write-through endpoints used by the `save_memory` and `update_identity` built-in tools. Full shapes in [`docs/api-reference.md`](docs/api-reference.md#entity-core).

#### Unruh — `POST /api/interest/engage`, `POST /api/session/handoff`

Feed the temporal-context layer. `/api/interest/engage` records a turn's engagement (open topics + reply length) so interests accrue weight; `/api/session/handoff` stores a session-end intent + open threads for the next session to resume from. Both fire-and-forget, both degrade silently when Unruh is down. The `/api/chat` body also accepts an `enrich` flag (`true` / `"static"` / `false`). Full shapes in [`docs/api-reference.md`](docs/api-reference.md#interest-layer).

---

### Project Layout

```
/
├── server.js                    Express server — chat proxy + log/tome/memorize/entity API (Node.js 18+, ESM)
├── thalamus.js                  entity-core MCP bridge — enriches every LLM request
├── memorization.js              Persistent server-side memorization queue + worker
├── package.json
├── .gitignore
│
├── Proto-Familiar.vbs           Windows tray-icon launcher (one-click entry point)
├── Proto-Familiar.command       macOS double-click launcher
├── install.sh / install.bat     Bash / batch installer (deps + entity-core clone)
├── start.sh / start.bat         Bash / batch launcher (background, opens browser)
├── stop.sh / stop.bat           Bash / batch shutdown
│
├── logs/                        Session JSON files (auto-created, git-ignored)
├── tomes/                       Per-Tome JSON files (memorization queue lives here too, git-ignored)
│
├── scripts/
│   ├── import-entity.js         Import an existing entity-core data directory
│   ├── import-tome.js           Convert a SillyTavern lorebook export to a Proto-Familiar Tome
│   ├── linux/install-desktop-entry.sh   Register Proto-Familiar in the Linux app menu
│   └── win/{install,tray}.ps1   PowerShell installer + tray app (called by the .vbs launcher)
│
├── public/
│   ├── index.html               App shell (sidebar + chat pane + modals)
│   ├── style.css                All styling — dark/light themes, responsive layout
│   └── app.js                   All frontend logic — state, API, rendering, topics, tomes engine
│
├── docs/                        User-facing documentation (index.md is the table of contents)
├── wiki/                        Short GitHub-wiki mirrors of the docs
└── Research/                    Background reading on architecture and mental-health AI
```

---

### Entity-Core Identity Layer

Familiar optionally connects to a local [entity-core](https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2) MCP server to ground every LLM request in persistent identity and memory. This is wired through `thalamus.js`.

#### How it works

On startup, `thalamus.js` spawns entity-core as a child process over stdio using the MCP protocol, with its working directory set to the entity-core project root so it reads the correct `data/` directory. Before each LLM call in `POST /api/chat`, the server calls `enrich(userMessage)`, which fires three MCP tool calls independently (failures in one do not block the others):

| MCP tool | What it fetches |
|---|---|
| `identity_get_all` | All identity files across all four categories: `self/`, `user/`, `relationship/`, `custom/` |
| `memory_search` | Up to 5 memories ranked by semantic similarity to the current user message |
| `graph_node_search` | Up to 10 knowledge graph nodes relevant to the current user message, with 1-hop edge traversal |

The results are assembled and prepended to the system message in the same order Psycheros uses:

```
<base_instructions>…</base_instructions>
---
My self files (from identity/self/ directory):

<my_identity>…</my_identity>
---
<my_persona>…</my_persona>
…
---
User files (from identity/user/ directory):
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
…
---
Relevant Knowledge from Graph:
…
```

Each identity file is wrapped in XML tags named after the file's `promptLabel` (e.g. `<my_identity>`, `<my_persona>`). Files are sorted in the same canonical order entity-core uses internally.

If entity-core is unreachable, `enrich()` logs the problem and returns an empty string — the request proceeds normally without enrichment. Individual tool failures (e.g. graph search unavailable) are also logged and silently skipped without affecting the other sections.

#### Prompt inspector

To see exactly what was sent to the LLM on the previous turn — including the full entity-core block, every lorebook injection, and the conversation history — click the **⊕ magnifying glass** button in the top bar. The inspector renders each segment color-coded by source: the entity-core block (Thalamus) is captured from a `_thalamus` envelope the server attaches to every `/api/chat` response (so it reflects the live enrichment, not a re-derived preview), and the lorebook / system / character / user / post-history segments come from `buildApiMessages`'s recorded provenance. Each segment shows a labelled chip and a left-rule in its source color; per-message Copy buttons stay available for the raw text.

#### Setup

1. Clone [entity-core](https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2) as a sibling directory at the release tag:
   ```bash
   git clone --depth 1 --branch entity-core-v0.2.2 https://github.com/PsycherosAI/Psycheros.git ../entity-core
   ```
2. Follow its README to populate `data/` with identity files and memories.
3. Start Familiar normally — `thalamus.js` spawns entity-core automatically.

To use a non-default path, set `ENTITY_CORE_PATH` to the absolute path of `src/mod.ts` inside your entity-core install before starting the server.

#### Importing an existing entity-core

If you already have an entity-core data directory from another machine or embodiment, you can overwrite the local one with:

```bash
# From an entity-core root (auto-detects the data/ subdirectory)
npm run import-entity -- --from /path/to/entity-core

# From a bare data directory
npm run import-entity -- --from /path/to/entity-core/data

# Skip the confirmation prompt
npm run import-entity -- --from /path/to/entity-core --yes
```

The script resolves the destination using the same logic as `thalamus.js` (`$ENTITY_CORE_PATH` → `../entity-core`). It reads both installs' `.env` files for `ENTITY_CORE_DATA_DIR` overrides, preserves timestamps so recency ranking stays accurate, and stops you if source and destination are the same. **Stop the Familiar server before running this** to avoid write conflicts with the running entity-core process.

#### Importing a SillyTavern lorebook

Convert a SillyTavern lorebook export to a Proto-Familiar Tome with:

```bash
# Auto-detects name from file, writes to tomes/<Name>.json
npm run import-tome -- path/to/lorebook.json

# Override the tome name
npm run import-tome -- path/to/lorebook.json --name "World Lore"

# Write to a specific output path
npm run import-tome -- path/to/lorebook.json --out tomes/my-lore.json
```

The script renames SillyTavern fields to their Proto-Familiar equivalents (`key→keys`, `order→insertion_order`, `disable→enabled`) and wraps the entries in a valid top-level Tome structure. Activate the result via **☰ → Tomes → Manage Tomes**.

---

### Privacy & Security Notes

- **API key security:** The key is sent from the browser to `localhost` only. The server uses it once per request to call the upstream API and never logs or stores it. The key is persisted in `localStorage` in your browser — do not use the app on a shared or untrusted device.
- **Path traversal prevention:** All file-backed endpoints (session logs, Tomes, entity writes) validate IDs against a strict UUID regex before constructing any file path.
- **Rate limiting:** `POST /api/chat` is limited to 20 requests per minute per IP (in-memory, no external dependency) to protect against accidental exposure and runaway tool-call loops.
- **Prompt inspector endpoint:** `POST /api/debug-prompt` returns the full enriched context — entity memories, identity data, and the assembled system message — with no authentication. It is a development tool; do not expose it publicly.
- **Entity-core permissions:** `thalamus.js` spawns entity-core with Deno's `-A` (all-permissions) flag. This is the easiest setup for a local personal tool. If you run the server in a shared or networked environment, consider restricting entity-core to a scoped permission set (e.g. `--allow-read=<data-dir> --allow-write=<data-dir> --allow-env`) once you have verified the minimum your build requires.
- **Local-only by default:** The server binds to all interfaces on the configured port but is not intended to be exposed to the internet without additional authentication.
- **No telemetry:** Nothing is phoned home. The only outbound traffic is the proxied LLM request to the provider you configure.

---

## About the Larger Project

My idea is to create an agentic caretaker for myself. As you can see I am starting by thoroughly researching different frontends and extensions to try and gleam the best building blocks from each. Most of what you read here is strongly a WIP, very early. I am conceptualising in-depth before going forward with even creating a roadmap.

However, I found some stuff potentially helpful for others. So I've made the repo public already. Have at it.

See [`docs/project-vision.md`](docs/project-vision.md) for the full vision and design principles.

---

## Research Index

### 🏗️ Architecture & System Design

**[caretaker-agent-comprehensive-architecture.md](Research/caretaker-agent-comprehensive-architecture.md)**  
Complete implementation guide synthesizing all research. Covers tech stack, database design, message relay architecture, memory management, security, API specs, and deployment. Your go-to blueprint for building the system.

**[multi-user-chat-architecture-patterns.md](Research/multi-user-chat-architecture-patterns.md)**  
Design patterns for multi-user AI systems. Authentication, chat isolation, session management, database schemas, message routing, WebSocket architecture, and horizontal scaling patterns.

**[application-to-caretaker-agent.md](Research/application-to-caretaker-agent.md)**  
Adapts Marinara's 3-tier memory system to caretaker agent needs. Addresses cross-chat communication while maintaining privacy boundaries. Per-chat memory, user profiles, relay mechanisms, and permission controls.

### 🧠 Memory & Context Management

**[context-window-management-strategies.md](Research/context-window-management-strategies.md)**  
Strategies for managing LLM context windows: truncation, summarization, RAG retrieval, hybrid systems, token budgeting, and compression techniques. Solves the "conversation too long" problem.

**[marinara-memory-system.md](Research/marinara-memory-system.md)**  
Technical deep-dive into Marinara Engine's 3-tier memory: semantic memory (RAG with 5-message chunks), character identity persistence, and agent persistent memory (key-value state storage).

**[marinara-lorebook-trigger-architecture.md](Research/marinara-lorebook-trigger-architecture.md)**  
How Marinara dynamically injects contextual information using keyword triggers, semantic similarity, and game state conditions. Recursive scanning, token budgeting, and hook systems.

**[sillytavern-worldinfo-architecture.md](Research/sillytavern-worldinfo-architecture.md)**  
SillyTavern's World Info system: keyword-triggered knowledge injection, scanning algorithms, injection strategies, and generation modes. 5000+ lines of implementation details.

**[sillytavern-memorybooks-extension.md](Research/sillytavern-memorybooks-extension.md)**  
Automated lorebook entry generation using LLMs. Scene management, memory creation workflows, and practical patterns for extracting structured knowledge from conversations.

**[coneja-chibi-continuity-systems-analysis.md](Research/coneja-chibi-continuity-systems-analysis.md)**  
Analysis of 5 interconnected systems (TunnelVision, VectHare, BunnyMo, CarrotKernel, TrackHare) focused on continuity and persistence. "Active retrieval" philosophy: AI consciously retrieves info vs passive injection.

### 🤖 AI Behavior & Safety

**[proactive-inhibition-decision-framework.md](Research/proactive-inhibition-decision-framework.md)**  
**Critical.** Addresses over-cautious AI behavior. Rule hierarchy for when to act vs stay silent. Explicit instructions override everything. Prevents agents from inventing excuses like "we're in a conversation" or "they might be sleeping."

**[intelligent-disobedience-ai-implementation.md](Research/intelligent-disobedience-ai-implementation.md)**  
Framework for when AI should refuse user requests (inspired by service dog training). Decision trees for safety vs therapeutic impact vs ethical boundaries. Response levels from soft redirect to crisis intervention.

**[tool-use-hallucination-prevention.md](Research/tool-use-hallucination-prevention.md)**  
Preventing false claims of actions/tool execution. Verification loops (never claim without tool response), state tracking, error surfacing, capability registries. Essential for crisis intervention and medication reminders.

**[openclaw-baseline-analysis.md](Research/openclaw-baseline-analysis.md)**  
Deep-dive into OpenClaw (366k⭐ personal AI assistant). Heartbeat mechanic (30-60min proactive checks), HEARTBEAT_OK token (spam prevention), active hours gating, prompt engineering patterns, multi-agent architecture, and cost optimization.

### 🏥 Mental Health Support

**[depression-caretaker-ai-implications.md](Research/depression-caretaker-ai-implications.md)**  
Implementation guide for supporting users with depression. Time perception (5-10min increments), task breakdown (micro-tasks), cognitive load reduction, emotional support patterns, crisis recognition (988 hotline), and avoiding toxic positivity.

**[agoraphobia-caretaker-ai-implications.md](Research/agoraphobia-caretaker-ai-implications.md)**  
Supporting exposure therapy for agoraphobia. Exposure hierarchy management (SUDS 0-100 ratings), panic response protocols (5-4-3-2-1 grounding), safety behavior reduction, space/distance conceptualization, habituation curves.

**[adhd-caretaker-ai-implications.md](Research/adhd-caretaker-ai-implications.md)**  
ADHD executive function support. Time blindness compensation, task initiation ("Wall of Awful"), working memory augmentation (AI as external memory), dopamine-aware task design (gamification, novelty), hyperfocus management (break enforcement).

### 🔐 Security & Privacy

**[privacy-security-compliance-patterns.md](Research/privacy-security-compliance-patterns.md)**  
Security best practices for multi-user AI systems. Threat modeling, authentication security, data isolation, encryption (at-rest/in-transit), audit logging, content moderation, rate limiting, GDPR/HIPAA compliance, secure deployment.

### 🎨 Frontend & Integration Research

**[ai-frontend-comparison-matrix.md](Research/ai-frontend-comparison-matrix.md)**  
Comparison of 5 major AI chat frontends (SillyTavern, Marinara, KoboldAI, Open WebUI, TextGen WebUI). Architecture styles, multi-user support, memory systems, API compatibility, streaming support. Feature matrix and lessons learned.

**[marinara-architecture-systems.md](Research/marinara-architecture-systems.md)**  
Marinara Engine's tool use system (10 built-in tools + custom), agent architecture, visual UI/navigation, and Discord webhook integration. Tool-calling loop (max 5 rounds LLM ↔ tool execution).

**[marinara-default-prompts.md](Research/marinara-default-prompts.md)**  
25+ specialized agent prompts from Marinara: world state extraction, music control, scene analysis, quest tracking, writing enhancement. Game mode prompts, Professor Mari assistant, and generation parameters.

**[sillytavern-api-architecture.md](Research/sillytavern-api-architecture.md)**  
SillyTavern's universal adapter architecture. Chat Completions API (OpenAI-compatible) vs Text Completions API. Supports 40+ LLM backends through route-based dispatch and abstraction layers.

---

## Quick Find

**Need to understand the overall system?** → Start with [caretaker-agent-comprehensive-architecture.md](Research/caretaker-agent-comprehensive-architecture.md)

**Building proactive behavior?** → Read [openclaw-baseline-analysis.md](Research/openclaw-baseline-analysis.md) + [proactive-inhibition-decision-framework.md](Research/proactive-inhibition-decision-framework.md)

**Working on memory systems?** → Check [marinara-memory-system.md](Research/marinara-memory-system.md) + [context-window-management-strategies.md](Research/context-window-management-strategies.md)

**Implementing safety features?** → See [intelligent-disobedience-ai-implementation.md](Research/intelligent-disobedience-ai-implementation.md) + [tool-use-hallucination-prevention.md](Research/tool-use-hallucination-prevention.md)

**Supporting mental health conditions?** → Review all three: [depression-caretaker-ai-implications.md](Research/depression-caretaker-ai-implications.md), [agoraphobia-caretaker-ai-implications.md](Research/agoraphobia-caretaker-ai-implications.md), [adhd-caretaker-ai-implications.md](Research/adhd-caretaker-ai-implications.md)

**Security & privacy concerns?** → Read [privacy-security-compliance-patterns.md](Research/privacy-security-compliance-patterns.md) + [multi-user-chat-architecture-patterns.md](Research/multi-user-chat-architecture-patterns.md)

---

## Acknowledgements

Huge thanks to **[zarilewis](https://github.com/zarilewis)** for creating [entity-core](https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2) — the MCP server that powers Familiar's identity and memory layer. entity-core provides the persistent self-model, RAG memory, and knowledge graph that make it possible for Familiar to maintain consistent character values, voice, and relational context across conversations. None of the identity injection work in this project would exist without it.

