# Troubleshooting

Common ways things go sideways, and what to do about each. Most failures
fall into one of a few buckets: entity-core lost contact, the browser
can't store something, the user did something the UI allows but the
backend doesn't, or the live data drifted from what the UI cached.

If something isn't covered here, the **🩺 Generate diagnostic report**
button in the sidebar dumps a plain-text snapshot of the runtime state
that's useful to paste into a bug report.

---

## Knowledge editor / graph

### "Failed to load graph: entity-core not connected"

The MCP server is down. `thalamus.js` spawns entity-core as a child
process on Proto-Familiar startup; if it crashed or never started,
every `/api/entity/*` endpoint returns `502 { error: 'entity-core not
connected' }` and the Knowledge editor surfaces that text directly.

**Fix:** restart Proto-Familiar (`npm start`). On startup, watch the
server logs for `[thalamus]` lines — they'll say whether the child
process spawned and connected. The most common causes are:

- `deno` not on `PATH` for the shell that started Node. `start.sh`
  adds `~/.deno/bin` to `PATH`; bare `npm start` won't.
- entity-core path missing or moved. Set `ENTITY_CORE_PATH` to the
  absolute path of its `src/mod.ts` if you have a non-standard layout.
- entity-core's data directory permissions changed.

Chat still works without entity-core — `enrich()` returns an empty
string and every request goes through unenriched. But the Knowledge
editor will be unusable until the MCP child reconnects.

### Logs say `entity-core not found … skipping`, or it keeps reconnecting

Two distinct entity-core startup states, distinguished by what the
`[thalamus]` logs say:

- **`entity-core not found at <path> — skipping (run install.sh /
  install.bat to clone it)`** — entity-core isn't cloned. `connect()`
  pre-checks for the checkout (symmetric with how Unruh checks its
  venv) and skips cleanly: one line, no retry loop. Run the installer
  to clone it, or set `ENTITY_CORE_PATH` if you keep it somewhere
  non-standard.

- **Repeated `Reconnecting to entity-core in …ms (attempt N/10)`** —
  entity-core *is* cloned, but the `deno` spawn is failing. The
  checkout exists so the skip-check passes, then the spawn errors and
  the backoff loop runs (1s, 2s, 5s, 10s, 30s; max 10 attempts) before
  giving up. The usual cause is **`deno` not installed, or installed
  but not findable**. `thalamus.js` resolves `deno` from `~/.deno/bin`,
  `~/.cargo/bin`, Homebrew, and (Windows) `%USERPROFILE%\.deno\bin`
  before falling back to `PATH` — so this only bites when deno genuinely
  isn't in any of those. (This is the one entity-core failure mode that
  still spins rather than skipping: it's rare, because the installer
  installs deno *when* it clones entity-core, so "cloned but no deno" is
  an unusual hand-edited state.)

  **Fix:** re-run `./install.sh` / `install.bat` (it installs deno and
  caches entity-core's deps), or install Deno yourself from
  <https://deno.com/> and point `DENO_BIN` at the binary if it lives
  somewhere unusual. Restart Proto-Familiar afterward to retry — the
  loop doesn't re-arm itself once it's given up.

### Map view is empty or stuck on "Loading…"

If the toolbar's Type filter has a value, only nodes of that type are
returned and edges to nodes of other types are dropped (so the legend
matches what's drawn). Clear the filter to see everything.

If it's empty without a filter, switch to List view — if List is also
empty, the graph genuinely has no nodes (or entity-core is down; see
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

entity-core prunes snapshots older than `ENTITY_CORE_SNAPSHOT_RETENTION_DAYS`
(default 30 days). Bump that env var before starting Proto-Familiar
if you need longer retention.

---

## Entity-core API key (consolidator)

### `[Consolidation] Failed weekly/...: No LLM API key configured (ENTITY_CORE_LLM_API_KEY or ZAI_API_KEY)`

Entity-core's background consolidator runs on a schedule (weekly /
monthly / yearly) and needs an LLM API key of its own — distinct from
whatever the chat path uses. The error message names the API key but
fires whenever any of `API_KEY` / `BASE_URL` / `MODEL` is unset.

**Fix:** open Proto-Familiar's **Connections** sidebar, click
**+ entity-core** on the connection whose key + model entity-core
should use. The badge **entity-core** appears next to the row. The
server detects the change on the next settings save and respawns
the entity-core child with the new env — no Proto-Familiar restart
needed; the next scheduled consolidation will succeed.

You can pick any saved connection (any provider). It doesn't have
to be your primary or any fallback — entity-core is independent of
the chat path.

### `LLM call failed: API request failed with status 404: Not Found`

Entity-core has a key + provider but the model or endpoint isn't
serving requests. Two common causes:

- The connection's `model` field doesn't exist at that provider —
  switch to a model you know works for chat with the same
  connection.
- The connection's `provider` tag isn't in `providers.js`'s
  `PROVIDER_URLS` map, so the wrong base URL is being passed. The
  server logs a warning at boot: `[thalamus] entity-core: provider
  "<tag>" has no known URL — add it to PROVIDER_URLS in
  providers.js`. Either edit the map or pick a connection with one
  of the supported provider tags (`nanogpt`, `zai`, `zai-coding`).

### Designation change didn't take effect

Server-side respawn happens on `PUT /api/settings`, fire-and-
forget. Check the server logs for:

```
[server] entity-core API-key designation changed — respawning
[thalamus] Connected to entity-core at <path> (API key from connection "<provider>")
```

If you see the first line but not the second, the spawn itself
failed — usually because `deno` isn't on PATH for the server
process. Restart Proto-Familiar via the launcher script (which
primes `~/.deno/bin`); a bare `npm start` from a shell without
that path will inherit the same gap.

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

## Updating & versions

### The installer says "already up to date" but I'm not getting the new version

Almost always one of two things:

- **You installed from a downloaded ZIP, not a `git clone`.** GitHub's "Download ZIP" gives you a folder like `Proto-Familiar-main` that is **not** a git repository — there's no `.git` inside it. The installer pulls updates with `git`, so on a ZIP it silently can't, and you stay on whatever version the ZIP captured. (The "up to date" you saw may also have been **npm's** `up to date` line, which is about node modules, not the app.) The installer now warns about this explicitly and prints `Branch: (not a git checkout …)` at the end. **Fix:** reinstall via git so updates work:

  ```
  git clone https://github.com/ScarletPrinceEury/Proto-Familiar.git
  ```

  then run the installer from the cloned folder. Back up `tomes/`, `logs/`, `settings.json`, and entity-core's `data/` first if you're replacing an existing folder (the installer also auto-backs these up into `.pf-backups/` in update mode).

- **The version you want is on a different branch.** A `git clone` checks out the default branch (usually `main`); work in progress may live on a feature branch that hasn't been merged yet. `git pull` only updates the branch you're on, so if the new code is elsewhere you'll see "Already up to date." Check your branch with `git branch --show-current` (the installer also prints `Branch:` at the end). To switch: `git checkout <branch>` then re-run the installer.

### Where do I check which version I'm running?

Three places, all showing the server's `package.json` version:

- **In the app:** the **version badge in the sidebar footer** reads `Proto-Familiar vX.Y.Z`.
- **Endpoints:** open `http://localhost:8742/api/version` or `/api/health` in a browser.
- **At install time:** the installer now prints `Version: Proto-Familiar vX.Y.Z` and the git `Branch:` when it finishes.

If the badge shows an old version after an update, you likely need to **restart the server** (the launchers do this) and **hard-refresh the browser** (Ctrl-Shift-R / Cmd-Shift-R) so the cached UI reloads.

### Windows: `'wmic' is not recognized` / `Invalid path` during the backup step

`wmic` was removed in Windows 11 24H2, and older `install.bat` used it to build the backup timestamp — when it failed, the backup folder got a malformed name with a colon in it (`Invalid path`). Fixed: the installer now generates the timestamp with PowerShell. Re-run the latest `install.bat` and the backup step works. (Your data was never at risk — the failure was only in naming the backup copy.)

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
graph / memory / identity block from current entity-core state. So the
next message after an edit reflects the change — but the current
turn's reply is already in flight with the old context. Send another
message (anything; "ok" works) to get a fresh enrichment.

### Tool calls fail with "entity-core not connected"

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
