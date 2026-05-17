# Notes for AI agents working on this repo

## Versioning

The current version lives in `package.json` (`version` field) and is the
**single source of truth**. The server reads it once at boot and exposes
it via `/api/health`, `/api/version`, the startup banner, and the UI
badge in the sidebar footer. Don't hard-code the version anywhere else.

When you make changes, bump the version *as part of the same commit*:

| Change                                                              | Bump        |
|---------------------------------------------------------------------|-------------|
| Bug fix, copy edit, dependency pin, doc tweak                       | patch       |
| New user-visible feature, behavioral change, UX rework, new endpoint | minor       |
| Breaking API/storage change, removed feature, format migration      | major       |
| Graduate from pre-release                                           | drop suffix |

Format: `MAJOR.MINOR.PATCH-alpha` while in alpha (so `0.1.1-alpha` →
`0.1.2-alpha` after a fix, `0.2.0-alpha` after a feature).

Process:

1. Edit `package.json` — that's it. Nothing else stores the version.
2. Mention the new version in the commit body if the change is
   user-visible (so anyone reading `git log` knows what shipped when).
3. If you can't decide between patch and minor, prefer minor — it's
   cheaper than the wrong call going out as a "patch".

When uncertain whether a change warrants a bump (formatting, comment
only, whitespace), skip it. Otherwise bump.

## Other repo conventions worth knowing

- **`entity-core` directory**: new installs land at `../entity-core`;
  pre-rename installs at `../entity-core-alpha` are still detected as a
  fallback in `thalamus.js`, `install.{sh,bat}`, `scripts/win/install.ps1`,
  and `scripts/import-entity.js`. Keep both paths working.
- **Settings** are stored centrally in `settings.json` (gitignored).
  `SERVER_SYNCED_KEYS` in `public/app.js` is the canonical subset of
  `state` that syncs to the server — add new user-preference fields
  there if you want them to follow the user across devices.
- **Tailscale gate**: `server.js` always binds to `0.0.0.0` but a
  middleware blocks non-loopback requests with 403 until the in-UI
  toggle (or the `TAILSCALE=1` env var on first start) flips it on.
  State persists in `.proto-familiar-config.json`.
- **Default port** is `8742`. If you change it, hit every launcher
  (`start.sh`, `start.bat`, `Proto-Familiar.command`,
  `scripts/win/tray.ps1`), `server.js`, and any doc that mentions it.
- **Launchers** detect stray `node server.js` processes by cwd / command-
  line match, not just the tracked PID. Don't regress that — it's how
  pre-migration leftovers (e.g. an old instance still on port 3000) get
  recycled instead of running alongside the new one.
