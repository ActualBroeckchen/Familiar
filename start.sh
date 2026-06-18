#!/usr/bin/env bash
# Proto-Familiar launcher (macOS / Linux).
#
# Responsibilities, in order:
#   1. Prime PATH so spawned MCP children find uv even when the shell
#      hasn't reloaded after install.
#   2. Detect & recycle any stale Proto-Familiar instance holding the
#      configured port (via PID file + pgrep+cwd-match heuristic).
#   3. Trigger install.sh if node_modules or phylactery/.venv is missing.
#   4. Launch `node server.js` detached, write PID file, open browser.
#
# Stop with ./stop.sh — kills every node server.js rooted here, not
# just the tracked PID. server.js auto-spawns Phylactery (Python via uv)
# and Unruh (Python via uv) as MCP children; both die when server.js does.

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

# thalamus.js spawns uv for Phylactery and Unruh. Astral's installer
# writes to ~/.local/bin by default. thalamus.js has its own resolver
# but PATH-priming here means install.sh below can also find it.
if ! command -v uv >/dev/null 2>&1 && [ -x "$HOME/.local/bin/uv" ]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

# Already running?
EXISTING_PID=""
if [ -f "$PID_FILE" ]; then EXISTING_PID="$(cat "$PID_FILE")"; fi
PID_ALIVE=0
if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then PID_ALIVE=1; fi

PORT_LISTENING=0
if (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then PORT_LISTENING=1; fi

# Find every `node server.js` process whose cwd is THIS project root —
# catches instances launched outside the PID-file flow (e.g. a stray
# `npm start` from an editor terminal, or a leftover from before the
# port migration that's still listening on 3000). Skip the tracked-and-
# healthy PID; everything else gets recycled.
find_stray_pf_pids() {
  command -v pgrep >/dev/null 2>&1 || return 0
  for pid in $(pgrep -f "node .*server\.js" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    cwd=""
    if [ -r "/proc/$pid/cwd" ]; then
      cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"
    elif command -v lsof >/dev/null 2>&1; then
      cwd="$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}')"
    fi
    [ "$cwd" = "$SCRIPT_DIR" ] || continue
    if [ "$pid" = "$EXISTING_PID" ] && [ "$PORT_LISTENING" = "1" ]; then continue; fi
    echo "$pid"
  done
}
STRAY_PIDS="$(find_stray_pf_pids | tr '\n' ' ')"

if [ "$PID_ALIVE" = "1" ] && [ "$PORT_LISTENING" = "1" ] && [ -z "${STRAY_PIDS// /}" ]; then
  say "Proto-Familiar already running (PID $EXISTING_PID) on port $PORT."
  say "Opening $URL ..."
else
  if [ -n "${STRAY_PIDS// /}" ]; then
    say "Killing stray Proto-Familiar processes:${STRAY_PIDS}(leftovers / other ports)"
    # shellcheck disable=SC2086
    kill $STRAY_PIDS 2>/dev/null || true
    sleep 1
    # shellcheck disable=SC2086
    kill -9 $STRAY_PIDS 2>/dev/null || true
  fi
  if [ "$PID_ALIVE" = "1" ]; then
    # Tracked PID is alive but not serving the configured port — e.g. left
    # over from a different PORT value or an older build. Recycle it so the
    # new config actually takes effect.
    say "Found stale Proto-Familiar process (PID $EXISTING_PID) not on port $PORT — restarting."
    kill "$EXISTING_PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$EXISTING_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill -9 "$EXISTING_PID" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  # Trigger the installer if it hasn't completed here. We check the
  # .pf-install-complete marker (written at the end of a successful
  # install) rather than just node_modules, because node_modules can
  # exist without the installer having run — e.g. a manual `npm install`
  # — which would leave the desktop entry
  # uncreated. The marker is the reliable "installer actually ran"
  # signal; node_modules + venv stay as additional triggers in case
  # they get removed after a complete install.
  if [ ! -f "$SCRIPT_DIR/.pf-install-complete" ] || [ ! -d "$SCRIPT_DIR/node_modules" ]; then
    say "Installer hasn't completed here yet. Running it first..."
    bash "$SCRIPT_DIR/install.sh"
  elif [ -f "$SCRIPT_DIR/unruh/pyproject.toml" ] && [ ! -d "$SCRIPT_DIR/unruh/.venv" ]; then
    # Unruh ships in-tree (subdirectory) but its Python venv has to be
    # materialised by uv. After a `git pull` that introduces Unruh, the
    # user hits this branch — silently run the installer so they don't
    # have to know about uv to start the app.
    say "Unruh dependencies missing. Running installer to set them up..."
    bash "$SCRIPT_DIR/install.sh"
  elif [ -f "$SCRIPT_DIR/phylactery/pyproject.toml" ] && [ ! -d "$SCRIPT_DIR/phylactery/.venv" ]; then
    # Same guard for Phylactery's venv. If it was deleted or never
    # materialised (e.g. the .venv dir was cleaned), run the installer
    # rather than booting with Phylactery silently down and the Familiar
    # losing their identity/memories.
    say "Phylactery dependencies missing. Running installer to set them up..."
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
