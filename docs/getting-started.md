# Getting Started

## Quickest path: one double-click

Proto-Familiar ships with a one-click installer and launcher for each platform. The installer takes care of Node, Git, uv, `npm install`, and the in-tree Phylactery + Unruh Python venvs (via `uv sync`); the launcher starts the server, opens your browser, and gives you a single button to shut everything down. Re-running the installer is safe and idempotent — shortcuts and desktop entries are only created when they don't already exist.

### Windows

**Recommended install location:** `%LOCALAPPDATA%\Proto-Familiar` (typically `C:\Users\<you>\AppData\Local\Proto-Familiar`). It's outside OneDrive's sync scope, well under Windows' 260-char path limit, and writable without admin. **Avoid `Documents\` and `Desktop\`** — Win11 backs both up to OneDrive by default, which locks files during `npm install` and is the single most common cause of failed Windows installs we see. (If you've already extracted under OneDrive, the installer detects this and offers to relocate for you on first run — but going straight to the right place is one less step.)

1. Clone (or download and extract) the repo into `%LOCALAPPDATA%\Proto-Familiar`. Easiest in PowerShell:

   ```powershell
   git clone https://github.com/ScarletPrinceEury/Proto-Familiar.git "$env:LOCALAPPDATA\Proto-Familiar"
   ```

   If you don't have `git` yet, download the ZIP from GitHub, extract it, and move the resulting `Proto-Familiar` folder to `%LOCALAPPDATA%`.

2. Double-click **`Proto-Familiar.vbs`** inside that folder.
3. On first run a console window opens and auto-installs Node 18+, Git, and uv via `winget install --scope user` (no admin prompt). If winget is unavailable or a specific install fails, each tool has a fallback path: uv via its official PowerShell one-liner, Node + Git via opening the download page and waiting for you to confirm. Once prereqs are in place, the installer runs `npm install`, sets up the in-tree Phylactery + Unruh Python venvs via `uv sync` (from each module's `uv.lock`), and creates Desktop + Start Menu shortcuts named **Proto-Familiar**.
4. After install, a tray icon appears (bottom-right, you may need to click the `^` to reveal hidden icons) and your browser opens at `http://localhost:8742`.

If anything goes sideways, every install run appends to `.proto-familiar-install.log` in the project root — open that file first; the failing step is usually named explicitly. The installer also pops a Windows MessageBox at the end with the outcome and the log path, so a closed console doesn't mean lost diagnostics.

**Tray icon controls:**

| Action | Result |
|---|---|
| Left-click | Open Proto-Familiar in your browser |
| Right-click → **Open in browser** | Same as above |
| Right-click → **Start / Stop / Restart** | Manage the server |
| Right-click → **View logs** | Open `.proto-familiar.log` in Notepad |
| Right-click → **Open install folder** | Reveal the project in Explorer |
| Right-click → **Quit** | Stop the server (and its Phylactery + Unruh children) and remove the tray icon |

The tray icon's colour reflects state: **green** = running, **yellow** = starting, **red** = stopped.

The tray app is single-instance — double-clicking the shortcut a second time just pops the existing instance forward.

### macOS

1. Clone or download the repo.
2. Double-click **`Proto-Familiar.command`** in Finder.
3. On first run it runs `./install.sh`, which checks Node 18+, auto-installs uv via its official one-liner installer if missing, runs `npm install`, and sets up the in-tree Phylactery + Unruh Python venvs via `uv sync`. On subsequent runs it skips straight to launching.
4. A Terminal window opens showing server logs; your browser opens automatically at `http://localhost:8742`. The launcher auto-recycles any stale Proto-Familiar holding the port before binding.

**To shut down**, press **Ctrl-C** in the Terminal window, then close it (Cmd-W). Because `node` runs in the foreground, Ctrl-C cleanly stops Proto-Familiar, Phylactery, and Unruh.

> If macOS Gatekeeper warns about an unidentified developer, right-click `Proto-Familiar.command` → **Open** the first time.

### Linux

1. Clone the repo.
2. Run `./install.sh` once. It checks Node, auto-installs uv via its official one-liner installer (`curl … | sh`) if missing, runs `npm install`, sets up the in-tree Phylactery + Unruh Python venvs via `uv sync`, and registers a `.desktop` entry under `~/.local/share/applications/` so **Proto-Familiar** appears in your app launcher / activities overview. Re-runnable — the desktop entry is created only if it doesn't already exist.
3. Launch from the app menu, or run `./start.sh`. Stop with `./stop.sh`.

---

## Requirements

The installer handles these automatically on every platform. Install manually only if you prefer to drive each tool yourself:

| Requirement | Version | Notes |
|---|---|---|
| [Node.js](https://nodejs.org/) | 18 or newer | Built-in `fetch` API required |
| [uv](https://docs.astral.sh/uv/) | 0.4 or newer | For the in-tree Phylactery identity layer and the Unruh temporal-context module; ships its own Python ≥ 3.11, so no system Python install needed |
| [Git](https://git-scm.com/) | any recent | For cloning and updating the repo |

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

Open `http://localhost:8742`.

The repo also ships three plain shell scripts you can call directly:

| Script | What it does |
|---|---|
| `./install.sh` | First run: auto-installs uv, runs `npm install`, and sets up the in-tree Phylactery + Unruh Python venvs via `uv sync` (from each module's `uv.lock`), then registers the Linux desktop entry. Subsequent runs auto-detect the existing install (presence of `node_modules/`) and switch to **update mode**: `git pull --ff-only` on Proto-Familiar, re-run idempotent `npm install` + `uv sync`. Prereq installs and shortcut / desktop-entry creation now run in both modes (idempotent — they skip when the target already exists). |
| `./start.sh` | Detect and recycle any stale Proto-Familiar holding the port, trigger the installer if `node_modules/` or the Python venvs are missing, prime PATH for uv, then start the server in the background, write the PID file, and open the browser. |
| `./stop.sh` | Kill every `node server.js` rooted at this dir (covers the tracked PID and any strays). Phylactery and Unruh die with the parent. |

Windows equivalents (`install.bat`, `start.bat`, `stop.bat`, and the PowerShell installer under `scripts/win/install.ps1`) behave identically — `install.bat` detects `node_modules\` and routes to update mode the same way, auto-installs prereqs via winget (with a PowerShell-installer fallback for uv when winget is missing), and creates Desktop + Start Menu shortcuts idempotently. The recommended Windows entry point is `Proto-Familiar.vbs` — it avoids the brief console flash and gives you the tray icon, and re-runs the installer whenever `node_modules\` or the Python venvs are missing.

`npm start` and `npm run dev` are also valid entry points. They run two prestart hooks (`scripts/ensure-unruh-deps.mjs` and `scripts/ensure-port-free.mjs`) that sync the Unruh venv and recycle any stale Proto-Familiar before binding, so launching this way has the same auto-recovery behaviour as the launcher scripts.

---

## First-time setup

1. Open the **Settings panel** (☰ icon in the top bar).
2. Select your **Provider** (NanoGPT, Z.ai Standard, Z.ai Coding Plan, or Google AI Studio).
3. Paste your **API key**.
4. Select or type a **model name**.
5. Start chatting.

Your API key lives in `settings.json` server-side (and is mirrored to browser `localStorage` as an offline cache) and is sent only to `localhost`.

### Designating a connection for Phylactery

Phylactery's background consolidator (weekly / monthly / yearly memory summaries) needs an LLM API key of its own. Tell it which to use:

1. In the sidebar, open the **Connections** section.
2. Save one or more connections via **+ Save current as connection** (any provider works — `nanogpt`, `zai`, `zai-coding`, or `google`).
3. Click **+ Phylactery** on the connection whose key + model Phylactery should use. The badge **Phylactery** appears next to the connection's name. Click again on the same row to clear, or on a different row to move the designation.

When the designation changes, server.js detects it on the next `PUT /api/settings` and respawns the Phylactery child process with the new env (`PHYLACTERY_LLM_API_KEY`, `PHYLACTERY_LLM_BASE_URL`, `PHYLACTERY_LLM_MODEL`, `PHYLACTERY_LLM_PROVIDER`; the legacy `ENTITY_CORE_LLM_*` aliases are still set too for backward compatibility, plus `ZAI_API_KEY` / `ZAI_BASE_URL` / `ZAI_MODEL` for z.ai providers). No server restart needed — the new key takes effect on the next chat or scheduled consolidation.

Independent of the chat path: the connection you designate as Phylactery's source doesn't have to be your primary or any fallback. You can point Phylactery at any connection regardless of how chat traffic uses it.

---

## Updating an existing install

**If you installed by `git clone`:** re-run the same installer you used for the first install:

- **Windows:** double-click `Proto-Familiar.vbs` (the launcher re-runs the installer if needed) or run `install.bat` directly.
- **macOS:** double-click `Proto-Familiar.command`, or `./install.sh` from a terminal.
- **Linux:** `./install.sh`.

**If you installed by downloading the ZIP** (folder named `Proto-Familiar-main`, no `.git` inside): the installer can't `git pull`, so use the **one-click updater** instead — double-click **`update.bat`** (Windows) / **`update.command`** (macOS) or run **`./update.sh`** (Linux). It downloads the latest version from GitHub, lays it over your folder (your settings, memories, tomes, logs, and Phylactery data are preserved — they aren't in the download), and then runs the installer for dependencies + migrations. No git knowledge required. The installer also tells you which path you're on — it prints `Branch:` (or "not a git checkout") and `Version:` when it finishes.

The installer detects the existing install via the `node_modules/` directory and switches to **update mode**. The flow:

1. **Defensive backup** — `tomes/`, `logs/`, Phylactery's `data/` directory (if non-empty), `.proto-familiar-config.json` (Tailscale toggle state), and `settings.json` (central user settings) are copied to `.pf-backups/<UTC-timestamp>/` inside the project root *before* any git operation runs. Safety net even though the git ops below are designed not to touch user data.
2. **`git pull --ff-only`** on the Proto-Familiar repo. Skipped if the directory isn't a git checkout. The `--ff-only` flag means git refuses any non-fast-forward merge — if you're on a non-default branch, have local commits, or have uncommitted changes that would conflict, the pull aborts with a warning and the work tree is left exactly as you had it.
3. **Node / Git / uv checks**, with auto-install of anything missing (same as fresh install — your environment catches up if a new release added a requirement).
4. **`npm install`** to pick up any new Node deps.
5. **`uv sync`** on the in-tree Phylactery and Unruh modules to pick up any new Python deps (only fetches what's missing). Their runtime `data/` directories are gitignored, so this never touches your identity files, memories, or stored state.

Update mode skips only the shortcut / desktop-entry creation, since those are already in place.

**What's protected:**

| Data | Where it lives | Protected by |
|---|---|---|
| User-saved tomes (`<uuid>.json`) | `tomes/` | Untracked filenames; git never touches them. Also copied into `.pf-backups/` |
| Built-in tome content you edited | `tomes/ADHD-Tome.json`, etc. | If upstream changed the same file, `git pull --ff-only` refuses the merge and warns. Also copied into `.pf-backups/` |
| Session logs | `logs/` | Gitignored. Also copied into `.pf-backups/` |
| Phylactery identity files, memories, knowledge graph, trackers | `phylactery/data/` (in-tree) | Gitignored; never touched by `git pull`. Also copied into `.pf-backups/` |
| Tailscale toggle state | `.proto-familiar-config.json` | Gitignored. Also copied into `.pf-backups/` |
| Central user settings (prompts, names, saved connections incl. API keys, tomes settings) | `settings.json` | Gitignored. Also copied into `.pf-backups/` |

If you ever need to roll back, the contents of `.pf-backups/<timestamp>/` mirror the project tree — copy any subtree back over the live one. Old backups can be removed by hand; nothing prunes them automatically.

---

## Custom port

Set `PORT` in the environment before launching:

```bash
PORT=8080 ./start.sh
PORT=8080 npm start
```

On Windows, set the env var in the current shell before double-clicking `Proto-Familiar.vbs`, or `setx PORT 8080` and start a new session.

## Access from other devices (Tailscale / LAN)

By default Proto-Familiar is reachable only from the machine it's running on. To use the UI from your phone, tablet, or another laptop:

1. Open Proto-Familiar in your browser (on the machine running the server).
2. Click the globe icon in the top bar — it sits next to the prompt-inspector magnifier.
3. Flip the **Access from other devices** switch in the popover.

The popover lists the URLs you can open on any device that can reach this machine. If the `tailscale` CLI is installed and you're logged in, you'll see entries like:

```
Tailscale:      http://my-laptop.tail1234.ts.net:8742
Tailscale IPv4: http://100.x.y.z:8742
```

Open one of those on any device signed into the same Tailnet — Tailscale handles auth and encryption.

The toggle persists in `.proto-familiar-config.json` (git-ignored) and survives restarts. To preset it on startup, set `TAILSCALE=1` in the environment before launching — that seeds the initial state when the config file doesn't exist yet.

### How it works

Proto-Familiar always binds to `0.0.0.0`, but until the toggle is on a middleware rejects every non-loopback request with a 403. The effective behaviour with the toggle off matches the historical `localhost`-only bind — nothing on the network can actually talk to the server.

### Security caveats

- **Plain LAN (no Tailscale):** anything that can route to the port can use your API key, read Phylactery context, and write to the knowledge editor. Don't enable on coffee-shop wifi.
- **Tailscale:** other devices on your tailnet can use the proxy. If you share your tailnet with others, set up Tailscale ACLs accordingly.
- The `/api/debug-prompt` endpoint and the Phylactery knowledge editor REST API are unauthenticated. They were designed for loopback. When the toggle is on, anyone on your network gets them too.
- The toggle endpoint itself (`POST /api/tailscale`) is also unauthenticated; once the toggle is on, any device that can reach the server can toggle it back off (a self-locking misfeature) or back on. Keep it loopback-only unless you trust your network.

### Tailscale Serve / Funnel (alternative)

If you'd rather not flip the toggle at all, leave it off and front the loopback server with Tailscale Serve instead:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8742
```

That exposes the loopback server over HTTPS to your tailnet without changing Proto-Familiar's gate. See [Tailscale Serve docs](https://tailscale.com/kb/1242/tailscale-serve).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8742` | HTTP port the server listens on |
| `HOST` | `0.0.0.0` | Bind address. The runtime gate keeps non-loopback requests out until you flip the in-UI toggle — override only if you need to force a different bind. |
| `TAILSCALE` | `0` | Seeds the persisted toggle state on first launch (when `.proto-familiar-config.json` doesn't exist yet). After that, the in-UI toggle is the source of truth. |
| `UNRUH_PATH` | auto: `./unruh/src/unruh/__main__.py` | Absolute path to Unruh's entry module. Rarely needed — Unruh ships in-tree at `./unruh/`. |
| `UV_BIN` | auto: probes `~/.local/bin/uv`, `~/.cargo/bin/uv`, `/usr/local/bin/uv`, `/opt/homebrew/bin/uv` on Unix, and the Windows equivalents | Absolute path to the `uv` binary thalamus.js uses to spawn Unruh. Override if `uv` is installed somewhere unusual and isn't on the PATH that `node server.js` inherits. |

Phylactery's own env vars (read by Phylactery itself, not by Proto-Familiar; documented for completeness because the **+ Phylactery** connection designation sets them automatically):

| Variable | Set by Proto-Familiar | Purpose |
|---|---|---|
| `PHYLACTERY_LLM_API_KEY` | always, from the designated connection | Bearer token for Phylactery's outbound LLM calls (consolidation, embeddings) |
| `PHYLACTERY_LLM_BASE_URL` | always, derived from the connection's provider | Full chat-completions URL (Phylactery POSTs to this exactly — no path appending) |
| `PHYLACTERY_LLM_MODEL` | always, from the connection | Model name for Phylactery's outbound LLM calls |
| `PHYLACTERY_LLM_PROVIDER` | always | Informational provider tag (`nanogpt` / `zai` / `zai-coding` / `google`) |
| `ENTITY_CORE_LLM_API_KEY` / `ENTITY_CORE_LLM_BASE_URL` / `ENTITY_CORE_LLM_MODEL` | always | Legacy aliases set alongside the `PHYLACTERY_LLM_*` names so `consolidate.py` resolves either; for backward compatibility only. |
| `ZAI_API_KEY` / `ZAI_BASE_URL` / `ZAI_MODEL` | only when provider is `zai` or `zai-coding` | Alternate names Phylactery falls back to if the `PHYLACTERY_LLM_*` variants are unset. Setting both pairs makes any Phylactery build work without re-config. |

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

### Google AI Studio — Gemini
- **Endpoint:** `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` (Google's OpenAI-compatible surface)
- **Suggested models:** `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.0-flash`, `gemini-2.0-flash-lite`
- **API key:** create one at [Google AI Studio](https://aistudio.google.com/apikey); it's sent as a `Bearer` token like every other provider here.

All providers use the OpenAI-compatible `chat/completions` format. The server selects the correct endpoint automatically based on your provider selection.

---

## Setting up Phylactery

Phylactery — the Familiar's canonical self-store (identity files, RAG memories, knowledge graph, trackers) — ships **in-tree** at `./phylactery/`; there's no separate clone step. The one-click installer materialises its Python venv with `uv sync`, so the first server start is ready to go. If you want to set it up manually, run `cd phylactery && uv sync`.

In short: Phylactery lives at `./phylactery/` inside the Proto-Familiar repo, and `thalamus.js` spawns it on startup as a Python MCP child via `uv run` (exactly the way it spawns Unruh). If `uv` isn't installed or the `phylactery/.venv` hasn't been synced, Phylactery is treated as absent — enrichment is skipped and Proto-Familiar runs normally. Hard-disable it with `PROTO_FAMILIAR_PHYLACTERY_DISABLED=1`.

---

## Versioning

Proto-Familiar's version lives in `package.json` (`version` field) and is the **single source of truth**. The server reads it at boot and exposes it via:

- `/api/version` → `{ "version": "<v>" }`
- `/api/health`  → `{ "ok": true, "version": "<v>" }`
- The startup banner: `Proto-Familiar <v> running at:`
- The sidebar footer badge in the UI.

The current release tag is whatever's in `package.json`'s `version` field — read at boot and exposed through the surfaces above. While in alpha the version stays in the `0.2.x` series; the minor slot is reserved for the next major milestone (currently the Unruh temporal-context module — see [`unruh-implementation-plan.md`](unruh-implementation-plan.md)).

Bump policy (followed by AI agents working in this repo via [`CLAUDE.md`](../CLAUDE.md)):

| Change                                                              | Bump        |
|---------------------------------------------------------------------|-------------|
| Bug fix, copy edit, dependency pin, doc tweak                       | patch       |
| New user-visible feature, behavioral change, UX rework, new endpoint | minor       |
| Breaking API/storage change, removed feature, format migration      | major       |
| Graduate from pre-release                                           | drop suffix |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Windows: tray icon doesn't appear | Click the `^` arrow in the system tray to reveal hidden icons, or check `.proto-familiar.log` / `.proto-familiar.log.err` in the project folder. |
| Windows: `node` not on PATH after install | Close the install window, open a new shell (so PATH refreshes), and double-click `Proto-Familiar.vbs` again. |
| Windows: SmartScreen blocks the `.vbs` | Click **More info → Run anyway**. The script is plain text — feel free to read it first. |
| Windows: shortcuts not created on a fresh install | Re-run `Proto-Familiar.vbs` — shortcut creation is idempotent and creates each `.lnk` only if it doesn't already exist (so re-running picks up any that are missing without touching the ones that are present). |
| macOS: "unidentified developer" warning | Right-click `Proto-Familiar.command` → **Open** the first time. |
| Linux: app menu entry missing | Re-run `./install.sh` (creates the entry if missing). Some desktops require a logout/login cycle, or run `update-desktop-database ~/.local/share/applications/`. |
| Port already in use | The launchers / `npm start` auto-recycle their own stale instance. If something else is on the port, the prestart hook tells you the holding PID — stop that process or set `PORT=8080` and re-launch. |
| Server won't stop cleanly | `./stop.sh` (or `stop.bat`) kills every `node server.js` rooted at this dir, not just the tracked PID. If even that fails, delete `.proto-familiar.pid` by hand and re-run stop. |
| `[thalamus] Unruh venv missing` warning | Re-run the installer (`./install.sh`, `install.bat`, or just `Proto-Familiar.vbs`) — or, if uv is already installed, run `cd unruh && uv sync` manually. Proto-Familiar boots and runs without Unruh, just without the temporal-context block. |
| `phylactery: provider "..." has no known URL` warning | The connection you designated for Phylactery uses a provider tag that isn't in `PROVIDER_URLS` in `providers.js`. Either pick a different connection or add the provider to that map. |
| Consolidator: `No LLM API key configured (ENTITY_CORE_LLM_API_KEY or ZAI_API_KEY)` | No connection is designated as Phylactery's source. Open the sidebar's Connections section and click **+ Phylactery** on a connection. The respawn happens automatically. |
| Consolidator: `API request failed with status 404` | The designated connection's model doesn't exist at that provider's endpoint, or the env was set partially. Try a different model on the same provider, or re-pick the connection so the env is fully repopulated. |
