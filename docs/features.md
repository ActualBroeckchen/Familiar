# Features

A complete reference for all user-facing features in Proto-Familiar.

---

## Chat Interface

### Sending Messages
Type in the input bar and press **Enter** (or **Send**). Hold **Shift+Enter** for a newline.

### Streaming
Server-sent event (SSE) streaming is enabled by default. Toggle it off in **Settings → Streaming** to receive the full response at once instead.

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

### Saved connections (sidebar)

The **Connections** sidebar section keeps multiple named provider / key / model combos so you can switch without re-typing. Each row has three independent toggles:

| Toggle | Behaviour |
|---|---|
| **Primary** (radio, mutually exclusive) | The connection used for the chat path. Selecting it copies its fields into the active Provider / API Key / Model inputs. |
| **+ fallback** | Adds this connection to the ordered fallback list. When the primary returns an empty response or fails, the client retries in fallback order. Arrows let you reorder. |
| **+ entity-core** (single-select across all rows) | Designates this connection's API key + model for entity-core's background consolidator. Triggers a server-side respawn of the entity-core child with the new env on save — no Proto-Familiar restart needed. See [Entity-Core → API key designation](entity-core.md#api-key-designation). |

The list syncs across devices via `settings.json` along with the rest of your settings (Tailscale-mediated).

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

Click **🧠 Open Knowledge editor** under the "Knowledge (entity-core)" sidebar section to browse and edit the long-term state that thalamus enriches every prompt with. The modal is **resizable** (drag the bottom-right corner; the size is remembered in localStorage) and only the ✕ closes it — clicks outside are ignored so a pan / resize-drag past the edge can't dismiss the window. Four tabs:

- **Memories** — list by granularity, click to view full content, edit-and-save (overwrites in place), delete, or **Supersede with today's date** (writes a new contradicting entry so the recency-decay scoring demotes the stale one while preserving history).
- **Graph** — two view modes via the toolbar's List / Map toggle.
  - **List view** is the classic two-pane node browser: filter by type (the Type input autocompletes from existing types), click a node to see its label / type / description and 1-hop edges in the right pane. Edit and Save the node, or use **+ Node** in the toolbar to create one inline (label / type / optional description).
  - **Map view** renders the entire graph as dots and quadratic curves on a canvas. Node hue encodes type (deterministic per-graph palette with a stride-of-7 across 24 hues so adjacent type names land 105° apart, not in adjacent buckets); edge hue encodes relationship type, and edge saturation / lightness / alpha scale with the edge's weight (`0.0 → 1.0`) so strong relationships read as vivid and weak ones fade. Wheel zooms, drag pans, hover surfaces a tooltip (label + type + description for nodes, endpoints + weight for edges, hit-tested against the actual Bézier curve), and labels for every dot appear past ~1.4× zoom. A legend in the top-right lists every node type and edge type currently on screen.
  - **Inline editor popover.** Clicking a dot opens an editor card anchored next to it — label / type / description with a Type-field datalist, Save / Delete, the node's edges (each with weight `[0.50]`-style display and ✎ inline-edit / ✕ delete buttons), and a **+ Add edge from this node** section with target-label autocomplete (resolved against the live node-label index), relationship-type autocomplete, and a weight slider. The popover is draggable by its header so it can be moved off the dot it covers; the dragged position survives Save re-renders, and resets when a different node is opened.
  - **CRUD parity.** Add, edit, and delete work the same in both views and go through the same `keGraphAttachEdgesUI` handler.
- **Identity** — list every identity file (self / user / relationship / custom). Click one to see its markdown sections; each section has its own textarea and a per-section Save that calls `identity_rewrite_section`. Top-of-file content (before any heading) is read-only — edit the file by hand if you need to change it.
- **Snapshots** — list every entity-core snapshot, restore any one (replaces the current state), or **＋ Create snapshot now**. Auto-snapshots are taken before every destructive op in the other tabs and from every LLM editing tool call, so this tab is the safety net.

Every destructive HTTP call goes through `thalamus.js` wrappers that call `snapshot_create` before the underlying MCP tool, so the user never needs to remember to back up before a delete. Creates (new node, new edge) do not auto-snapshot — they are additive and reversible by deleting.

The Familiar can do the same edits autonomously via the seven editing tools described in [Tool Calling](tool-calling.md). The tool descriptions carry first-person guidance on when to append vs. update vs. delete, plus the recommendation to supersede with a new memory rather than deleting outright when the change has historical value.

---

## Prompt Inspector

Click the **🔍** button in the top bar after sending a message to see the complete prompt that was actually sent to the LLM on the previous turn, color-coded by source:

- **Entity-Core (static)** (purple) — the cacheable identity prefix prepended to the system message
- **Entity-Core (dynamic @ depth)** (teal) — the per-turn block (memories / graph / temporal) depth-injected as its own system message at the cache-friendly position. See [`architecture.md#prompt-cache-aware-assembly`](architecture.md#prompt-cache-aware-assembly) for why these are split
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
