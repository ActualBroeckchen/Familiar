# Getting Started

## Quickest path: one double-click

Proto-Familiar ships with a one-click installer and launcher for each platform. The installer takes care of Node, Deno, Git, `npm install`, and the entity-core clone; the launcher starts the server, opens your browser, and gives you a single button to shut everything down.

### Windows

1. Clone or download the repo.
2. Double-click **`Proto-Familiar.vbs`**.
3. On first run a console window opens and auto-installs Node 18+, Deno, and Git via `winget install --scope user` (no admin prompt). It then runs `npm install`, clones [entity-core](https://github.com/PsycherosAI/Psycheros) into the sibling directory, and creates Desktop + Start Menu shortcuts named **Proto-Familiar**.
4. After install, a tray icon appears (bottom-right, you may need to click the `^` to reveal hidden icons) and your browser opens at `http://localhost:8742`.

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
3. On first run it runs `./install.sh`, which checks Node 18+ and Deno, runs `npm install`, and clones entity-core. On subsequent runs it skips straight to launching.
4. A Terminal window opens showing server logs; your browser opens automatically at `http://localhost:8742`.

**To shut down**, press **Ctrl-C** in the Terminal window, then close it (Cmd-W). Because `node` runs in the foreground, Ctrl-C cleanly stops both Proto-Familiar and its entity-core child.

> If macOS Gatekeeper warns about an unidentified developer, right-click `Proto-Familiar.command` → **Open** the first time.

### Linux

1. Clone the repo.
2. Run `./install.sh` once. It checks Node and Deno, runs `npm install`, clones entity-core, and registers a `.desktop` entry under `~/.local/share/applications/` so **Proto-Familiar** appears in your app launcher / activities overview.
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

Open `http://localhost:8742`.

The repo also ships three plain shell scripts you can call directly:

| Script | What it does |
|---|---|
| `./install.sh` | First run: `npm install` + clone entity-core + register Linux desktop entry. Subsequent runs auto-detect the existing install (presence of `node_modules/`) and switch to **update mode**: `git pull --ff-only` on Proto-Familiar, refresh entity-core to the pinned tag, re-run the idempotent `npm install` and `deno cache`. No prerequisite installs and no shortcut creation in update mode. |
| `./start.sh` | Start server in the background, write PID file, open browser |
| `./stop.sh` | Kill the PID-file process (and its entity-core child) |

Windows equivalents (`install.bat`, `start.bat`, `stop.bat`, and the PowerShell installer under `scripts/win/install.ps1`) behave identically — `install.bat` detects `node_modules\` and routes to update mode the same way. The recommended Windows entry point is `Proto-Familiar.vbs` — it avoids the brief console flash and gives you the tray icon.

---

## First-time setup

1. Open the **Settings panel** (☰ icon in the top bar).
2. Select your **Provider** (NanoGPT, Z.ai Standard, or Z.ai Coding Plan).
3. Paste your **API key**.
4. Select or type a **model name**.
5. Start chatting.

Your API key lives in browser `localStorage` and is sent only to `localhost`.

---

## Updating an existing install

Re-run the same installer you used for the first install:

- **Windows:** double-click `Proto-Familiar.vbs` (the launcher re-runs the installer if needed) or run `install.bat` directly.
- **macOS:** double-click `Proto-Familiar.command`, or `./install.sh` from a terminal.
- **Linux:** `./install.sh`.

The installer detects the existing install via the `node_modules/` directory and switches to **update mode**. The flow:

1. **Defensive backup** — `tomes/`, `logs/`, entity-core's `data/` directory (if non-empty), `.proto-familiar-config.json` (Tailscale toggle state), and `settings.json` (central user settings) are copied to `.pf-backups/<UTC-timestamp>/` inside the project root *before* any git operation runs. Safety net even though the git ops below are designed not to touch user data.
2. **`git pull --ff-only`** on the Proto-Familiar repo. Skipped if the directory isn't a git checkout. The `--ff-only` flag means git refuses any non-fast-forward merge — if you're on a non-default branch, have local commits, or have uncommitted changes that would conflict, the pull aborts with a warning and the work tree is left exactly as you had it.
3. **Node / Deno / Git checks**, with auto-install of anything missing (same as fresh install — your environment catches up if a new release added a requirement).
4. **`npm install`** to pick up any new Node deps.
5. **`git fetch && git checkout <pinned tag>`** on entity-core (idempotent — only does work if the tag bumped). entity-core's runtime `data/` directory is gitignored at both the workspace and package root, so this never touches your identity files, memory markdown, or SQLite store.
6. **`deno cache`** to pick up any new entity-core Deno deps (only fetches what's missing).

Update mode skips only the shortcut / desktop-entry creation, since those are already in place.

**What's protected:**

| Data | Where it lives | Protected by |
|---|---|---|
| User-saved tomes (`<uuid>.json`) | `tomes/` | Untracked filenames; git never touches them. Also copied into `.pf-backups/` |
| Built-in tome content you edited | `tomes/ADHD-Tome.json`, etc. | If upstream changed the same file, `git pull --ff-only` refuses the merge and warns. Also copied into `.pf-backups/` |
| Session logs | `logs/` | Gitignored. Also copied into `.pf-backups/` |
| entity-core identity files, memory markdown, SQLite store | `entity-core/packages/entity-core/data/` (or the legacy `entity-core-alpha/…` if you installed before the rename) | Gitignored at both workspace and package roots; never touched by `git checkout <tag>`. Also copied into `.pf-backups/` |
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

- **Plain LAN (no Tailscale):** anything that can route to the port can use your API key, read entity-core context, and write to the knowledge editor. Don't enable on coffee-shop wifi.
- **Tailscale:** other devices on your tailnet can use the proxy. If you share your tailnet with others, set up Tailscale ACLs accordingly.
- The `/api/debug-prompt` endpoint and the entity-core knowledge editor REST API are unauthenticated. They were designed for loopback. When the toggle is on, anyone on your network gets them too.
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
| `ENTITY_CORE_PATH` | auto: probes `../entity-core/packages/entity-core/src/mod.ts`, then `../entity-core/src/mod.ts`, then the legacy `../entity-core-alpha/…` paths in the same order | Absolute path to entity-core's `src/mod.ts`. Override if your entity-core install is not in the sibling directory or to force a specific layout. |

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

The one-click installer clones entity-core automatically and pre-caches its Deno dependencies so the first server start is instant. If you want to do it manually (or import an existing data directory), see [Entity-Core](entity-core.md).

In short: entity-core lives at `../entity-core/packages/entity-core` (Deno-workspace layout) relative to Proto-Familiar, and `thalamus.js` spawns it on startup. Older sibling-directory layouts are still detected as fallbacks — the legacy top-level `../entity-core/src/mod.ts` path, and the pre-rename `../entity-core-alpha/…` checkout. If entity-core is missing or fails, enrichment is skipped and Proto-Familiar runs normally.

---

## Versioning

Proto-Familiar's version lives in `package.json` (`version` field) and is the **single source of truth**. The server reads it at boot and exposes it via:

- `/api/version` → `{ "version": "<v>" }`
- `/api/health`  → `{ "ok": true, "version": "<v>" }`
- The startup banner: `Proto-Familiar <v> running at:`
- The sidebar footer badge in the UI.

Current release: `0.1.2-alpha`. Pre-release while the schema and storage layout are still in flux.

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
| macOS: "unidentified developer" warning | Right-click `Proto-Familiar.command` → **Open** the first time. |
| Linux: app menu entry missing | Some desktops require a logout/login cycle, or run `update-desktop-database ~/.local/share/applications/`. |
| Port already in use | `PORT=8080 ./start.sh` (or set `PORT` before launching the Windows/macOS app) |
| Server won't stop cleanly | Delete `.proto-familiar.pid` and kill stray `node` / `deno` processes, then relaunch. |
