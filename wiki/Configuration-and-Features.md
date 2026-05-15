# Configuration & Features

## Connection

- **Provider:** NanoGPT, Z.ai Standard, or Z.ai Coding Plan
- **API Key:** sent to local server, then proxied upstream
- **Model:** free-form input with provider-based suggestions
- **Streaming:** on/off toggle
- **Temperature:** 0.0–2.0 slider
- **Max Tokens:** numeric limit

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
- Built-in tools:
  - `get_datetime` — current local date/time/timezone
  - `get_session_info` — session start, message count, provider, model
  - `save_to_tome` — save a fact into the first enabled Tome with trigger keywords
  - `save_memory` — write a time-stamped entity-core memory at a chosen granularity
  - `update_identity` — append a fact to an entity-core identity file (`user` or `relationship`)
- Custom tools can be provided as an OpenAI-compatible JSON array.
- Tool-call loop runs up to 5 rounds to avoid infinite recursion.

## Sessions and logs

- Sessions auto-end after 3 hours of inactivity.
- Session logs can be viewed, loaded, or deleted in the in-app Logs modal.
- Logs are stored as JSON under `logs/`.

## Export and chat controls

- Export chat as Markdown (`.md`) from the sidebar.
- Regenerate the last assistant reply.
- Clear history starts a fresh session while preserving existing log files.
