#!/usr/bin/env bash
# Proto-Familiar installer (macOS / Linux)
#
# Fresh install: installs Node deps, auto-installs Deno (if missing),
#   clones entity-core-alpha as a sibling directory, pre-caches its Deno
#   module graph, and registers a desktop entry on Linux.
#
# Update mode: triggered automatically when node_modules/ already exists.
#   Pulls latest Proto-Familiar (git pull --ff-only), refreshes
#   entity-core to the pinned tag, re-runs the idempotent npm install
#   and deno cache. Re-runs Node/Deno checks (and auto-install if needed)
#   so the system catches up to new requirements too.
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
ENTITY_CORE_DIR="$PARENT_DIR/entity-core-alpha"
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
  for src in \
    "$SCRIPT_DIR/tomes" \
    "$SCRIPT_DIR/logs" \
    "$ENTITY_CORE_DIR/packages/entity-core/data" \
    "$ENTITY_CORE_DIR/data"; do
    if [ -d "$src" ] && [ -n "$(ls -A "$src" 2>/dev/null)" ]; then
      mkdir -p "$BACKUP_DIR"
      rel="$(echo "$src" | sed "s|^$PARENT_DIR/||")"
      dest="$BACKUP_DIR/$rel"
      mkdir -p "$(dirname "$dest")"
      cp -a "$src" "$dest"
      ANYTHING_BACKED_UP=1
    fi
  done
  if [ "$ANYTHING_BACKED_UP" = "1" ]; then
    say "User data backed up to $BACKUP_DIR/"
    say "  (tomes/, logs/, entity-core data/ — restore by copying back if needed)"
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
    say "Refreshing entity-core-alpha to tag $ENTITY_CORE_TAG..."
    if ! ( cd "$ENTITY_CORE_DIR" && git fetch --tags --depth 1 origin "refs/tags/$ENTITY_CORE_TAG:refs/tags/$ENTITY_CORE_TAG" 2>/dev/null && git checkout --quiet "$ENTITY_CORE_TAG" ); then
      warn "Could not refresh entity-core to $ENTITY_CORE_TAG (local changes or network). Keeping current checkout."
    fi
  else
    say "entity-core-alpha already present at $ENTITY_CORE_DIR — skipping clone."
  fi
else
  if command -v git >/dev/null 2>&1; then
    say "Cloning entity-core-alpha into $ENTITY_CORE_DIR ..."
    if git clone --depth 1 --branch "$ENTITY_CORE_TAG" "$ENTITY_CORE_REPO" "$ENTITY_CORE_DIR"; then
      say "entity-core-alpha cloned at tag $ENTITY_CORE_TAG."
    else
      warn "Tag clone failed; falling back to default branch."
      git clone --depth 1 "$ENTITY_CORE_REPO" "$ENTITY_CORE_DIR" || warn "Clone failed. You can clone it manually later."
    fi
  else
    warn "git not found — skipping entity-core clone. Install git or place entity-core-alpha at $ENTITY_CORE_DIR manually."
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

# --- Platform-specific launcher polish (install mode only) --------------
# In update mode, the desktop entry / launcher already exists. Re-running
# the desktop-entry script is harmless but adds noise; skip for clarity.
UNAME="$(uname -s 2>/dev/null || echo unknown)"
if [ "$MODE" = "install" ]; then
  case "$UNAME" in
    Linux)
      if [ -f "$SCRIPT_DIR/scripts/linux/install-desktop-entry.sh" ]; then
        say "Installing application-menu entry..."
        bash "$SCRIPT_DIR/scripts/linux/install-desktop-entry.sh" || warn "Desktop entry install failed (non-fatal)."
      fi
      ;;
    Darwin)
      if [ -f "$SCRIPT_DIR/Proto-Familiar.command" ]; then
        chmod +x "$SCRIPT_DIR/Proto-Familiar.command" || true
        say "macOS launcher ready: double-click Proto-Familiar.command in Finder."
      fi
      ;;
  esac
fi

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
echo "  Stop:   ./stop.sh  (or close the launcher window on macOS)"
echo
if [ "$HAVE_DENO" = "0" ]; then
  warn "Reminder: install Deno before first start if you want entity-core enrichment."
fi
