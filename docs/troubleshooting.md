# Troubleshooting

Common ways things go sideways, and what to do about each. Most failures
fall into one of a few buckets: Phylactery lost contact, the browser
can't store something, the user did something the UI allows but the
backend doesn't, or the live data drifted from what the UI cached.

If something isn't covered here, the **🩺 Generate diagnostic report**
button in the sidebar dumps a plain-text snapshot of the runtime state
that's useful to paste into a bug report.

---

## Install failed on Windows (or appears to do nothing)

Every Windows install run appends to `.proto-familiar-install.log` in
the project root via PowerShell's `Start-Transcript`. Open that file in
Notepad first — the failing step is usually named explicitly, with the
underlying error on the line below.

If the log file doesn't exist at all, the installer never got to run.
The most common cause is **PowerShell scripts being blocked by Group
Policy** (AppLocker, WDAC, or Constrained Language Mode — common on
work-issued laptops). The launcher (`Proto-Familiar.vbs`) detects this
and pops a MessageBox explaining the situation. Workarounds:

- Run `install.bat` from a Command Prompt instead — it does most of
  what `install.ps1` does without needing PowerShell COM access.
- Ask IT to allow PowerShell scripts in the Proto-Familiar folder.
- Install on a personal machine; copy the working install over later.

### "Proto-Familiar is under OneDrive — relocate?"

The installer detected the install folder is being synced by OneDrive.
OneDrive locks files mid-sync, which breaks `npm install`. New Win11
installs back up `Documents` and `Desktop` to OneDrive by default, so
this trips up most users by accident.

Click **Yes** at the prompt — the installer copies the folder to
`%LOCALAPPDATA%\Proto-Familiar` (outside OneDrive, short path,
user-writable) and re-launches itself there. The original folder is
left in place with a `RELOCATED_TO.txt` marker; delete it manually
once the new install is verified working.

### Pre-flight warnings about unreachable hosts

The installer probes `github.com`, `registry.npmjs.org`,
`astral.sh`, and `pypi.org` over TCP 443 before doing anything. Each
unreachable host adds a line to the final summary MessageBox. The
usual culprit is a corporate firewall (ZScaler / Netskope / etc.)
doing TLS interception with an internal CA that the downstream tools
(uv) don't trust. Routes to a "ask IT for a proxy bypass" or
"install Proto-Familiar on a non-corporate machine" path.

### Install log is empty / "logs are empty"

Same diagnostic loop as above: open `.proto-familiar-install.log`. If
it doesn't exist, PowerShell is blocked — see the AppLocker section
above. If the log exists but is empty, `Start-Transcript` was blocked
(some AV configurations strip it). Try `install.bat` instead — it
captures output via a different mechanism.

### `[ERROR] Node.js install ran but node still isn't on PATH`

Fixed in 0.5.3-alpha. winget now ships Node LTS as an
archive/portable package, shimmed under
`%LOCALAPPDATA%\Microsoft\WinGet\Links` rather than installed as an
MSI under `Program Files\nodejs`. The installer's PATH refresh only
knew the old MSI locations, so it couldn't see the freshly-installed
Node and dead-ended — even though Node was fine. The installers
(`install.ps1`, `install.bat`) and launchers (`tray.ps1`, `start.bat`)
now re-read the persisted PATH and prime the WinGet Links dir, so the
install completes and the first launch works without reopening a
window.

If you hit this on an older build, the message's own advice still
works: close the window, open a new one, and re-run — the new PATH is
persisted, so a fresh shell picks it up.

---

## Windows: update doesn't take effect / version stays the same

Symptom: you ran `update.bat` (or pulled and re-ran `install.bat`), but
the new version isn't running — the version badge in the sidebar
footer still shows the old number, and new features aren't there.

Cause: a previous `node.exe` from Proto-Familiar is still running.
`robocopy` (used by `update.bat`) silently fails to overwrite source
files that the running process has open, so the on-disk update is
partial. On the next launch the tray sees the orphan on port 8742 and
adopts it as "running" — that orphan is still serving the old code.

Through 0.3.6-alpha there was a bug in `tray.ps1` / `start.bat` /
`stop.bat` where the orphan detection filtered Win32 processes by a
project-root path that never actually appeared in their command line.
Quit / Stop / Restart all silently killed nothing, leaving node.exe
to linger across updates. **Fixed in 0.3.7-alpha** — the launchers now
use the PID file as the canonical signal and fall back to taskkill-ing
the port owner if it looks like Proto-Familiar.

If you're on 0.3.7-alpha or newer and still hitting this, run
`stop.bat`; it now reports each PID it kills so the failure mode is
visible. If `stop.bat` says "Port 8742 held by PID X but it doesn't
look like Proto-Familiar", another app on your machine grabbed the
port — stop that app, or run with `set PROTO_FAMILIAR_PORT=<other>`
before `start.bat`.

To unstick by hand on an older build: Task Manager → Details tab →
sort by Name → find `node.exe` → End task. Then run the update.

---

## Knowledge editor / graph

### "Failed to load graph: phylactery not connected"

The MCP server is down. `thalamus.js` spawns Phylactery — the in-tree
identity layer — as a child process on Proto-Familiar startup; if it
crashed or never started, every `/api/entity/*` endpoint returns
`502 { error: 'phylactery not connected' }` and the Knowledge editor
surfaces that text directly.

**Fix:** restart Proto-Familiar (`npm start`). On startup, watch the
server logs for `[thalamus]` lines — they'll say whether the child
process spawned and connected. The most common causes are:

- `uv` not installed, or not on `PATH` for the shell that started
  Node. `start.sh` primes uv's location; a bare `npm start` from a
  shell that doesn't have uv on PATH won't.
- The `phylactery/.venv` hasn't been synced (a fresh checkout, or a
  hand-edited install). Run `cd phylactery && uv sync`.
- Phylactery's `data/` directory permissions changed.

Chat still works without Phylactery — `enrich()` returns an empty
string and every request goes through unenriched. But the Knowledge
editor will be unusable until the MCP child reconnects.

### Logs say the identity layer is absent or it keeps reconnecting

The `[thalamus]` logs distinguish two states:

- **Phylactery skipped at startup** — usually because `uv` isn't
  installed or `phylactery/.venv` hasn't been synced. `connect()`
  pre-checks for the venv (symmetric with how Unruh checks its own)
  and skips cleanly: one line, no retry loop. **Fix:** re-run the
  installer (`./install.sh` / `install.bat`, or just
  `Proto-Familiar.vbs`), or — if uv is already installed — run
  `cd phylactery && uv sync` manually, then restart Proto-Familiar.

- **Repeated reconnect attempts** — the venv exists so the skip-check
  passes, but the `uv run` spawn is failing (e.g. a partial sync or a
  missing uv binary). **Fix:** re-run the installer or `uv sync`, make
  sure `uv` is reachable on PATH (or set `UV_BIN` to its absolute
  path), then restart Proto-Familiar to retry — the loop doesn't
  re-arm itself once it's given up.

Phylactery degrades to absent without breaking chat: if it can't
start, enrichment is skipped and Proto-Familiar runs normally.

### Map view is empty or stuck on "Loading…"

If the toolbar's Type filter has a value, only nodes of that type are
returned and edges to nodes of other types are dropped (so the legend
matches what's drawn). Clear the filter to see everything.

If it's empty without a filter, switch to List view — if List is also
empty, the graph genuinely has no nodes (or Phylactery is down; see
above). If List has rows but Map doesn't, click **Refresh**: Map view
fetches its own `/api/entity/graph/full` aggregate, and a stale browser
cache or an interrupted earlier load can leave it half-drawn.

### "No node with that label is loaded. Try refreshing."

Add-edge resolves the typed target label against the in-memory label
index, which is fed by every fetch that returned nodes. Two cases
trigger this message:

- The target really doesn't exist yet — create it via **+ Node** first.
- The target exists but was filtered out by the toolbar's Type filter
  before you opened this popover, so it isn't in the index. Clear the
  filter, click **Refresh**, then try again.

### "Multiple nodes share that label. Use the first match?"

Labels aren't unique — two nodes can share one. Add-edge picks the
first matching id and asks before proceeding. If that isn't the one
you wanted, rename one of the duplicates (open it via List view and
change the label) so the next resolve picks the right id.

### Editing edits the wrong edge

If you have the popover open and another editor changes the underlying
graph (the LLM running an edit tool, a second tab, a direct DB write),
the popover's cached subgraph drifts. The visible edge list shows what
was true when you opened the popover. Click **Refresh** on the toolbar
to pull a fresh copy, then re-open the node.

### Map snaps every time I edit something

It shouldn't — `keLoadGraphMap` preserves x/y for nodes that survive a
reload, and the force-directed simulation only re-runs on a genuinely
fresh map. If yours is shaking on every save, you likely changed the
Type filter or the set of visible nodes changed enough that most of
the previous positions are gone. Click Refresh once to relax the
layout, then keep editing.

### Hovering over an edge doesn't light it up

Edge hit-test uses the same Bézier curve we render (16-segment
polyline approximation), with ~6 screen-pixels of tolerance scaled by
zoom. Two cases still miss:

- Very low zoom (< 0.4×) — the edge is 1 px thick on screen and the
  6-px tolerance shrinks proportionally. Zoom in.
- An edge overlapping a node — node hit-test wins. Hover off the dot
  to surface the edge underneath.

### Map labels overlap and become unreadable

Intentional — labels only show for the hovered node at default zoom.
Past ~1.4× zoom every dot's label is drawn alongside; zoom out first
if it gets too dense.

---

## Modals

### Backdrop click doesn't close the Knowledge / Tomes editors

Intentional. A click outside the modal used to dismiss it, but the
event fires when a drag (canvas pan, resize-handle drag, popover
drag) ends past the modal edge — which is exactly when you don't want
the window to vanish. Only the ✕ closes them.

### Modal size doesn't persist between sessions

`bindResizableModal` writes the size to `localStorage` keys
`pf-knowledge-modal-size`, `pf-tome-entries-modal-size`, and
`pf-lore-editor-modal-size`. If you're in private / incognito mode or
have site storage disabled, every open starts at the default size.
Not a bug, just a browser policy.

### Modal opens at an unusably tiny size on a small screen

The CSS clamps `width` and `height` via `max-width: 95vw` /
`max-height: 92vh`. If a previous session saved a width larger than
the current viewport, the rendered size gets clamped and the
ResizeObserver eventually overwrites the saved value with the clamped
one — self-correcting within one resize cycle. If it's stuck, clear
the storage key from DevTools (`localStorage.removeItem('pf-knowledge-modal-size')`).

---

## Knowledge editor — memories

### Significant memory shows "⚠ invalid date format" when clicked

Affects builds before **0.4.1-alpha** (historical — the canonical
store was entity-core at the time; Phylactery now addresses memories
by integer `id`). Significant memories were stored
one named file per milestone (`2026-06-11_why-melian-trusts-me.md`),
and entity-core's listing returned that composite `date_slug` key — but
the read/edit/delete endpoints only accepted plain dates, so clicking
a slugged entry failed validation. Saving worked the whole time; only
viewing/editing from the Knowledge editor was broken.

Fixed in 0.4.1-alpha: the composite key was accepted everywhere and
split into the separate `date` + `slug` parameters entity-core
expected. Update Proto-Familiar; the existing files need no migration.
The Familiar's own `update_memory` / `delete_memory` tools take the
same composite key for significant memories (it's included in
`save_memory`'s confirmation, e.g.
`Memory saved (significant/2026-06-11_why-melian-trusts-me).`).

---

## Snapshots & undo

### "I deleted something I shouldn't have"

Every destructive op auto-snapshots first. Open Knowledge editor →
**Snapshots** tab → Restore the snapshot from just before your delete.
Restoration overwrites the current memory / identity / graph state
wholesale, so anything created *after* the snapshot is lost — copy
recent edits to a scratch file first if they matter.

Creates (new node, new edge) do **not** auto-snapshot — they're
additive and reversible by deleting the thing you just made.

### Snapshots tab shows an old entry I want to keep forever

Phylactery prunes snapshots older than `ENTITY_CORE_SNAPSHOT_RETENTION_DAYS`
(default 30 days). Bump that env var before starting Proto-Familiar
if you need longer retention.

---

## Phylactery API key (consolidator)

### `[Consolidation] Failed weekly/...: No LLM API key configured (ENTITY_CORE_LLM_API_KEY or ZAI_API_KEY)`

Phylactery's background consolidator runs on a schedule (weekly /
monthly / yearly) and needs an LLM API key of its own — distinct from
whatever the chat path uses. The error message names the API key but
fires whenever any of `API_KEY` / `BASE_URL` / `MODEL` is unset.

**Fix:** open Proto-Familiar's **Connections** sidebar, click
**+ Phylactery** on the connection whose key + model Phylactery
should use. The badge **Phylactery** appears next to the row. The
server detects the change on the next settings save and respawns
the Phylactery child with the new env — no Proto-Familiar restart
needed; the next scheduled consolidation will succeed.

You can pick any saved connection (any provider). It doesn't have
to be your primary or any fallback — Phylactery is independent of
the chat path.

### `LLM call failed: API request failed with status 404: Not Found`

Phylactery has a key + provider but the model or endpoint isn't
serving requests. Two common causes:

- The connection's `model` field doesn't exist at that provider —
  switch to a model you know works for chat with the same
  connection.
- The connection's `provider` tag isn't in `providers.js`'s
  `PROVIDER_URLS` map, so the wrong base URL is being passed. The
  server logs a warning at boot: `[thalamus] phylactery: provider
  "<tag>" has no known URL — add it to PROVIDER_URLS in
  providers.js`. Either edit the map or pick a connection with one
  of the supported provider tags (`nanogpt`, `zai`, `zai-coding`, `google`).

### Designation change didn't take effect

Server-side respawn happens on `PUT /api/settings`, fire-and-
forget. Check the server logs for:

```
[server] Phylactery API-key designation changed — respawning
[thalamus] Connected to Phylactery at <path> (API key from connection "<provider>")
```

If you see the first line but not the second, the spawn itself
failed — usually because `uv` isn't on PATH for the server
process (or `phylactery/.venv` isn't synced). Restart Proto-Familiar
via the launcher script (which primes uv's location); a bare
`npm start` from a shell without uv on PATH will inherit the same gap.

---

## Unruh (temporal context)

### `[thalamus] Unruh venv missing at .../unruh/.venv — run \`cd unruh && uv sync\` to enable temporal context`

Unruh's Python venv hasn't been materialised yet — usually because
you pulled the branch but haven't re-run the installer.

**Fix:** re-run `./install.sh` (Linux/macOS) or `install.bat`
(Windows), or just relaunch — the launchers and `npm start` /
`npm run dev` all trigger the installer automatically when this
state is detected. Manual fallback: `cd unruh && uv sync`.

If you don't intend to use Unruh at all, the warning is harmless —
the rest of Proto-Familiar boots and runs without it. You'll just
miss the `[Temporal Context]` block in the prompt.

### `[ensure-unruh] uv is not installed`

uv (Astral's Python package manager) isn't on PATH. The installer
auto-installs it for you — run `./install.sh` or `install.bat`
(or `Proto-Familiar.vbs`) and the next launch will find it.

Manual install: see <https://docs.astral.sh/uv/>. After install,
make sure `~/.local/bin` (Unix) or `%USERPROFILE%\.local\bin`
(Windows) is on the PATH that `node server.js` inherits.

### Unruh process keeps reconnecting in the logs

`thalamus.js` reconnects to Unruh with exponential backoff (1s, 2s,
5s, 10s, 30s; max 10 attempts) when the child closes. If you see
the reconnect loop repeatedly:

- Run `uv run python -m unruh` from `./unruh/` manually to see the
  real error message (it normally goes to a stderr stream that
  thalamus doesn't surface).
- Common cause: a Python syntax error in a recent `unruh/` change.
- After 10 attempts the loop gives up — restart Proto-Familiar to
  retry.

---

## Discord presence

### The bot is offline in Discord (won't reply, doesn't see my DMs)

**First stop: the Discord presence panel in Settings tells you why.** Open
Settings → **Discord presence** and read the status line:

- **🔴 "Discord rejected the bot token …"** — the token is invalid or was
  reset on Discord's side. This is the most common cause. A token that
  *used* to work and suddenly fails was almost certainly reset (manually, or
  by Discord after a leak). **Fix:** Discord Developer Portal → your app →
  **Bot** → **Reset Token** → copy the new token (make sure it's the *Bot
  Token*, not the Client Secret, Public Key, or Application ID — pasting one
  of those is the #1 cause of a `401`). Paste it into the **Bot token** field,
  make sure **Enable Discord presence** is ticked, and press **⟳ Apply &
  connect**. It should flip to **🟢 Connected as …** within a few seconds.
- **🟡 "Starting / reconnecting…"** — a transient network/Discord hiccup; it
  retries with backoff. If it never settles, check your internet and that
  the bot's **Message Content** privileged intent is enabled in the portal.
- **⚪ "Not running"** — Discord presence is off, or no token is set, or the
  env off-switch `PROTO_FAMILIAR_DISCORD_DISABLED=1` is set.

> **Updating does not invalidate Discord tokens.** Pulling new Proto-Familiar
> code can't reach across and reset a token on Discord's servers — if the bot
> goes offline around an update, it's a coincidence of timing, not the update.
> Don't blanket-refresh tokens "just in case"; read the panel, and only reset
> when it shows 🔴.

### I changed the token / toggle but nothing happened

Press **⟳ Apply & connect** in the Discord presence panel. It applies the
saved settings and reconnects immediately — no page reload, and no waiting for
the 30-second supervisor tick. (The supervisor *will* pick the change up on its
own within 30s, but the button is instant.)

---

## Updating & versions

### The installer says "already up to date" but I'm not getting the new version

Almost always one of two things:

- **You installed from a downloaded ZIP, not a `git clone`.** GitHub's "Download ZIP" gives you a folder like `Proto-Familiar-main` that is **not** a git repository — there's no `.git` inside it. The installer pulls updates with `git`, so on a ZIP it silently can't, and you stay on whatever version the ZIP captured. (The "up to date" you saw may also have been **npm's** `up to date` line, which is about node modules, not the app.) The installer now detects this, warns explicitly, and prints `Branch: (not a git checkout …)` at the end.

  **Fix — the one-click updater (no git needed):** double-click **`update.bat`** (Windows) or **`update.command`** (macOS), or run **`./update.sh`** (Linux). It downloads the latest version from GitHub and lays it over your folder, then runs the installer. Your settings, saved memories, tomes, chat logs, and Phylactery data are **preserved** — they aren't part of the download, so they're never overwritten (and the installer auto-backs them up to `.pf-backups/` too). This is the recommended path for non-technical users.

  **Or reinstall via git** (enables the installer's own `git pull` going forward):

  ```
  git clone https://github.com/ScarletPrinceEury/Proto-Familiar.git
  ```

- **The version you want is on a different branch.** A `git clone` checks out the default branch (usually `main`); work in progress may live on a feature branch that hasn't been merged yet. `git pull` only updates the branch you're on, so if the new code is elsewhere you'll see "Already up to date." Check your branch with `git branch --show-current` (the installer also prints `Branch:` at the end). To switch: `git checkout <branch>` then re-run the installer.

### Where do I check which version I'm running?

Three places, all showing the server's `package.json` version:

- **In the app:** the **version badge in the sidebar footer** reads `Proto-Familiar vX.Y.Z`.
- **Endpoints:** open `http://localhost:8742/api/version` or `/api/health` in a browser.
- **At install time:** the installer now prints `Version: Proto-Familiar vX.Y.Z` and the git `Branch:` when it finishes.

If the badge shows an old version after an update, you likely need to **restart the server** (the launchers do this) and **hard-refresh the browser** (Ctrl-Shift-R / Cmd-Shift-R) so the cached UI reloads.

### Windows: `'wmic' is not recognized` / `Invalid path` during the backup step

`wmic` was removed in Windows 11 24H2, and older `install.bat` used it to build the backup timestamp — when it failed, the backup folder got a malformed name with a colon in it (`Invalid path`). Fixed: the installer now generates the timestamp with PowerShell. Re-run the latest `install.bat` and the backup step works. (Your data was never at risk — the failure was only in naming the backup copy.)

## Turning things off

Every background loop and optional feature has a hard environment switch. Set
it to `1` before starting and that piece stays inert — no model loads, no loop
ticks, nothing to un-configure afterwards. Useful for narrowing down which part
is misbehaving, and for running lean on a small machine.

This list is generated from the code by `npm run audit:wiring`, which fails if
a switch exists that no doc mentions. It was added because two switches
(`PROTO_FAMILIAR_PHYLACTERY_DISABLED` and `PROTO_FAMILIAR_ZAI_MCP_COMMAND`) had
been shipped with no documentation at all — a hard off-switch nobody can find
is not an off-switch.

**Voice and media**

| Switch | Stops |
|---|---|
| `PROTO_FAMILIAR_VOICE_DISABLED` | all of voice — reading aloud, voice notes, the worker |
| `PROTO_FAMILIAR_VOICE_PRESENCE_DISABLED` | group-call awareness — who's present, who joined/left, and per-speaker labels (falls back to the old unlabelled transcript) |
| `PROTO_FAMILIAR_VOICE_GREETINGS_DISABLED` | the spoken hello when someone joins a group call (presence/labels stay on) |
| `PROTO_FAMILIAR_VISION_DISABLED` | seeing images |
| `PROTO_FAMILIAR_VISION_THREAT_DISABLED` | an image raising your Familiar's concern |
| `PROTO_FAMILIAR_ZAI_VISION_DISABLED` | the z.ai Coding-Plan vision route |

**Reaching out and noticing**

| Switch | Stops |
|---|---|
| `PROTO_FAMILIAR_NOTICING_DISABLED` | noticing on its own |
| `PROTO_FAMILIAR_WARMTH_DISABLED` | warm reach-outs |
| `PROTO_FAMILIAR_TRIAGE_DISABLED` | silence triage (**safety** — read §10 of the voice spec first) |
| `PROTO_FAMILIAR_THREAT_DISABLED` | crisis-signal scoring (**safety**) |
| `PROTO_FAMILIAR_VOICE_THREAT_DISABLED` | a live call informing your Familiar's safety read (**safety**) |
| `PROTO_FAMILIAR_PONDERING_DISABLED` | autonomous pondering |
| `PROTO_FAMILIAR_PONDER_WEB_DISABLED` | looking things up on the web while pondering |
| `PROTO_FAMILIAR_WAIT_STREAK_DISABLED` | the wait-streak nudge |

**Time, reminders, calendar**

| Switch | Stops |
|---|---|
| `PROTO_FAMILIAR_REMINDERS_DISABLED` | the reminders scheduler |
| `PROTO_FAMILIAR_EVENT_ALERTS_DISABLED` | "coming up" pings before an event |
| `PROTO_FAMILIAR_ELAPSED_STAMP_DISABLED` | stamping events that quietly went by |
| `PROTO_FAMILIAR_GCAL_DISABLED` | Google Calendar sync |
| `PROTO_FAMILIAR_STEWARDSHIP_DISABLED` | readiness / prerequisite surfacing |
| `PROTO_FAMILIAR_ROUTINE_REVIEW_DISABLED` | routine review |
| `PROTO_FAMILIAR_NEEDS_TRACKING_DISABLED` | needs-window tracking |
| `PROTO_FAMILIAR_SPINE_STATES_DISABLED` | spine states |
| `PROTO_FAMILIAR_BASELINES_DISABLED` | contact baselines |
| `PROTO_FAMILIAR_WEATHER_DISABLED` | the weather sense |

**Memory**

| Switch | Stops |
|---|---|
| `PROTO_FAMILIAR_MEMORIZE_DISABLED` | turning conversations into memories |
| `PROTO_FAMILIAR_MEMORY_SWEEP_DISABLED` | the slow catch-up pass for missed days |
| `PROTO_FAMILIAR_MEMORY_LIFECYCLE_DISABLED` | consolidation / decay |
| `PROTO_FAMILIAR_FOLLOWUPS_DISABLED` | catching "I'll do that later" commitments |
| `PROTO_FAMILIAR_TOME_GRADUATION_DISABLED` | graduating tome knowledge |
| `PROTO_FAMILIAR_CONTENT_REGATE_DISABLED` | re-tagging private notes for sharing |
| `PROTO_FAMILIAR_PHYLACTERY_DISABLED` | identity and memory entirely — your Familiar loses both |

**Village and tools**

| Switch | Stops |
|---|---|
| `PROTO_FAMILIAR_DISCORD_DISABLED` | the Discord gateway |
| `PROTO_FAMILIAR_DISCORD_TOOLS_DISABLED` | tools on Discord turns |
| `PROTO_FAMILIAR_DISCORD_BATCH_DISABLED` | coalescing a burst into one reply |
| `PROTO_FAMILIAR_WEBSEARCH_DISABLED` | web search |
| `PROTO_FAMILIAR_PAGE_WATCH_DISABLED` | watching web pages for changes |
| `PROTO_FAMILIAR_TOOL_SURFACING_DISABLED` | surfacing relevant tools per turn |
| `PROTO_FAMILIAR_QUIET_TOOLS_DISABLED` | quiet tool calls |
| `PROTO_FAMILIAR_GUIDE_CHAT_DISABLED` | the setup guide chat |
| `PROTO_FAMILIAR_UPDATE_DISABLED` | checking for updates |

**Overrides (not off-switches)**

| Variable | Does |
|---|---|
| `PROTO_FAMILIAR_UPDATE_BRANCH` | which branch the updater checks |
| `PROTO_FAMILIAR_ZAI_MCP_COMMAND` | overrides the command used to launch z.ai's vision MCP server |
| `PROTO_FAMILIAR_CHROME` (or `CHROME`) | points the browser tools at an existing Chrome/Chromium binary, skipping the auto-download |
| `PROTO_FAMILIAR_BROWSER_INSTALL_TIMEOUT_MS` | how long to wait for the one-time Chromium download before treating it as stalled (default 15 min); raise it for a genuinely slow link. If the download never finishes, its log is at `browser/chromium-install.log` |

### Settings only reachable by editing the file

A few tuning knobs are read from `settings.json` but have no control in the app.
Editing them by hand works and **survives** — the settings merge preserves keys
the UI does not know about, which is exactly what that merge exists for.

| Key | Default | Does |
|---|---|---|
| `readinessLeadHours` | 48 | how far ahead an unresolved prerequisite is surfaced |
| `discordMediaPerHour` | 20 | per-room hourly cap on images ingested from Discord |

## Reading aloud (voice)

Every symptom below was hit for real during development, so these are the
actual failures rather than imagined ones.

### The 🔊 button says "Unavailable"

The speech engine did not install. `sherpa-onnx-node` is an *optional*
dependency, so npm skips it in silence on a platform with no prebuilt binary,
or if you installed with `--omit=optional`.

Check what the machine actually has:

```
node scripts/check-voice-ready.mjs
```

If it reports the engine missing, retry with `npm install sherpa-onnx-node`.
Everything else keeps working either way — voice is a feature, not a
requirement.

### The button offers "Get the voice (194 MB)"

That is normal on a fresh install. Reading aloud needs a one-time model
download, and it asks before taking the space. Click it again to start; the
button shows progress and reports any failure on itself.

### It reads one paragraph and stops, or makes static

You are almost certainly on an old build — this was a real bug, fixed. Update,
restart, and try again. If it persists, check which engine is speaking (below):
the two have different failure modes.

### The voice changes between sentences or paragraphs

Expected on the **built-in** engine to some degree: it restarts its internal
state at each utterance, so the voice can shift. The Kyutai sidecar holds
steadier across a long message.

Settings → the speaking-engine dropdown → "Kyutai sidecar". If it is not
installed yet there is an install button beside it (~600 MB, mostly PyTorch).

### Which engine is actually speaking?

The boot log says so:

```
[voice] speaking through sherpa      ← the built-in one
[voice] speaking through pocket      ← the Kyutai sidecar
```

If it says `asked for pocket, using sherpa: …`, the sidecar was chosen but is
not usable, and the reason is on that line. The Settings pane shows the same
thing. **Check this before reporting a voice problem** — the two engines sound
different and fail differently, and a whole debugging session here was once
spent on the wrong one.

### The microphone button isn't there

It is always there now, next to the message box — there is no setting to turn
on. If it is genuinely missing, reload the page once; an older tab was
rendered before the button existed.

(It used to be hidden behind a *Hearing voice notes* setting. That was wrong:
pressing the button is already the consent, and hiding it made the feature
undiscoverable as well as slower to reach.)

### Recording works but no words appear under it

The recording uploaded fine; the transcribing is what didn't happen. In order
of likelihood:

- **"model-missing"** — the listening model has not been downloaded yet
  (158 MB to fetch, 233 MB unpacked). It is offered the first time you record.
- **The model isn't pinned in this build.** The download refuses without a
  verified checksum, which is the intended behaviour, not a fault. From a
  checkout: `npm run pin:listening`, once, then commit the result.
- **The note still sends either way.** Your Familiar reads it as a recording
  they could not make out, rather than pretending it wasn't there.

### It heard the wrong words

Re-record — that is what the transcript under the recording is for, and why it
appears before you send rather than after. Short, clear phrases in a quiet room
transcribe best; the model handles English, German, Japanese, Korean, Chinese
and Cantonese without being told which.

If it is consistently wrong on your voice specifically, that is worth reporting
— it is a small quantised model and accuracy varies by speaker much more than
by language.

### I picked a voice and it still sounds the same

The picker's "Use this" button downloads the clip, verifies it, and only then
saves the choice. If it shows "⚠ Not in use" afterwards, hover it: the tooltip
says why the engine is still on something else.

### It is very slow the first time

Expected. The sidecar loads a 219 MB model and derives the voice from the
reference clip on first use — 30–60 seconds is normal. It is cached after
that; later messages start in about a second.

### Turning it off entirely

`PROTO_FAMILIAR_VOICE_DISABLED=1` disables all of it, read-aloud included.

## Port conflicts & start-up

### `Error: listen EADDRINUSE: address already in use 0.0.0.0:8742`

Something else is on the port. The `npm start` prestart hook and
the launcher scripts both auto-recycle Proto-Familiar's *own* stale
instances, but they refuse to kill anything else.

**If the holder IS a stale Proto-Familiar:** the prestart message
identifies it by PID and tries to free the port. If that loop fails,
run `./stop.sh` / `stop.bat` (which kills every `node server.js`
rooted at this dir) and retry.

**If the holder is something else:** the prestart message will say
`port X is held by PID Y, which isn't a Proto-Familiar instance` —
stop that process, or run with a different port:

```
PORT=8080 npm start
PORT=8080 ./start.sh
```

### Server quits immediately after `npm start` with no error

Most likely a prestart hook failure surfaced as a non-zero exit
before `node server.js` ran. Run the hooks individually to see the
real message:

```
node scripts/ensure-unruh-deps.mjs
node scripts/ensure-port-free.mjs
```

---

## LLM / chat

### LLM seems to ignore my recent Knowledge editor changes

`thalamus.enrich()` runs once per `/api/chat` request and rebuilds the
graph / memory / identity block from current Phylactery state. So the
next message after an edit reflects the change — but the current
turn's reply is already in flight with the old context. Send another
message (anything; "ok" works) to get a fresh enrichment.

### Tool calls fail with "phylactery not connected"

Same root cause as the Knowledge editor failure — see above. The LLM
will see the error message in the tool result and can either retry
later or carry on without that knowledge surface.

---

## Sessions & memorization

### Memorize button does nothing

Memorization is a queued server-side job. Check the server logs for
`[memorize]` lines; if the queue is full or the worker is stuck on a
failing job (exponential backoff), the next submission sits in the
queue. The queue file is `tomes/.memorization-queue.json` — safe to
delete if it's wedged (you'll lose pending jobs).

### Session Memories tome is missing

Auto-created on the first successful memorization. If you've never
memorized anything, it won't exist yet.
