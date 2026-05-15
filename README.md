# Familiar
I've decided to make this public while I work on it so others can access the research.

---

## Proto-Familiar — Chat Frontend

A lightweight, self-hosted chat UI for [z.ai](https://api.z.ai) and [NanoGPT](https://nano-gpt.com). Runs entirely on your machine — your API key never leaves `localhost`.

### Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- [Deno](https://deno.com/) 2+ (only required if using the entity-core identity layer)

### Quick Start (one double-click)

| OS | First-run | Launch | Stop |
|---|---|---|---|
| **Windows** | Double-click `Proto-Familiar.vbs`. It auto-installs Node, Deno, and Git via `winget` (no admin needed — `--scope user`), runs `npm install`, clones entity-core, and creates Desktop + Start Menu shortcuts. | Double-click the **Proto-Familiar** Desktop shortcut (or `Proto-Familiar.vbs`). A tray icon appears; the browser opens automatically. Left-click the icon to re-open the browser. | Right-click the tray icon → **Quit**. Cleanly stops both Proto-Familiar and entity-core. |
| **macOS** | Double-click `Proto-Familiar.command` in Finder. First run installs dependencies; subsequent runs just start it. | Double-click `Proto-Familiar.command`. Browser opens automatically. | Press **Ctrl-C** in the Terminal window, then close the window. |
| **Linux** | Run `./install.sh` once. It installs Node deps, clones entity-core, and registers a **Proto-Familiar** entry in your application menu. | Search **Proto-Familiar** in your app launcher, or `./start.sh`. | `./stop.sh` |

Everything runs locally at **http://localhost:3000** — your API key never leaves your machine. Set `PORT=8080` (env var, or `PORT=8080 ./start.sh`) to change the port.

**Manual / advanced:**

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start          # production
npm run dev        # auto-restarts on file changes
```

Open **http://localhost:3000** in your browser.

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
| **Entity-core enrichment** | Automatically prepends the full identity layer (all four identity categories, XML-wrapped) + RAG memories + knowledge graph context to every system prompt via a local [entity-core](https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2) MCP server |
| **Prompt inspector** | Click the 🔍 button in the top bar after any message to see the complete prompt sent to the LLM — including entity-core identity, Tome injections, and memory context |
| **Streaming** | Server-sent event streaming by default; toggle off for full-response mode |
| **Name variables** | Set a User name and AI name in the sidebar; use `{{user}}` and `{{char}}` anywhere in prompts |
| **System prompt** | Free-text field or import from `.txt` / `.md` / `.json` |
| **Character profile** | Injected into the system message after the system prompt |
| **User profile** | Injected into the system message after character profile |
| **Post-history prompt** | Appended as a final user turn immediately before each AI response |
| **Tool calling** | LLM can invoke built-in tools (`get_datetime`, `get_session_info`) or custom tools you define; multi-round loop up to 5 rounds |
| **Custom tools** | Paste a JSON array of OpenAI-compatible function definitions; executed client-side |
| **Topics** | Track named conversation threads with coloured gutter bars; start/end retroactively by clicking any message; parallel topics supported |
| **Topic summaries** | On topic end, an AI-generated summary is reviewed, edited, and saved to a Tome with auto-suggested keywords |
| **Tomes** | Plug-and-play multi-tome knowledge base — each Tome is an independent file you can enable/disable; the full SillyTavern-compatible World Info engine (keyword injection, 5 injection positions, selective logic, recursion, timed effects, group exclusion) aggregates entries across all enabled Tomes; see [docs/tomes.md](docs/tomes.md) |
| **Message timestamps** | Every message is stamped `HH:MM` (today) or `Mon DD HH:MM` (older) |
| **Session logging** | Conversations saved as JSON files in `logs/` with start + end timestamps |
| **Session browser** | In-app Logs modal to view, load, or delete any past session |
| **Session auto-end** | After 3 hours of inactivity the session is closed and a new one starts automatically |
| **Session memorization** | On every session close (idle timeout or manual clear), the LLM automatically extracts 1–8 distinct topics and saves each as a Tome entry with keywords; a toast confirms the count |
| **Export** | Download conversation as a Markdown `.md` file (tool-call turns are omitted) |
| **Regenerate** | Re-run the last AI response with the same user message |
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

You can browse, load, or delete sessions at any time via the **☰ Logs** button in the Chat section of the sidebar.

#### Session memorization

When a session closes — either by the 3-hour idle timeout or by manually clearing the chat — the full conversation is automatically sent to the configured LLM. The model is asked to identify the distinct topics discussed and return structured JSON shaped by the [tome-writing-guide](docs/tome-writing-guide.md). Each topic becomes a lorebook entry containing:

- A concise **title** (used as the entry comment)
- **Familiar-perspective bullet content** — a one-sentence framing line followed by action bullets and one or two prohibition bullets, written in second person and using `{{user}}` where the user's name belongs
- **3–8 conversational trigger keywords** — phrases the user would actually say when this situation recurs, not topic labels
- A suggested **sticky** value sized to how long the situation typically persists

Between 1 and 8 entries are created per session. A brief on-screen toast confirms how many were saved (e.g. *"3 lorebook entries memorized from the last session."*).

**Conditions and limits:**
- Sessions with fewer than 4 readable messages are skipped — too short to be worth summarising.
- If no API key is configured, memorization is silently skipped.
- The call runs entirely in the background after the new session has already started, so it never blocks the UI.
- Entries are fetched fresh from the server before writing to avoid overwriting any changes made in the new session.
- Entries created this way are indistinguishable from hand-crafted lorebook entries and can be edited, disabled, or deleted in the Lorebook modal.

---

### Tool Calling

The **Tools** section in the sidebar controls how the LLM interacts with client-side functions.

#### Enabling / disabling

The **Enable tool use** checkbox controls whether the `tools` array is sent with each request. When unchecked, no tools are advertised to the model and it behaves as a plain chat completion.

#### Built-in tools

| Tool | What it returns |
|---|---|
| `get_datetime` | Current local date, time, and timezone |
| `get_session_info` | Session start time, message count, provider, model, and ms since last message |

Both tools are always available when tool use is enabled — they require no arguments.

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
- **End a topic** — click the **□ Topic end** button that appears on any message while hovering. If multiple open topics include that message, a picker appears.
- **Retroactive start** — click the **▷ Topic start** button on any past message to begin a topic from that point instead of the present.
- **Open topic indicator** — the gutter bar for an open topic extends to the bottom of the message list with a pulsing dot, keeping it visible while it is still active.
- **Auto-summary** — when a topic ends, the LLM is prompted in the style of [docs/tome-writing-guide.md](docs/tome-writing-guide.md): conversational trigger keywords, Familiar-perspective bullet content, and a suggested sticky value. You can edit any field and save it to a Tome as a new entry.

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

The Express server runs on `localhost:3000` and exposes the following endpoints.

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

#### `GET /api/lorebook`
Returns the full lorebook JSON `{ entries: { [uid]: entry } }`. Returns `{ entries: {} }` if no lorebook file exists yet.

#### `PUT /api/lorebook`
Replaces the entire lorebook with the body supplied. The body must be `{ entries: { ... } }`.

#### `DELETE /api/lorebook/:uid`
Removes a single entry by UID and rewrites the lorebook file. Returns `{ ok: true }`.

The lorebook is stored as `lorebook.json` in the project root (next to `server.js`), automatically created on first save, and git-ignored.

---

### Project Layout

```
/
├── server.js          Express proxy + log/lorebook API (Node.js 18+, ESM)
├── thalamus.js        entity-core MCP bridge — enriches every LLM request
├── package.json
├── .gitignore
├── logs/              Session JSON files (auto-created, git-ignored)
├── lorebook.json      Lorebook entries (auto-created, git-ignored)
├── scripts/
│   ├── import-entity.js  Import an existing entity-core data directory
│   └── import-tome.js    Convert a SillyTavern lorebook export to a Proto-Familiar Tome
├── public/
│   ├── index.html     App shell (sidebar + chat pane + modals)
│   ├── style.css      All styling — dark/light themes, responsive layout
│   └── app.js         All frontend logic — state, API, rendering, topics, lorebook
└── Research/          Background reading on architecture and mental-health AI
```

---

### Entity-Core Identity Layer

Familiar optionally connects to a local [entity-core-alpha](https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2) MCP server to ground every LLM request in persistent identity and memory. This is wired through `thalamus.js`.

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

To see exactly what was sent to the LLM on any given message — including the full entity-core block, all lorebook injections, and the conversation history — click the **⊕ magnifying glass** button in the top bar. The inspector fetches the enriched prompt from the server and displays each message in a colour-coded, collapsible panel with per-message Copy buttons.

#### Setup

1. Clone [entity-core-alpha](https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2) as a sibling directory:
   ```bash
   git clone https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2 ../entity-core-alpha
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

The script resolves the destination using the same logic as `thalamus.js` (`$ENTITY_CORE_PATH` → `../entity-core-alpha`). It reads both installs' `.env` files for `ENTITY_CORE_DATA_DIR` overrides, preserves timestamps so recency ranking stays accurate, and stops you if source and destination are the same. **Stop the Familiar server before running this** to avoid write conflicts with the running entity-core process.

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

See [`DEVELOPMENT_ROADMAP.md`](DEVELOPMENT_ROADMAP.md) for the full vision and phased plan.

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

Huge thanks to **[zarilewis](https://github.com/zarilewis)** for creating [entity-core-alpha](https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2) — the MCP server that powers Familiar's identity and memory layer. entity-core provides the persistent self-model, RAG memory, and knowledge graph that make it possible for Familiar to maintain consistent character values, voice, and relational context across conversations. None of the identity injection work in this project would exist without it.

