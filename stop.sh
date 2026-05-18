#!/usr/bin/env bash
# Proto-Familiar shutdown (macOS / Linux)
# Stops every `node server.js` whose cwd is this project dir — covers both
# the launcher-tracked PID and any stray instances started outside the
# launcher (e.g. `npm start` from an editor, or a leftover from before a
# port migration that's still listening on 3000).

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PID_FILE="$SCRIPT_DIR/.proto-familiar.pid"

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
if command -v pgrep >/dev/null 2>&1; then
  for pid in $(pgrep -f "node .*server\.js" 2>/dev/null); do
    cwd=""
    if [ -r "/proc/$pid/cwd" ]; then
      cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"
    elif command -v lsof >/dev/null 2>&1; then
      cwd="$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}')"
    fi
    [ "$cwd" = "$SCRIPT_DIR" ] || continue
    case " $PIDS " in
      *" $pid "*) ;;
      *) PIDS="$PIDS $pid" ;;
    esac
  done
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
