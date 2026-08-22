#!/usr/bin/env bash
# Proto-Familiar shutdown (macOS / Linux)
# Stops every `node server.js` whose cwd is this project dir — covers both
# the launcher-tracked PID and any stray instances started outside the
# launcher (e.g. `npm start` from an editor, or a leftover from before a
# port migration that's still listening on 3000).

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PID_FILE="$SCRIPT_DIR/.proto-familiar.pid"
PORT="${PORT:-8742}"

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }

# Collect candidate PIDs: the tracked one, plus every node-server.js
# process whose cwd matches this script's directory.
PIDS=""
if [ -f "$PID_FILE" ]; then
  TRACKED="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$TRACKED" ] && kill -0 "$TRACKED" 2>/dev/null; then
    PIDS="$TRACKED"
  fi
fi
cwd_of() {
  # The cwd of $1, via /proc on Linux or lsof on macOS. Empty if unknown.
  if [ -r "/proc/$1/cwd" ]; then
    readlink "/proc/$1/cwd" 2>/dev/null
  elif command -v lsof >/dev/null 2>&1; then
    lsof -a -d cwd -p "$1" -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}'
  fi
}
add_pid() {
  # Add $1 to PIDS once, if it's rooted in THIS project dir.
  [ "$(cwd_of "$1")" = "$SCRIPT_DIR" ] || return 0
  case " $PIDS " in *" $1 "*) ;; *) PIDS="$PIDS $1" ;; esac
}

# By command name: every `node server.js` rooted here (catches an instance on a
# stray port — e.g. a leftover from before a port migration).
if command -v pgrep >/dev/null 2>&1; then
  for pid in $(pgrep -f "node .*server\.js" 2>/dev/null); do add_pid "$pid"; done
fi

# By PORT OWNER: whoever is LISTENING on our port. This is the signal that does
# NOT depend on a PID file or a command-name match — the macOS double-click
# (Proto-Familiar.command) path and `npm start` both used to leave stop.sh with
# only the fragile pgrep guess, so a running Familiar read as "not found."
# Mirrors ensure-port-free.mjs / stop.bat. Still cwd-verified so we never kill
# an unrelated app that happens to hold the port.
if command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null); do add_pid "$pid"; done
fi

PIDS="$(echo "$PIDS" | xargs)"  # trim
if [ -z "$PIDS" ]; then
  say "No Proto-Familiar process found in $SCRIPT_DIR."
  rm -f "$PID_FILE"
  exit 0
fi

say "Stopping Proto-Familiar (PIDs: $PIDS)..."
# shellcheck disable=SC2086
kill $PIDS 2>/dev/null || true
for _ in $(seq 1 10); do
  ALL_GONE=1
  for pid in $PIDS; do
    if kill -0 "$pid" 2>/dev/null; then ALL_GONE=0; break; fi
  done
  [ "$ALL_GONE" = "1" ] && break
  sleep 0.5
done
for pid in $PIDS; do
  if kill -0 "$pid" 2>/dev/null; then
    say "Forcing shutdown of PID $pid..."
    kill -9 "$pid" 2>/dev/null || true
  fi
done
say "Stopped."
rm -f "$PID_FILE"
