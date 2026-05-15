# Getting Started

## Requirements

| Requirement | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org/) | 18 or newer | Built-in `fetch` API required |
| [Deno](https://deno.com/) | 2 or newer | Only needed for the entity-core identity layer |

## Installation

```bash
# Clone the repository
git clone https://github.com/ScarletPrinceEury/Proto-Familiar
cd Proto-Familiar

# Install Node dependencies
npm install
```

## Quick Start

```bash
# Start the server (production)
npm start

# Start with auto-restart on file changes (development)
npm run dev
```

Open **http://localhost:3000** in your browser.

## First-time Setup

1. Open the **Settings panel** (☰ icon in the top bar).
2. Select your **Provider** (NanoGPT, Z.ai Standard, or Z.ai Coding Plan).
3. Paste your **API key**.
4. Select or type a **model name**.
5. Start chatting.

## Custom Port

Set the `PORT` environment variable before starting:

```bash
PORT=8080 npm start
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port the server listens on |
| `ENTITY_CORE_PATH` | `../entity-core-alpha/src/mod.ts` | Absolute path to entity-core's `src/mod.ts`. Override if your entity-core install is not in the sibling directory. |

## Providers

### NanoGPT
- **Endpoint:** `https://nano-gpt.com/api/v1/chat/completions`
- **Suggested models:** `gpt-4o`, `gpt-4o-mini`, `chatgpt-4o-latest`, `claude-opus-4-5`, `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`, `gemini/gemini-2.5-pro`, `gemini/gemini-2.0-flash`, `deepseek/deepseek-r1`, `deepseek/deepseek-v3`, `meta-llama/llama-3.3-70b-instruct`

### Z.ai — Standard API
- **Endpoint:** `https://api.z.ai/api/paas/v4/chat/completions`
- **Suggested models:** `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`, `glm-4.5`, `glm-4.5-air`, `glm-4-flash`, `glm-z1-rumination`

### Z.ai — Coding Plan
- **Endpoint:** `https://api.z.ai/api/coding/paas/v4/chat/completions` (separate quota from Standard)
- **Suggested models:** `glm-5.1`, `glm-5`, `glm-5-turbo`, `glm-4.7`, `glm-4.5-air`

All three providers use the OpenAI-compatible `chat/completions` format. The server selects the correct endpoint automatically based on your provider selection.

## Setting Up Entity-Core (Optional)

Entity-core provides persistent identity and memory enrichment for every LLM request. It is optional — the app runs normally without it.

1. Clone [entity-core-alpha](https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2) as a sibling directory:
   ```bash
   git clone https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2 ../entity-core-alpha
   ```
2. Follow the entity-core README to populate its `data/` directory with identity files.
3. Start Proto-Familiar normally — `thalamus.js` will spawn entity-core automatically on startup.

> **Permissions note:** entity-core is launched with `deno run -A --unstable-cron`, granting it all Deno permissions. For a personal local setup this is the simplest approach. If you run Familiar in a shared or networked environment, consider restricting entity-core to a scoped permission set (e.g. `--allow-read=<data-dir> --allow-write=<data-dir> --allow-env`) in `thalamus.js` once you have verified the minimum your build requires.

To import an existing entity-core data directory from another machine:

```bash
# Auto-detect source type (root or bare data dir)
npm run import-entity -- --from /path/to/entity-core

# Skip the confirmation prompt
npm run import-entity -- --from /path/to/entity-core --yes
```

> **Important:** Stop the server before running `import-entity` to avoid write conflicts with the running entity-core process.

See [Entity-Core](entity-core.md) for full details on how enrichment works.
