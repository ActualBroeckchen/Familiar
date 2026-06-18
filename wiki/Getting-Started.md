# Getting Started

## One double-click

| OS | Entry point | What happens |
|---|---|---|
| **Windows** | Double-click `Proto-Familiar.vbs` | First run: auto-installs Node/Git/uv via winget, runs `npm install`, sets up Phylactery (Python venv via uv) and the Unruh Python venv, creates Desktop + Start Menu shortcuts. Every run: tray icon appears, browser opens. Right-click the tray icon → **Quit** to stop. |
| **macOS** | Double-click `Proto-Familiar.command` | First run installs, then opens browser. Ctrl-C in the Terminal window stops everything. |
| **Linux** | Run `./install.sh` once, then launch **Proto-Familiar** from your app menu | The installer registers a `.desktop` entry under `~/.local/share/applications/`. Stop with `./stop.sh`. |

Open `http://localhost:8742` in your browser (this happens automatically on launch).

## Requirements

- Node.js 22+
- uv (optional, for the Phylactery identity layer and the Unruh temporal-context module; ships its own Python)
- Git (optional)

On Windows the installer pulls these via `winget --scope user`; on macOS/Linux it installs uv via its official one-liner. The Python layers are optional — Proto-Familiar runs as a plain chat UI without them, just without the identity (Phylactery) and temporal-context (Unruh) layers.

## Manual install

```bash
npm install
npm start
```

For auto-reload during development:

```bash
npm run dev
```

To use a different port:

```bash
PORT=8080 npm start
```

To access the UI from your phone or another device, click the globe icon in the top bar (next to the prompt-inspector magnifier) and flip the **Access from other devices** switch. The popover lists the URLs to open on your tailnet. See [docs/getting-started.md → Access from other devices](../docs/getting-started.md#access-from-other-devices-tailscale--lan) for security caveats.

## First chat checklist

1. Open the Settings panel (`☰`).
2. Select a provider:
   - `NanoGPT`
   - `Z.ai — Standard API`
   - `Z.ai — Coding Plan`
   - `Google AI Studio — Gemini`
3. Paste your API key.
4. Enter a model name.
5. (Optional) tune streaming, temperature, and max tokens.
6. Send a message.

## Local data behavior

- Settings and chat history are persisted in browser `localStorage`.
- Session logs are persisted as JSON files under `logs/` on the local server.
- The launcher writes `.proto-familiar.pid` and `.proto-familiar.log` at the project root (both git-ignored).

## Full instructions

See [docs/getting-started.md](../docs/getting-started.md) for the full guide, including the tray-icon controls, env vars, providers, Phylactery setup, and troubleshooting.
