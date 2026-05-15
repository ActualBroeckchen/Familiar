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
- **□ Topic end** on any message — end an open topic at that point
- On topic end, an LLM-generated entry (written in the [tome-writing-guide](tome-writing-guide.md) style) is reviewed and optionally saved to a Tome

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

## Prompt Inspector

Click the **🔍** button in the top bar after any message to see the complete prompt that was sent to the LLM, including:
- The full entity-core identity, memory, and knowledge-graph block
- All active Tome injections at every position
- The assembled conversation history

Messages are shown in colour-coded, collapsible panels with per-message Copy buttons. Uses `POST /api/debug-prompt` — no upstream LLM call is made.

---

## Responsive Layout

| Screen size | Layout |
|---|---|
| Desktop | Fixed sidebar always visible alongside the chat pane |
| Mobile | Full-screen slide-in panel for sidebar; chat pane fills the screen |
