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
| Provider | NanoGPT, Z.ai Standard, Z.ai Coding Plan, or Google AI Studio (Gemini) |
| API Key | Your provider API key (sent to `localhost` only; never logged) |
| Model | Model name — choose from the dropdown or type any valid name |
| Streaming | Enable/disable SSE streaming |
| Temperature | Sampling temperature (0.0–2.0) |
| Max tokens | Maximum response length in tokens |
| Context-cache depth | How many messages from the end of the conversation the dynamic enrichment block (memories / graph / temporal) is injected at (`thalamusDynamicDepth`, default 4). Identity stays at the top so the provider's prefix cache covers it; the dynamic block goes deeper so per-turn churn doesn't invalidate the cache. Smaller = the model sees retrieved context closer to the question; larger = more cache hits on long sessions. |
| Session handoff | When on (`handoffEnabled`, default on), the end of a session runs one short summary call (cheapest connection) so the next session resumes mid-thought via the temporal context. One extra small generation per session boundary — turn off to skip it. See [Temporal context](#temporal-context-unruh). |

### Saved connections (sidebar)

The **Connections** sidebar section keeps multiple named provider / key / model combos so you can switch without re-typing. Each row has three independent toggles:

| Toggle | Behaviour |
|---|---|
| **Primary** (radio, mutually exclusive) | The connection used for the chat path. Selecting it copies its fields into the active Provider / API Key / Model inputs. |
| **+ fallback** | Adds this connection to the ordered fallback list. When the primary returns an empty response or fails, the client retries in fallback order. Arrows let you reorder. |
| **+ Phylactery** (single-select across all rows) | Designates this connection's API key + model for Phylactery's background consolidator. Triggers a server-side respawn of the Phylactery child with the new env on save — no Proto-Familiar restart needed. See [Phylactery → design](phylactery-design.md). |

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
| Web search & read | Opt-in web access (`look_up` + `web_search` + `read_webpage`). `look_up` answers definitions/facts from keyless reference APIs (no scraping); `web_search` finds pages. Works out of the box (built-in keyless search) — off by default, just turn it on. Optionally point it at your own SearXNG. See [Web search setup](websearch-setup.md) |

Built-in tools: `get_datetime`, `get_session_info`, `save_to_tome`, `save_memory`, `update_identity`. The two Phylactery tools (`save_memory`, `update_identity`) degrade gracefully when Phylactery is unreachable. See [Tool Calling](tool-calling.md) for parameter details.

### Web search & read (opt-in)

When enabled (Settings → Tools → **Web search & read**), the Familiar gains three tools: `look_up` answers a definition/fact/overview question from keyless official reference APIs (Wikipedia + the DuckDuckGo Instant Answer API — no scraping, no setup); `web_search` finds pages out on the web; and `read_webpage` opens a result and reads it as clean markdown. It works out of the box with a built-in keyless backend — nothing to install. `read_webpage` is SSRF-guarded (public http/https only — loopback, private, link-local, and cloud-metadata targets are refused), times out on slow hosts, and stamps each read with its source URL and date. A page stays in the conversation for the session; the Familiar keeps anything worth remembering past it via `save_to_tome`. **Finding pages** (`web_search`) works out of the box (a built-in keyless backend) and can be upgraded via **Settings → Web search → Configure search backend**: a proper search **API** (Tavily — no card; Brave; or Google), or a **local engine** the Familiar installs and runs on your machine — **LibreY** (lightest), **4get** (medium), or **SearXNG** (heaviest, broadest). The local engines are fetched + run on first use (Linux/macOS; the PHP ones need no manual PHP install — a static PHP runtime is fetched too). Whatever you pick, a wrong key or a down engine always falls back to the built-in search — you're never left without it. Power users can also point search at their own [SearXNG](https://docs.searxng.org/) — see [Web search setup](websearch-setup.md). Hard-disable web access with `PROTO_FAMILIAR_WEBSEARCH_DISABLED=1`; the managed local engines with `PROTO_FAMILIAR_LOCAL_ENGINE_DISABLED=1`.

---

## Discord presence

The Familiar can join Discord as a bot — answering your DMs with full context, registered Villagers' DMs with only what their category grants, and server channels when @-mentioned. Configure it in Settings → **Discord presence**: paste the **Bot token** (Developer Portal → your app → Bot, with the *Message Content* intent enabled), tick **Enable Discord presence**, and press **⟳ Apply & connect** — it connects immediately, no page reload.

The panel's status line is your single source of truth: **🟢 Connected as …**, **🟡 Starting / reconnecting…**, **⚪ Not running**, or **🔴** with a plain reason when Discord rejects the token (invalid or reset — fix it and press Apply again). A rejected token parks the gateway and says so, rather than retrying silently behind a green light. All Discord conversations land in Session logs, same as web chats. Hard-disable with `PROTO_FAMILIAR_DISCORD_DISABLED=1`. (See [Troubleshooting → Discord presence](troubleshooting.md#discord-presence) if the bot won't come online.)

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

## Knowledge editor (Phylactery)

Click **🧠 Open Knowledge editor** under the "Knowledge (Phylactery)" sidebar section to browse and edit the long-term state that thalamus enriches every prompt with. The modal is **resizable** (drag the bottom-right corner; the size is remembered in localStorage) and only the ✕ closes it — clicks outside are ignored so a pan / resize-drag past the edge can't dismiss the window. Four tabs:

- **Memories** — list by granularity, click to view full content, edit-and-save (overwrites in place), delete, or **Supersede with today's date** (writes a new contradicting entry so the recency-decay scoring demotes the stale one while preserving history).
- **Graph** — two view modes via the toolbar's List / Map toggle.
  - **List view** is the classic two-pane node browser: filter by type (the Type input autocompletes from existing types), click a node to see its label / type / description and 1-hop edges in the right pane. Edit and Save the node, or use **+ Node** in the toolbar to create one inline (label / type / optional description).
  - **Map view** renders the entire graph as dots and quadratic curves on a canvas. Node hue encodes type (deterministic per-graph palette with a stride-of-7 across 24 hues so adjacent type names land 105° apart, not in adjacent buckets); edge hue encodes relationship type, and edge saturation / lightness / alpha scale with the edge's weight (`0.0 → 1.0`) so strong relationships read as vivid and weak ones fade. Wheel zooms, drag pans, hover surfaces a tooltip (label + type + description for nodes, endpoints + weight for edges, hit-tested against the actual Bézier curve), and labels for every dot appear past ~1.4× zoom. A legend in the top-right lists every node type and edge type currently on screen.
  - **Inline editor popover.** Clicking a dot opens an editor card anchored next to it — label / type / description with a Type-field datalist, Save / Delete, the node's edges (each with weight `[0.50]`-style display and ✎ inline-edit / ✕ delete buttons), and a **+ Add edge from this node** section with target-label autocomplete (resolved against the live node-label index), relationship-type autocomplete, and a weight slider. The popover is draggable by its header so it can be moved off the dot it covers; the dragged position survives Save re-renders, and resets when a different node is opened.
  - **CRUD parity.** Add, edit, and delete work the same in both views and go through the same `keGraphAttachEdgesUI` handler.
- **Identity** — list every identity file (self / user / relationship / custom). Click one to see its markdown sections; each section has its own textarea and a per-section Save that calls `identity_rewrite_section`. Top-of-file content (before any heading) is read-only — edit the file by hand if you need to change it.
- **Snapshots** — list every Phylactery snapshot, restore any one (replaces the current state), or **＋ Create snapshot now**. Auto-snapshots are taken before every destructive op in the other tabs and from every LLM editing tool call, so this tab is the safety net.

Every destructive HTTP call goes through `thalamus.js` wrappers that call `snapshot_create` before the underlying MCP tool, so the user never needs to remember to back up before a delete. Creates (new node, new edge) do not auto-snapshot — they are additive and reversible by deleting.

The Familiar can do the same edits autonomously via the seven editing tools described in [Tool Calling](tool-calling.md). The tool descriptions carry first-person guidance on when to append vs. update vs. delete, plus the recommendation to supersede with a new memory rather than deleting outright when the change has historical value.

---

## Temporal context (Unruh)

A sibling Python MCP module (`unruh/`, alpha) adds a `[Temporal Context]` block to the dynamic enrichment — the Familiar's sense of *when* it is and *what's been going on*, distinct from Phylactery's identity/memory layer. It runs as its own child process (`uv run python -m unruh`) and degrades gracefully: if it isn't installed or is down, the block is simply absent. Design rationale lives in [`unruh-design.md`](unruh-design.md); the three layers it surfaces:

### Schedule

Events, tasks, phases, reminders, and states on a timeline. The block shows the **current phase** (e.g. "morning correspondence") plus an upcoming **window** of events/tasks, rendered in your local timezone as natural phrasing ("tomorrow at 10am — Chen's appointment" / "in 30 minutes — take meds") rather than ISO timestamps. Seed a default daily rhythm with `cd unruh && uv run python -m unruh seed-routine`.

**Recurrence.** Events, tasks, reminders, and phases all accept a `payload.recurrence` rule so a single anchor entry repeats on its own rhythm: daily, weekly, monthly, yearly, every N units (`interval`), with an optional cut-off date (`until`). Six presets in the schedule-add form's **Repeats** dropdown cover the common cases; advanced patterns like "last Friday of every month" or "first Monday" work via `bysetpos` + `byweekday` (the Familiar can set these directly from chat through the `recurrence` arg on `schedule_add_*` BUILTIN_TOOLS). Occurrences expand at read-time so adding "weekly cleaning every Sunday" costs the same as a one-time task. Month-clamp handled: Jan 31 monthly recurrences stay at end-of-month rather than overflowing; Feb 29 yearly recurrences drop to Feb 28 in non-leap years.

**Per-occurrence resolution.** Marking "this week's cleaning done" doesn't kill next week — `payload.resolutions = { "YYYY-MM-DD": "done" }` is keyed by local date, the expander filters resolved occurrences, the rest of the series stays alive. The Schedule tab's ✓ done / ✕ cancel buttons auto-detect occurrences (they carry a recurring tag) and route to the per-occurrence endpoint; the Familiar's `schedule_resolve` BUILTIN_TOOL accepts an optional `occurrence_date` for the same purpose.

**Calendar view.** The Schedule tab has a **List / Calendar** view toggle in its toolbar (mirrors the Knowledge Editor's graph List/Map pattern). Calendar view shows a month grid (Monday-start, 6×7 cells); each day cell renders up to 3 events with type-coded colors and a "+N more" footer for overflow. Today's day-number gets a circle highlight; out-of-month days dim. **Click a day** to open the create-schedule form pre-filled to that date at 9am. Recurring events render on their actual occurrence dates with a `↻` prefix; resolved occurrences strike through. Phases stay in the Routine tab so daily-recurring phases don't clutter the grid.

### Time perception

Every reference to a timestamped event in the Familiar's context gets re-rendered through `relative-time.js` at prompt-assembly time, recomputed per turn against `Date.now()`. A memory written yesterday reads as "yesterday" today and "two days ago" tomorrow without anyone re-writing the memory. Schedule items, RAG memories, ponderings, and the session handoff all flow through this same helper, so the Familiar reads "tomorrow at 10am" / "yesterday at 4pm" / "in 30 minutes" / "this morning at 9am" instead of ISO arithmetic.

After all dynamic context and the chat history (and any post-history prompt), server.js appends a final **`[Now]` block** as the very last system message — the freshest values for care reasoning, immediately before the model's response slot:

```
[Now]
Now: 2:30pm on Thursday, June 4.
Before this, my human last sent a message at 2:18pm, which was 12 minutes ago.
```

The line names both the absolute clock time of the prior message AND the elapsed interval, so the Familiar can correlate the two without arithmetic (e.g. "at 4pm, which was a day ago" is unambiguously yesterday's 4pm).

### Interests

Two kinds, both rendered under the temporal block:

- **Standing values** — always-on identity-level orientations (e.g. "caring for the user's wellbeing"). They never decay, so they surface every turn. A standing value can be **anchored to a Phylactery identity fact** (a `value_ref` like `entity-core:self/my_wants.md#Caring for the user` — the `entity-core:` scheme prefix is unchanged from the retired backend); on each turn Thalamus checks the anchor still exists, and if you've since deleted that fact from the Knowledge editor, the standing value is **demoted to a live interest** (kept, but now subject to decay) rather than silently dropped. This is the structural side of the design's "redundancy is intentional" — a standing value stays standing only while the identity fact it mirrors is alive.
- **Live interests** — topics the Familiar engages with accrue **weight** automatically: longer replies and topics the conversation keeps returning to bump it (the signal comes from your open [Topic](topics.md) markers). Weight **decays** when a topic goes untouched (≈5-day half-life), so a passing curiosity fades within a couple of weeks while a sustained interest climbs into "active pursuit". Bookmarks are a supplementary explicit signal.

Interests are read-only from the UI today; they accrue from chat and surface in the prompt. Tuning constants (decay rate, accrual scales) are code-level for now.

#### Idle bookmark surfacing

When you've been quiet for **30 minutes or more**, the next message triggers *idle mode*: `[Temporal Context]` includes a "Bookmarks to revisit" section with up to 3 due bookmarks, and the Familiar is invited to weave one in naturally if the moment fits.

After the response completes, the system checks whether each surfaced bookmark's topic or label was actually mentioned in the reply and records the outcome:

| Outcome | Interval adjustment |
|---|---|
| **Engaged** — topic appeared in the response | `interval × 1.5` (max 168 h / 7 days) |
| **Ignored** — topic did not appear | `interval × 0.75` (min 4 h) |

Three consecutive ignores additionally reduce the topic's interest weight by 0.05, letting neglected bookmarks gradually fade without being deleted.

The default resurface interval is **24 hours**. The **Interests tab** in the Temporal editor shows every bookmark with its outcome badge (Engaged / Ignored / Pending), consecutive-ignore count, last-surfaced time, and current adaptive interval.

### Session handoff

When a session ends (idle auto-end or **Clear history**), the Familiar summarises the conversation into an **intent** ("what I was doing") plus **open threads** ("what's unfinished"), in its own voice, and stores it. The next session's first message surfaces it at the top of `[Temporal Context]`:

```
Last session:
  intent — I was helping you outline the thesis intro; you were stuck on the hook
  open — lead with the anecdote or the statistic?
```

…then marks it consumed so it doesn't repeat. This is one short extra generation per session boundary (cheapest connection, persona-only enrichment so it stays in character without pulling in memories) — turn it off with the **Session handoff** setting. It runs on idle-end and Clear, not on tab-close (an async summary can't complete during page unload), so a tab-closed session simply starts the next one cold.

---

## Prompt Inspector

Click the **🔍** button in the top bar after sending a message to see the complete prompt that was actually sent to the LLM on the previous turn, color-coded by source:

- **Phylactery (static)** (purple) — the cacheable identity prefix prepended to the system message
- **Phylactery (dynamic @ depth)** (teal) — the per-turn block (memories / graph / temporal) depth-injected as its own system message at the cache-friendly position. See [`architecture.md#prompt-cache-aware-assembly`](architecture.md#prompt-cache-aware-assembly) for why these are split
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
