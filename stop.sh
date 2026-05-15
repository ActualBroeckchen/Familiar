#!/usr/bin/env bash
# Proto-Familiar shutdown (macOS / Linux)
# Stops the server (which also terminates the spawned entity-core child process).

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PID_FILE="$SCRIPT_DIR/.proto-familiar.pid"

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }

if [ ! -f "$PID_FILE" ]; then
  say "No PID file found — Proto-Familiar does not appear to be running."
  exit 0
fi

PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  say "Stopping Proto-Familiar (PID $PID)..."
  kill "$PID" 2>/dev/null || true
  # Give it up to 5s to exit cleanly, then SIGKILL
  for i in $(seq 1 10); do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi
    sleep 0.5
  done
  if kill -0 "$PID" 2>/dev/null; then
    say "Forcing shutdown..."
    kill -9 "$PID" 2>/dev/null || true
  fi
  say "Stopped."
else
  say "Process $PID is not running."
fi

rm -f "$PID_FILE"
