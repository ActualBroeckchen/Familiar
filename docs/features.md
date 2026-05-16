# Features

A complete reference for all user-facing features in Proto-Familiar.

---

## Chat Interface

### Sending Messages
Type in the input bar and press **Enter** (or **Send**). Hold **Shift+Enter** for a newline.

### Streaming
Server-sent event (SSE) streaming is enabled by default. Toggle it off in **Settings → Streaming** to receive the full response at once instead.

### Regenerate
Re-run the last AI response with the same user message using the **↺ Regenerate** button that appears on the last assistant message.

### Export
Download the current conversation as a Markdown `.md` file via **☰ → Export**. Tool-call turns are omitted from the export.

### Message Timestamps
Every message is stamped with a time label:
- Same day: `HH:MM`
- Earlier: `Mon DD HH:MM`

### Dark / Light Theme
Toggle between dark and light themes using the theme button in the top bar.

---

## Settings Panel

Open with **☰** in the top bar.

### Provider & Model

| Setting | Description |
|---|---|
| Provider | NanoGPT, Z.ai Standard, or Z.ai Coding Plan |
| API Key | Your provider API key (sent to `localhost` only; never logged) |
| Model | Model name — choose from the dropdown or type any valid name |
| Streaming | Enable/disable SSE streaming |
| Temperature | Sampling temperature (0.0–2.0) |
| Max tokens | Maximum response length in tokens |

### Names

| Setting | Description |
|---|---|
| User name | Replaces `{{user}}` in all prompt fields |
| AI name | Replaces `{{char}}` in all prompt fields |

### Prompt Fields

| Field | Where it is injected |
|---|---|
| System prompt | First part of the system message |
| Character profile | Appended to the system message after the system prompt, under `[Character Profile]` |
| User profile | Appended to the system message after the character profile, under `[User Profile]` |
| Post-history prompt | Appended as a final user turn immediately before each AI response |

All prompt fields and Tome entry content support these macros and can be loaded from a `.txt`, `.md`, or `.json` file:

| Macro | Renders |
|---|---|
| `{{user}}` | The configured **User name** |
| `{{char}}` | The configured **AI name** |
| `{{elapsedTime}}` | Time between the **two most recent user messages** in the current session — strictly between two timestamps stored in chat history, no `Date.now()` involved. The value surfaces on the prompt build *after* the user returns, so it correctly conveys "{{user}} just messaged the Familiar again after a long absence" once that absence becomes a gap between two saved messages. Falls back to `no prior user message` when fewer than two user messages exist. Renders as `5m`, `2h 14m`, `3d 4h`, etc. Computed from `state.messages` so it can never cross a session boundary. |
| `{{timeSinceLastSession}}` | Time since the **previous session** ended — same format. Falls back to `no prior session` on a fresh install. Cached on session-boundary events (idle auto-end, Clear, tab close) and refreshed from `/api/logs` on cold start or when loading a different historical session. |

### Tomes Settings

| Setting | Description |
|---|---|
| Keyword scan depth | Number of recent messages scanned for keyword matches (default: 4) |
| Case sensitive | Match entry keys case-sensitively |
| Whole word | Only match at word boundaries |
| Enable recursion | Re-scan activated entries' content for additional keyword matches |
| Max recursion steps | Maximum recursive scan passes (default: 3) |

See [Tomes](tomes.md) for full details.

---

## Tools

See [Tool Calling](tool-calling.md) for the full reference.

| Setting | Description |
|---|---|
| Enable tool use | Whether to send the tools array with each request |
| Custom tools | Paste a JSON array of OpenAI function-calling definitions |

Built-in tools: `get_datetime`, `get_session_info`, `save_to_tome`, `save_memory`, `update_identity`. The two entity-core tools (`save_memory`, `update_identity`) degrade gracefully when entity-core is unreachable. See [Tool Calling](tool-calling.md) for parameter details.

---

## Topics

See [Topics](topics.md) for the full reference.

- **+ Topic** — start a named topic from the current message
- **▷ Topic start** on any past message — start a topic retroactively
- **□ Topic end** on any message — end an open topic at that point; the active topic pill above the input also ends the topic at the latest message
- On topic end, the summary review dialog always opens; an LLM-generated entry (written in the [tome-writing-guide](tome-writing-guide.md) style) is pre-filled when an API key is set, otherwise the dialog drops into a manual form
- User-named topics forward their label to the summarizer as a "focus topic" so the generated entry centers on that subject; auto-named topics (`Topic N`) fall back to the unscoped prompt

---

## Session Management

See [Sessions & Memorization](sessions.md) for the full reference.

| Feature | Description |
|---|---|
| Auto-end | After 3 hours of inactivity the session closes and a new one starts |
| Session memorization | Idle timeout, manual Clear, tab close, topic end, or the **Memorize now** button enqueues a server-side job that extracts 1–8 topics and writes them to the dedicated **Session Memories** Tome — with retry-on-failure |
| Clear | Manual clear closes and enqueues memorization of the current session before starting a fresh one |
| Memorize now | **Chat sidebar** button that enqueues memorization of the current session on demand without ending it |
| Session browser | **☰ → Logs** — view, load, or delete any past session |
| Per-session Memorize | Each row in the Logs modal has a **Memorize** button offering **Auto-summarize** (run the worker over the session and save to **Session Memories**) or **Manual topics** (open the session read-only, mark topic ranges by hand, review each entry) |

---

## Knowledge editor (entity-core)

Click **🧠 Open Knowledge editor** under the "Knowledge (entity-core)" sidebar section to browse and edit the long-term state that thalamus enriches every prompt with. Four tabs:

- **Memories** — list by granularity, click to view full content, edit-and-save (overwrites in place), delete, or **Supersede with today's date** (writes a new contradicting entry so the recency-decay scoring demotes the stale one while preserving history). 
- **Graph** — list nodes optionally filtered by type, click to see the node's edges in a 1-hop subgraph. Rename / re-describe / change type / delete the node, or delete individual edges from the row list.
- **Identity** — list every identity file (self / user / relationship / custom). Click one to see its markdown sections; each section has its own textarea and a per-section Save that calls `identity_rewrite_section`. Top-of-file content (before any heading) is read-only — edit the file by hand if you need to change it.
- **Snapshots** — list every entity-core snapshot, restore any one (replaces the current state), or **＋ Create snapshot now**. Auto-snapshots are taken before every destructive op in the other tabs and from every LLM editing tool call, so this tab is the safety net.

Every destructive HTTP call goes through `thalamus.js` wrappers that call `snapshot_create` before the underlying MCP tool, so the user never needs to remember to back up before a delete.

The Familiar can do the same edits autonomously via the seven editing tools described in [Tool Calling](tool-calling.md). The tool descriptions carry first-person guidance on when to append vs. update vs. delete, plus the recommendation to supersede with a new memory rather than deleting outright when the change has historical value.

---

## Prompt Inspector

Click the **🔍** button in the top bar after sending a message to see the complete prompt that was actually sent to the LLM on the previous turn, color-coded by source:

- **Entity-Core (Thalamus)** — the block server-side `thalamus.enrich()` prepended; captured from the live `/api/chat` response so you see exactly what was injected, not a re-derived preview
- **System prompt**, **Character profile**, **User profile** — the configured base segments
- **Lore — system top / before character / after character / system bottom / injected at depth** — every Tome entry the activation engine matched, grouped by injection position
- **Post-history prompt** — the trailing user instruction (if configured)
- **History turns** — user/assistant/tool messages, role-tinted but uncolored otherwise

Each colored segment shows a chip with its source label and a left rule in the matching color. The legend strip at the top of the inspector lists every source the current view recognises. Each message has a Copy button for the raw text. Per-source attribution comes from `lastBuildSegments` (recorded by `buildApiMessages` at send time) and the `_thalamus` envelope the server emits on every `/api/chat` response. The standalone `POST /api/debug-prompt` endpoint still exists for offline previewing without making an upstream call.

---

## Diagnostics report

Sidebar **🩺 Generate diagnostic report** (under "Diagnostics") opens a plain-text snapshot the user can paste into a bug report or download as a `.txt`. The report bundles:

- **System** — userAgent, platform, language, hardware concurrency, device memory, network connection (effective type / downlink / RTT when available), online status, screen + viewport size, dpr, color scheme, timezone.
- **Proto-Familiar** — provider / model / streaming / tool-enabled settings, current session id and start time, message / topic / tome counts, custom-tools size, last thalamus injection size, localStorage usage estimate.
- **Server probe** — a live `GET /api/health` round-trip with status and timing (catches "server died" symptoms immediately).
- **Last sent prompt summary** — message count, role sequence, system-segment sources, at-depth lore splice count, and thalamus injection size for the previous turn (uses the same provenance the [Prompt Inspector](#prompt-inspector) renders).
- **Recent events** — a bounded ring buffer (cap 200) capturing `window.error`, unhandled rejections, every `console.error` / `console.warn`, plus explicit checkpoints at message send / receive (with elapsed ms) and every built-in tool execution (name + success/fail). Each line is ISO-stamped.

Nothing is sent anywhere — the report is generated client-side. Copy to clipboard or download `proto-familiar-diagnostics-<timestamp>.txt`.

---

## Responsive Layout

| Screen size | Layout |
|---|---|
| Desktop | Fixed sidebar always visible alongside the chat pane |
| Mobile | Full-screen slide-in panel for sidebar; chat pane fills the screen |
