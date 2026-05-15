# Getting Started

## Quickest path: one double-click

Proto-Familiar ships with a one-click installer and launcher for each platform. The installer takes care of Node, Deno, Git, `npm install`, and the entity-core clone; the launcher starts the server, opens your browser, and gives you a single button to shut everything down.

### Windows

1. Clone or download the repo.
2. Double-click **`Proto-Familiar.vbs`**.
3. On first run a console window opens and auto-installs Node 18+, Deno, and Git via `winget install --scope user` (no admin prompt). It then runs `npm install`, clones [entity-core-alpha](https://github.com/PsycherosAI/Psycheros) into the sibling directory, and creates Desktop + Start Menu shortcuts named **Proto-Familiar**.
4. After install, a tray icon appears (bottom-right, you may need to click the `^` to reveal hidden icons) and your browser opens at `http://localhost:3000`.

**Tray icon controls:**

| Action | Result |
|---|---|
| Left-click | Open Proto-Familiar in your browser |
| Right-click → **Open in browser** | Same as above |
| Right-click → **Start / Stop / Restart** | Manage the server |
| Right-click → **View logs** | Open `.proto-familiar.log` in Notepad |
| Right-click → **Open install folder** | Reveal the project in Explorer |
| Right-click → **Quit** | Stop the server (and its entity-core child) and remove the tray icon |

The tray icon's colour reflects state: **green** = running, **yellow** = starting, **red** = stopped.

The tray app is single-instance — double-clicking the shortcut a second time just pops the existing instance forward.

### macOS

1. Clone or download the repo.
2. Double-click **`Proto-Familiar.command`** in Finder.
3. On first run it runs `./install.sh`, which checks Node 18+ and Deno, runs `npm install`, and clones entity-core-alpha. On subsequent runs it skips straight to launching.
4. A Terminal window opens showing server logs; your browser opens automatically at `http://localhost:3000`.

**To shut down**, press **Ctrl-C** in the Terminal window, then close it (Cmd-W). Because `node` runs in the foreground, Ctrl-C cleanly stops both Proto-Familiar and its entity-core child.

> If macOS Gatekeeper warns about an unidentified developer, right-click `Proto-Familiar.command` → **Open** the first time.

### Linux

1. Clone the repo.
2. Run `./install.sh` once. It checks Node and Deno, runs `npm install`, clones entity-core-alpha, and registers a `.desktop` entry under `~/.local/share/applications/` so **Proto-Familiar** appears in your app launcher / activities overview.
3. Launch from the app menu, or run `./start.sh`. Stop with `./stop.sh`.

---

## Requirements

The installer handles these automatically on Windows (via `winget`). Install manually if you're on a platform without an automated path:

| Requirement | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org/) | 18 or newer | Built-in `fetch` API required |
| [Deno](https://deno.com/) | 2 or newer | Only needed for the entity-core identity layer |
| [Git](https://git-scm.com/) | any recent | Only needed for the entity-core clone step |

---

## Manual install (advanced)

If you'd rather not use the one-click launcher:

```bash
git clone https://github.com/ScarletPrinceEury/Proto-Familiar
cd Proto-Familiar
npm install
npm start          # production
npm run dev        # auto-restarts on file changes
```

Open `http://localhost:3000`.

The repo also ships three plain shell scripts you can call directly:

| Script | What it does |
|---|---|
| `./install.sh` | `npm install` + clone entity-core-alpha + register Linux desktop entry |
| `./start.sh` | Start server in the background, write PID file, open browser |
| `./stop.sh` | Kill the PID-file process (and its entity-core child) |

Windows equivalents (`install.bat`, `start.bat`, `stop.bat`) exist for CLI/recovery use, but **the recommended Windows entry point is `Proto-Familiar.vbs`** — it avoids the brief console flash and gives you the tray icon.

---

## First-time setup

1. Open the **Settings panel** (☰ icon in the top bar).
2. Select your **Provider** (NanoGPT, Z.ai Standard, or Z.ai Coding Plan).
3. Paste your **API key**.
4. Select or type a **model name**.
5. Start chatting.

Your API key lives in browser `localStorage` and is sent only to `localhost`.

---

## Custom port

Set `PORT` in the environment before launching:

```bash
PORT=8080 ./start.sh
PORT=8080 npm start
```

On Windows, set the env var in the current shell before double-clicking `Proto-Familiar.vbs`, or `setx PORT 8080` and start a new session.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port the server listens on |
| `ENTITY_CORE_PATH` | `../entity-core-alpha/src/mod.ts` | Absolute path to entity-core's `src/mod.ts`. Override if your entity-core install is not in the sibling directory. |

---

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

---

## Setting up entity-core

The one-click installer clones entity-core-alpha automatically. If you want to do it manually (or import an existing data directory), see [Entity-Core](entity-core.md).

In short: entity-core lives at `../entity-core-alpha` relative to Proto-Familiar, and `thalamus.js` spawns it on startup. If it's missing or fails, enrichment is skipped and Proto-Familiar runs normally.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Windows: tray icon doesn't appear | Click the `^` arrow in the system tray to reveal hidden icons, or check `.proto-familiar.log` / `.proto-familiar.log.err` in the project folder. |
| Windows: `node` not on PATH after install | Close the install window, open a new shell (so PATH refreshes), and double-click `Proto-Familiar.vbs` again. |
| Windows: SmartScreen blocks the `.vbs` | Click **More info → Run anyway**. The script is plain text — feel free to read it first. |
| macOS: "unidentified developer" warning | Right-click `Proto-Familiar.command` → **Open** the first time. |
| Linux: app menu entry missing | Some desktops require a logout/login cycle, or run `update-desktop-database ~/.local/share/applications/`. |
| Port already in use | `PORT=8080 ./start.sh` (or set `PORT` before launching the Windows/macOS app) |
| Server won't stop cleanly | Delete `.proto-familiar.pid` and kill stray `node` / `deno` processes, then relaunch. |
