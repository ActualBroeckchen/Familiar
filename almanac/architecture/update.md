---
title: Update
topics: [architecture, update, installer]
sources:
  - id: updater-js
    type: file
    path: updater.js
  - id: app-js
    type: file
    path: public/app.js
  - id: discord-gateway-js
    type: file
    path: discord-gateway.js
---

# Update

Proto-Familiar can update itself against the repository or branch it came from, without any manual git or download steps. The system detects available updates and applies them through either a web UI popover or a Discord command, never restarting the server automatically — the ward always chooses when to restart and load the new code [@updater-js] [@app-js] [@discord-gateway-js].

## Two update modes: git vs download

`updater.js` ships with two update strategies, detected from the install shape [@updater-js]:

**Git checkout mode** — the repo is cloned with `.git` present. Update keys off `origin` (or a fork's own remote) and the checked-out branch, reading them live from git. The check is `git fetch` + compare versions, and application is `git merge --ff-only` (refusing a merge that would rewrite history) [@updater-js]. This strategy is repo-agnostic: a fork tracks the fork's branch, an upstream clone tracks upstream, without any reconfiguration.

**Download mode** — the install came from a release archive (no `.git`). A download has no git history and no record of where it came from, so update keys off the `repository` field baked into `package.json` instead [@updater-js]. Update is download-and-replace: fetch the latest source tarball from GitHub and lay its files over the install. This needs **no git on the machine** — only `tar`, which ships in the base OS on macOS/Linux and Windows 10+. Git requires Xcode tools on macOS, which non-technical users don't have [@updater-js].

The `PROTO_FAMILIAR_UPDATE_BRANCH` environment variable can override the default branch in download mode [@updater-js].

Both paths **never restart the process** — new code is live only after a restart, which the launcher or update scripts handle (and re-run dependency install). The caller tells the ward to restart via the web UI button or Discord command outcome. User data is safe by construction: the tarball contains only the repo's tracked files, so gitignored data (`settings.json`, `tomes/`, `logs/`, the Python venvs, `node_modules`) is never in the source and is never overwritten or deleted [@updater-js].

## Update detection and status reporting

An in-memory `_updateState` object caches the result of checking for available updates, keyed to the repository and branch [@app-js]. The `/api/update-status` endpoint returns `{ available: boolean, current: string, latest: string, behind: number, dirty: boolean, where?: string }`, where `where` is a human-readable branch or tag name [@app-js]. A request with `force=true` bypasses the cache and re-checks immediately [@app-js].

On the web, an `update-dot` indicator appears in the header when `available === true`, and clicking the update button opens a popover showing the version gap and "Apply Update" prompt [@app-js]. The popover displays the repository URL parsed from the upstream for context [@app-js].

## Discord `/update` command

Ward-only (checked at the call site; a villager typing `/update` is just chat). The `/update` command with no arguments reports status — `An update is available...` or `You're on v..., N commits behind` — and refuses if the tree has uncommitted local changes (checked via `git status`) [@discord-gateway-js]. The `/update now` variant applies the update and reports `The new code is on disk. Restart the server (or use your launcher) to load it.` [@discord-gateway-js].

## The update API

`POST /api/update` triggers `applyUpdate()`, which runs the relevant strategy (git merge or tarball download/replace) and writes the outcome to a return object with `{ ok, current, latest, error? }` [@updater-js]. A failed update logs the full error but returns a structured failure to the client, never throwing into the response path [@updater-js].

## Off-switch

Hard off-switch: `PROTO_FAMILIAR_UPDATE_DISABLED=1` disables the entire subsystem [@updater-js].

## Design principle: manual, never automatic

Update is never automatic and never silent. Detection runs on demand (via `/api/update-status`), not on a background loop. A ward who has disabled updates can go weeks without seeing an available update notice. The system respects this: updates are opt-in ceremonies, not surprise background work. The ward chooses the moment to restart and load new code.

## Windows shell updater self-replacement

Windows batch and PowerShell scripts that apply updates cannot replace themselves while running — the OS holds the running script file open. Download-mode updates on Windows use a staged `.pfnew` + post-exit swap pattern: the new tarball is laid down as `.pfnew` before the script exits, and an exit-phase handler completes the swap from the old script to the new one. Both shell updaters (`update.bat` and the PowerShell equivalent) are fork-aware via the `repository` field in `package.json`, so each fork applies updates to its own remote rather than to upstream.

## Two-speed updates: static assets vs. registered routes

Because update never restarts the process, the front end and the back end can end up on different versions of the code for as long as the ward waits before restarting. Static assets under `public/` are served fresh from disk on every request, so a browser refresh alone is enough to pick up new markup or a new button. Express routes, by contrast, are registered once at boot, so a new route added by the same update is invisible to the running server until it restarts [@app-js]. A ward who updates and refreshes but does not restart can be shown a new control wired to an endpoint the running server does not have yet, producing a raw 404 that looks like a bug rather than a restart reminder. This surfaced concretely as the "Fix Kyutai" button described in [Voice](voice); `public/app.js` now detects that specific 404 shape and tells the ward they updated the files but have not restarted, rather than showing a cryptic error [@app-js]. The gap itself is general: it reopens for every new endpoint a future update adds, not only voice's.

## Related

- [Installer and launcher](installer-and-launcher) — the one-click install path that also acts as the launcher after installation.
- [Engineering conventions](../reference/engineering-conventions) — the repo-wide graceful-degradation and never-throw rules this subsystem follows.
- [Voice](voice) — the "Fix Kyutai" repair button whose 404 report is what surfaced the two-speed update gap.
