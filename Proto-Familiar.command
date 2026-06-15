#!/usr/bin/env bash
# Proto-Familiar - macOS double-click launcher.
# Finder runs .command files in Terminal. Closing the window with Cmd-W (or Ctrl-C, then Cmd-W)
# cleanly shuts everything down because we exec node in the foreground.
#
# Before exec'ing the server we (1) run the installer if deps are
# missing, (2) recycle any stale Proto-Familiar instance holding the
# port so a second double-click doesn't die with EADDRINUSE, and
# (3) prime PATH for uv so spawned MCP children can find it.

set -e
cd "$(dirname "$0")"

PORT="${PORT:-8742}"
URL="http://localhost:$PORT"
# TAILSCALE=1 seeds the in-UI "Access from other devices" toggle to ON when
# .proto-familiar-config.json doesn't exist yet. Once you've used the in-UI
# toggle, that file is the source of truth and this env var is ignored.
export TAILSCALE="${TAILSCALE:-0}"

# First-run install. Check the .pf-install-complete marker (written at
# the end of a successful install) rather than just node_modules:
# node_modules can exist from a manual `npm install` without the
# installer having run, which would leave Phylactery unset up. The
# marker is the reliable "installer actually ran" signal.
if [ ! -f ".pf-install-complete" ] || [ ! -d "node_modules" ]; then
  echo "Installer hasn't completed here yet - running it first..."
  bash ./install.sh
elif [ -f "unruh/pyproject.toml" ] && [ ! -d "unruh/.venv" ]; then
  # Unruh ships in-tree; after a git pull that introduces it, the venv
  # needs to be materialised before Thalamus can connect. Run installer.
  echo "Unruh dependencies missing - running installer..."
  bash ./install.sh
fi

# Prime PATH for uv before exec'ing node — thalamus.js spawns Phylactery
# and Unruh as MCP children via uv. thalamus.js has its own resolver too.
if ! command -v uv >/dev/null 2>&1 && [ -x "$HOME/.local/bin/uv" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

# Recycle any stale Proto-Familiar holding the port — a previous
# double-click that wasn't cleanly closed (Cmd-Q the Terminal window
# without Ctrl-C first, kernel panic recovery, etc) leaves node still
# bound. Same heuristic as start.sh: node server.js rooted at our cwd.
# Use the shared ensure-port-free script to keep the logic one place.
if command -v node >/dev/null 2>&1; then
  if ! PORT="$PORT" node scripts/ensure-port-free.mjs 2>&1; then
    echo
    echo "Couldn't free port $PORT — see message above. Close this window and try again,"
    echo "or close whatever's holding port $PORT (or set PORT=<other>)."
    read -r -p "Press Enter to exit..."
    exit 1
  fi
fi

# Open browser after the server is listening
(
  for i in $(seq 1 30); do
    if (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
      open "$URL" 2>/dev/null || true
      break
    fi
    sleep 0.5
  done
) &

clear
cat <<EOF
========================================
  Proto-Familiar
========================================

  URL:    $URL
  Stop:   press Ctrl-C, then close this window (Cmd-W)
  Help:   docs/troubleshooting.md

  Logs print below. Closing this window
  will shut down Proto-Familiar and its MCP children.

========================================

EOF

PORT="$PORT" TAILSCALE="$TAILSCALE" exec node server.js
