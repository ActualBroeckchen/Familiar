#!/usr/bin/env bash
# Proto-Familiar launcher (macOS / Linux)
# Starts the server (which auto-spawns entity-core via thalamus.js) and opens the UI.

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PORT="${PORT:-8742}"
URL="http://localhost:$PORT"
# TAILSCALE=1 seeds the in-UI "Access from other devices" toggle to ON when
# .proto-familiar-config.json doesn't exist yet. Once you've used the in-UI
# toggle, that file is the source of truth and this env var is ignored.
TAILSCALE="${TAILSCALE:-0}"
PID_FILE="$SCRIPT_DIR/.proto-familiar.pid"
LOG_FILE="$SCRIPT_DIR/.proto-familiar.log"

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }

# thalamus.js spawns `deno` for entity-core. Make sure ~/.deno/bin is on
# PATH even when the user installed Deno via the official script but
# hasn't reloaded their shell — otherwise the spawn fails with ENOENT
# and the identity layer silently doesn't load.
if ! command -v deno >/dev/null 2>&1 && [ -x "$HOME/.deno/bin/deno" ]; then
  export PATH="$HOME/.deno/bin:$PATH"
fi

# Already running?
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  say "Proto-Familiar already running (PID $(cat "$PID_FILE"))."
  say "Opening $URL ..."
else
  if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    say "Dependencies missing. Running installer first..."
    bash "$SCRIPT_DIR/install.sh"
  fi
  say "Starting Proto-Familiar on $URL (logs: $LOG_FILE) ..."
  ( cd "$SCRIPT_DIR" && PORT="$PORT" TAILSCALE="$TAILSCALE" nohup node server.js >"$LOG_FILE" 2>&1 & echo $! >"$PID_FILE" )

  # Wait up to ~15s for the port to come up
  for i in $(seq 1 30); do
    if (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
fi

# Open the browser
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 &
else
  say "Open $URL in your browser."
fi

say "Done. Use ./stop.sh to shut down."
say "Trouble? See docs/troubleshooting.md"
