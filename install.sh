#!/usr/bin/env bash
# Proto-Familiar installer (macOS / Linux)
#
# Fresh install: installs Node deps, auto-installs Deno + uv (if
#   missing), clones entity-core (release tag) as a sibling directory,
#   pre-caches its Deno module graph, syncs Unruh's Python venv from
#   unruh/uv.lock, and registers a desktop entry on Linux.
#
# Update mode: triggered automatically when node_modules/ already exists.
#   Pulls latest Proto-Familiar (git pull --ff-only), refreshes
#   entity-core to the pinned tag, re-runs idempotent npm install +
#   deno cache + uv sync. Re-runs Node / Deno / uv checks (and
#   auto-installs anything missing) in both modes so the system catches
#   up to new requirements.
#
# Desktop entry creation is idempotent and runs in both modes: it
# creates the entry only when it doesn't already exist, so a fresh
# clone over an old data dir (or any path that lands in update mode
# without an existing desktop entry) still gets the application-menu
# shortcut.
#
# User-data safety: BEFORE any git operation in update mode the installer
# takes a defensive copy of tomes/, logs/, and entity-core's data/ into
# .pf-backups/<timestamp>/ inside the project root. Independent of git's
# own protections (untracked files left alone, --ff-only refusing
# dirty-conflict merges, entity-core's data/ being gitignored), this
# gives a clear recovery path if anything goes sideways.

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PARENT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
# Resolve the entity-core sibling checkout. New installs land in
# `entity-core/`; older installs from before the rename used
# `entity-core-alpha/` and we keep using that in place to avoid silent
# directory moves.
ENTITY_CORE_DIR_NEW="$PARENT_DIR/entity-core"
ENTITY_CORE_DIR_LEGACY="$PARENT_DIR/entity-core-alpha"
if [ -d "$ENTITY_CORE_DIR_NEW" ]; then
  ENTITY_CORE_DIR="$ENTITY_CORE_DIR_NEW"
elif [ -d "$ENTITY_CORE_DIR_LEGACY" ]; then
  ENTITY_CORE_DIR="$ENTITY_CORE_DIR_LEGACY"
else
  ENTITY_CORE_DIR="$ENTITY_CORE_DIR_NEW"
fi
# The release lives at https://github.com/PsycherosAI/Psycheros/releases/tag/<tag>
ENTITY_CORE_REPO="https://github.com/PsycherosAI/Psycheros.git"
ENTITY_CORE_TAG="entity-core-v0.2.2"
BACKUP_ROOT="$SCRIPT_DIR/.pf-backups"

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mXX %s\033[0m\n' "$*"; exit 1; }

# Detect mode: an existing node_modules means we're refreshing an install
# rather than setting one up from scratch. Both paths run the same
# idempotent steps; update mode adds a pre-pull backup and skips
# shortcut creation.
if [ -d "$SCRIPT_DIR/node_modules" ]; then
  MODE="update"
else
  MODE="install"
fi

if [ "$MODE" = "update" ]; then
  say "Proto-Familiar updater (existing install detected)"
else
  say "Proto-Familiar installer"
fi
say "Working dir: $SCRIPT_DIR"

# --- Pre-pull data backup (update mode only) -----------------------------
# Copy at-risk directories into .pf-backups/<timestamp>/ before any git
# operation runs. Independent safety net on top of git's own protections.
# If a directory doesn't exist or is empty, it's silently skipped.
if [ "$MODE" = "update" ]; then
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  BACKUP_DIR="$BACKUP_ROOT/$STAMP"
  ANYTHING_BACKED_UP=0
  # Directories. Explicitly probe BOTH the new entity-core dir and the
  # pre-rename entity-core-alpha so a user with leftover legacy data
  # still gets it backed up (resolved $ENTITY_CORE_DIR only points at
  # one of them).
  for src in \
    "$SCRIPT_DIR/tomes" \
    "$SCRIPT_DIR/logs" \
    "$ENTITY_CORE_DIR_NEW/packages/entity-core/data" \
    "$ENTITY_CORE_DIR_NEW/data" \
    "$ENTITY_CORE_DIR_LEGACY/packages/entity-core/data" \
    "$ENTITY_CORE_DIR_LEGACY/data"; do
    if [ -d "$src" ] && [ -n "$(ls -A "$src" 2>/dev/null)" ]; then
      mkdir -p "$BACKUP_DIR"
      rel="$(echo "$src" | sed "s|^$PARENT_DIR/||")"
      dest="$BACKUP_DIR/$rel"
      mkdir -p "$(dirname "$dest")"
      cp -a "$src" "$dest"
      ANYTHING_BACKED_UP=1
    fi
  done
  # Single files (Tailscale toggle state, central settings, etc.)
  for f in \
    "$SCRIPT_DIR/.proto-familiar-config.json" \
    "$SCRIPT_DIR/settings.json"; do
    if [ -f "$f" ]; then
      mkdir -p "$BACKUP_DIR"
      rel="$(echo "$f" | sed "s|^$PARENT_DIR/||")"
      dest="$BACKUP_DIR/$rel"
      mkdir -p "$(dirname "$dest")"
      cp -a "$f" "$dest"
      ANYTHING_BACKED_UP=1
    fi
  done
  if [ "$ANYTHING_BACKED_UP" = "1" ]; then
    say "User data backed up to $BACKUP_DIR/"
    say "  (tomes/, logs/, entity-core data/, .proto-familiar-config.json, settings.json — restore by copying back if needed)"
  fi
fi

# --- Pull latest Proto-Familiar (update mode only) -----------------------
if [ "$MODE" = "update" ] && [ -d "$SCRIPT_DIR/.git" ] && command -v git >/dev/null 2>&1; then
  say "Pulling latest Proto-Familiar (git pull --ff-only)..."
  if ! ( cd "$SCRIPT_DIR" && git pull --ff-only ); then
    warn "git pull --ff-only failed (local changes, non-default branch, or no network). Continuing with current checkout — your work tree is unchanged."
  fi
fi

# --- Node.js check (install if missing, in both modes) ------------------
if ! command -v node >/dev/null 2>&1; then
  die "Node.js is not installed. Install Node 18+ from https://nodejs.org/ and re-run."
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js $NODE_MAJOR detected. Proto-Familiar needs Node 18 or newer."
fi
say "Node.js $(node -v) found."

# --- Deno check (auto-install if missing, in both modes) ----------------
# Look in PATH first, then in the common install location the official
# script writes to. We add ~/.deno/bin to PATH for the rest of this run
# so post-install steps see it without needing a shell restart; start.sh
# does the same probe at launch time.
if [ -d "$HOME/.deno/bin" ]; then PATH="$HOME/.deno/bin:$PATH"; fi
if command -v deno >/dev/null 2>&1; then
  say "Deno $(deno --version | head -n1) found."
  HAVE_DENO=1
else
  if command -v curl >/dev/null 2>&1; then
    say "Deno not found — installing via the official script (writes to ~/.deno)..."
    if curl -fsSL https://deno.land/install.sh | sh -s -- --yes >/dev/null 2>&1; then
      PATH="$HOME/.deno/bin:$PATH"
      if command -v deno >/dev/null 2>&1; then
        say "Deno $(deno --version | head -n1) installed."
        HAVE_DENO=1
      else
        warn "Deno install ran but 'deno' is still not on PATH. Open a new terminal and re-run, or install manually from https://deno.com/."
        HAVE_DENO=0
      fi
    else
      warn "Deno auto-install failed. entity-core will be disabled until you install Deno 2+ from https://deno.com/."
      HAVE_DENO=0
    fi
  else
    warn "Neither 'deno' nor 'curl' available. entity-core needs Deno 2+; install from https://deno.com/ if you want the identity layer."
    HAVE_DENO=0
  fi
fi

# --- npm install (idempotent; fast when nothing changed) ----------------
say "Running npm install..."
( cd "$SCRIPT_DIR" && npm install )

# --- entity-core: clone (install) or refresh to pinned tag (update) ----
# Note: entity-core's runtime data/ directory is gitignored at both the
# workspace root and the package root, so `git checkout <tag>` never
# touches user identity files, memory markdown, or the SQLite store.
if [ -d "$ENTITY_CORE_DIR" ]; then
  if [ "$MODE" = "update" ] && [ -d "$ENTITY_CORE_DIR/.git" ] && command -v git >/dev/null 2>&1; then
    say "Refreshing entity-core to tag $ENTITY_CORE_TAG..."
    if ! ( cd "$ENTITY_CORE_DIR" && git fetch --tags --depth 1 origin "refs/tags/$ENTITY_CORE_TAG:refs/tags/$ENTITY_CORE_TAG" 2>/dev/null && git checkout --quiet "$ENTITY_CORE_TAG" ); then
      warn "Could not refresh entity-core to $ENTITY_CORE_TAG (local changes or network). Keeping current checkout."
    fi
  else
    say "entity-core already present at $ENTITY_CORE_DIR — skipping clone."
  fi
else
  if command -v git >/dev/null 2>&1; then
    say "Cloning entity-core ($ENTITY_CORE_TAG) into $ENTITY_CORE_DIR ..."
    if git clone --depth 1 --branch "$ENTITY_CORE_TAG" "$ENTITY_CORE_REPO" "$ENTITY_CORE_DIR"; then
      say "entity-core cloned at tag $ENTITY_CORE_TAG."
    else
      warn "Tag clone failed; falling back to default branch."
      git clone --depth 1 "$ENTITY_CORE_REPO" "$ENTITY_CORE_DIR" || warn "Clone failed. You can clone it manually later."
    fi
  else
    warn "git not found — skipping entity-core clone. Install git or place entity-core at $ENTITY_CORE_DIR manually."
  fi
fi

# --- entity-core dependency pre-cache (idempotent) ---------------------
# Psycheros is a Deno workspace; entity-core lives at packages/entity-core/
# (older releases kept it at the repo root). Probe both; the workspace
# path wins. `deno cache` only fetches what's missing, so this is safe
# to re-run in update mode after a tag bump.
ENTITY_CORE_PKG_DIR=""
if [ -f "$ENTITY_CORE_DIR/packages/entity-core/src/mod.ts" ]; then
  ENTITY_CORE_PKG_DIR="$ENTITY_CORE_DIR/packages/entity-core"
elif [ -f "$ENTITY_CORE_DIR/src/mod.ts" ]; then
  ENTITY_CORE_PKG_DIR="$ENTITY_CORE_DIR"
fi

if [ -n "$ENTITY_CORE_PKG_DIR" ] && [ "$HAVE_DENO" = "1" ]; then
  say "Caching entity-core dependencies (only fetches what's new)..."
  if ( cd "$ENTITY_CORE_PKG_DIR" && deno cache src/mod.ts >/dev/null 2>&1 ); then
    say "entity-core dependencies cached."
  else
    warn "deno cache failed — first server start will download deps before entity-core comes up."
  fi
elif [ -n "$ENTITY_CORE_PKG_DIR" ]; then
  warn "Skipping entity-core dep pre-cache (Deno not available). First server start will download them."
fi

# --- uv check (auto-install if missing, in both modes) -----------------
# uv is the Python package/runtime manager Unruh uses. The official
# installer writes to ~/.local/bin by default. We pre-add that to PATH so
# the subsequent `uv sync` works without needing a shell restart;
# start.sh / Proto-Familiar.command do the same probe at launch time.
if [ -d "$HOME/.local/bin" ]; then PATH="$HOME/.local/bin:$PATH"; fi
if [ -d "$HOME/.cargo/bin" ]; then PATH="$HOME/.cargo/bin:$PATH"; fi
if command -v uv >/dev/null 2>&1; then
  say "uv $(uv --version 2>&1 | head -n1) found."
  HAVE_UV=1
else
  if command -v curl >/dev/null 2>&1; then
    say "uv not found — installing via the official Astral script (writes to ~/.local/bin)..."
    if curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1; then
      PATH="$HOME/.local/bin:$PATH"
      if command -v uv >/dev/null 2>&1; then
        say "uv $(uv --version 2>&1 | head -n1) installed."
        HAVE_UV=1
      else
        warn "uv install ran but 'uv' is still not on PATH. Open a new terminal and re-run, or install manually from https://docs.astral.sh/uv/."
        HAVE_UV=0
      fi
    else
      warn "uv auto-install failed. Unruh (temporal context) will be disabled until you install uv from https://docs.astral.sh/uv/."
      HAVE_UV=0
    fi
  else
    warn "Neither 'uv' nor 'curl' available. Unruh needs uv; install from https://docs.astral.sh/uv/."
    HAVE_UV=0
  fi
fi

# --- Unruh dependency sync (idempotent; fast when nothing changed) -----
# Materialises unruh/.venv from unruh/uv.lock. uv sync is a no-op when
# nothing has changed, so re-running in update mode after a git pull
# picks up any locked-dep changes cleanly.
if [ "$HAVE_UV" = "1" ] && [ -f "$SCRIPT_DIR/unruh/pyproject.toml" ]; then
  say "Syncing Unruh dependencies (only fetches what's new)..."
  if ( cd "$SCRIPT_DIR/unruh" && uv sync --quiet ); then
    say "Unruh dependencies synced."
  else
    warn "uv sync failed — Unruh will be disabled until this is resolved."
  fi
elif [ -f "$SCRIPT_DIR/unruh/pyproject.toml" ]; then
  warn "Skipping Unruh dep sync (uv not available). Temporal context will be disabled until uv is installed."
fi

# --- Platform-specific launcher polish (idempotent, runs in both modes) -
# Previously gated on install mode only, which silently skipped desktop-
# entry creation on update mode — fine when the entry already existed,
# broken when it didn't (manual cleanup, restored backup, OS reinstall
# that preserved the project dir). Both branches below check for the
# target's presence first, so re-running is cheap.
UNAME="$(uname -s 2>/dev/null || echo unknown)"
case "$UNAME" in
  Linux)
    DESKTOP_FILE="${XDG_DATA_HOME:-$HOME/.local/share}/applications/proto-familiar.desktop"
    if [ -f "$SCRIPT_DIR/scripts/linux/install-desktop-entry.sh" ] && [ ! -f "$DESKTOP_FILE" ]; then
      say "Installing application-menu entry..."
      bash "$SCRIPT_DIR/scripts/linux/install-desktop-entry.sh" || warn "Desktop entry install failed (non-fatal)."
    elif [ -f "$DESKTOP_FILE" ]; then
      say "Application-menu entry already present at $DESKTOP_FILE."
    fi
    ;;
  Darwin)
    if [ -f "$SCRIPT_DIR/Proto-Familiar.command" ]; then
      # chmod +x is idempotent and cheap; always run so a re-clone or a
      # filesystem that drops the executable bit (network shares, some
      # zip extractors) doesn't break the double-click path.
      chmod +x "$SCRIPT_DIR/Proto-Familiar.command" || true
      [ "$MODE" = "install" ] && say "macOS launcher ready: double-click Proto-Familiar.command in Finder."
    fi
    ;;
esac

# Completion marker. Written only after npm install succeeded (set -e
# would have exited above on failure). The launchers check for this
# instead of node_modules to decide whether to (re)run the installer —
# node_modules can exist without the installer ever having run (a manual
# `npm install`), which would skip entity-core clone + shortcut/desktop-
# entry creation. The marker is the reliable "installer actually
# completed" signal. Content is the version, for debugging / future
# version-aware logic.
PF_VERSION="$(node -p "require('$SCRIPT_DIR/package.json').version" 2>/dev/null || echo unknown)"
printf '%s\n%s\n' "$PF_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$SCRIPT_DIR/.pf-install-complete" 2>/dev/null || true

if [ "$MODE" = "update" ]; then
  say "Update complete."
  if [ "$ANYTHING_BACKED_UP" = "1" ]; then
    say "Pre-update backup: $BACKUP_DIR"
  fi
else
  say "Install complete."
fi
echo
echo "  Launch:"
case "$UNAME" in
  Darwin) echo "    - Double-click Proto-Familiar.command in Finder";;
  Linux)  echo "    - Search 'Proto-Familiar' in your app launcher, or run ./start.sh";;
  *)      echo "    - ./start.sh";;
esac
echo "  Stop:          ./stop.sh  (or close the launcher window on macOS)"
echo "  Trouble?       see docs/troubleshooting.md"
echo
if [ "$HAVE_DENO" = "0" ]; then
  warn "Reminder: install Deno before first start if you want entity-core enrichment."
fi
if [ "${HAVE_UV:-0}" = "0" ]; then
  warn "Reminder: install uv before first start if you want Unruh (temporal context)."
fi
