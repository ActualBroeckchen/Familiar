#!/usr/bin/env bash
# Proto-Familiar installer (macOS / Linux)
# Installs Node dependencies and clones entity-core-alpha as a sibling directory.

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PARENT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
ENTITY_CORE_DIR="$PARENT_DIR/entity-core-alpha"
ENTITY_CORE_REPO="https://github.com/PsycherosAI/Psycheros.git"
ENTITY_CORE_TAG="entity-core-v0.2.2"

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mXX %s\033[0m\n' "$*"; exit 1; }

say "Proto-Familiar installer"
say "Working dir: $SCRIPT_DIR"

# --- Node.js check ---
if ! command -v node >/dev/null 2>&1; then
  die "Node.js is not installed. Install Node 18+ from https://nodejs.org/ and re-run."
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node.js $NODE_MAJOR detected. Proto-Familiar needs Node 18 or newer."
fi
say "Node.js $(node -v) found."

# --- Deno check (optional) ---
if command -v deno >/dev/null 2>&1; then
  say "Deno $(deno --version | head -n1) found."
  HAVE_DENO=1
else
  warn "Deno not found. entity-core needs Deno 2+; install from https://deno.com/ if you want the identity layer."
  HAVE_DENO=0
fi

# --- npm install ---
say "Installing Proto-Familiar dependencies (npm install)..."
( cd "$SCRIPT_DIR" && npm install )

# --- entity-core clone ---
if [ -d "$ENTITY_CORE_DIR" ]; then
  say "entity-core-alpha already present at $ENTITY_CORE_DIR — skipping clone."
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

# --- Platform-specific launcher polish ---
UNAME="$(uname -s 2>/dev/null || echo unknown)"
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

say "Install complete."
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
