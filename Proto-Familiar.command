#!/usr/bin/env bash
# Proto-Familiar - macOS double-click launcher.
# Finder runs .command files in Terminal. Closing the window with Cmd-W (or Ctrl-C, then Cmd-W)
# cleanly shuts everything down because we exec node in the foreground.

set -e
cd "$(dirname "$0")"

PORT="${PORT:-8742}"
URL="http://localhost:$PORT"
# TAILSCALE=1 seeds the in-UI "Access from other devices" toggle to ON when
# .proto-familiar-config.json doesn't exist yet. Once you've used the in-UI
# toggle, that file is the source of truth and this env var is ignored.
export TAILSCALE="${TAILSCALE:-0}"

# First-run install
if [ ! -d "node_modules" ]; then
  echo "First run - installing dependencies..."
  bash ./install.sh
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
  will shut down Proto-Familiar and entity-core.

========================================

EOF

PORT="$PORT" TAILSCALE="$TAILSCALE" exec node server.js
