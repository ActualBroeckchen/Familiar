# Configuration & Features

## Connection

- **Provider:** NanoGPT, Z.ai Standard, or Z.ai Coding Plan
- **API Key:** sent to local server, then proxied upstream
- **Model:** free-form input with provider-based suggestions
- **Streaming:** on/off toggle
- **Temperature:** 0.0–2.0 slider
- **Max Tokens:** numeric limit
- **Context-cache depth:** how deep the dynamic enrichment block is injected (`thalamusDynamicDepth`, default 4) — keeps the cacheable identity prefix stable
- **Session handoff:** opt-out toggle for the end-of-session summary that lets the next session resume mid-thought (`handoffEnabled`, default on)

Saved connections (named provider/key/model combos with primary / fallback / Phylactery designations) also live in the sidebar — see [docs/features.md](../docs/features.md#saved-connections-sidebar).

## Prompt layering

The app builds context from:

1. System Prompt
2. Character Profile
3. User Profile
4. Conversation history
5. Post-History Prompt (final user instruction before generation)

All prompt fields support file import from `.txt`, `.md`, or `.json`.

## Tool calling

- Enable/disable tool use globally.
- 24 built-in tools across a few groups:
  - **Context:** `get_datetime`, `get_session_info`
  - **Tomes:** `save_to_tome`
  - **Phylactery memory:** `save_memory`, `update_memory`, `delete_memory`
  - **Phylactery identity:** `update_identity`, `rewrite_identity_section`
  - **Phylactery graph:** `find_graph_node`, `find_graph_edges`, `update_graph_node`, `delete_graph_node`, `update_graph_edge`, `delete_graph_edge`
  - **Temporal (schedule):** `schedule_add_event`, `schedule_add_task`, `schedule_add_reminder`, `schedule_add_phase`, `schedule_resolve` — all accept a `recurrence` param so the Familiar can set "weekly Sunday cleaning" or "last Friday of every month" from chat; `schedule_resolve` accepts an optional `occurrence_date` to resolve one instance of a recurring node without killing the series
  - **Temporal (interests):** `interest_bump`, `interest_set_standing`
  - **Care / crisis:** `get_trusted_contacts`, `contact_trusted_person`, `show_crisis_resources`
- Custom tools can be provided as an OpenAI-compatible JSON array.
- Tool-call loop runs up to 5 rounds to avoid infinite recursion.

See [docs/tool-calling.md](../docs/tool-calling.md) for each tool's parameters and the first-person usage guidance baked into the descriptions.

## Temporal context (Unruh)

The optional Unruh module adds a `[Temporal Context]` block: a schedule (with recurrence — daily / weekly / monthly / yearly / "last Friday of every month" / etc. — and per-occurrence resolution), weighted/decaying interests + always-on standing values, and session-to-session intent handoff. The Schedule tab in the Temporal editor has a **List / Calendar** view toggle; calendar view is a click-to-create month grid. A `[Now]` block at the tail of every prompt anchors the Familiar in current wall-clock time + how long since the last user message. Full detail in [docs/features.md → Temporal context](../docs/features.md#temporal-context-unruh).

## Sessions and logs

- Sessions auto-end after 3 hours of inactivity.
- On session end, a memorization job is enqueued and (if Unruh is present and **Session handoff** is on) a handoff summary is generated for the next session.
- Session logs can be viewed, loaded, or deleted in the in-app Logs modal.
- Logs are stored as JSON under `logs/`.

## Export and chat controls

- Export chat as Markdown (`.md`) from the sidebar.
- Clear history starts a fresh session while preserving existing log files.
