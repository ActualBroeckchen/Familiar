#!/usr/bin/env bash
# Familiar one-click updater (macOS / Linux).
#
# For installs made by downloading the ZIP rather than `git clone`: the
# installer can't `git pull` those, so this fetches the latest code from
# GitHub and lays it over the current folder, then runs the installer
# for dependencies + database migrations.
#
# Your data is preserved. settings.json, logs/, saved tomes, and the
# Unruh + Phylactery databases are NOT part of the download, so copying
# the new files over the old ones can't touch them. The installer also
# auto-backs up tomes/, logs/, settings, and phylactery/data/ into
# .pf-backups/ before doing anything.
#
# If you installed with `git clone`, you don't need this — just re-run
# the installer; it does `git pull` for you.

set -e

DEST="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# BRANCH defaults to `main`. Override to test a feature branch BEFORE
# it lands on main — e.g.:
#   BRANCH=my-feature-branch bash update.sh
# GitHub's archive endpoint accepts branch names with slashes verbatim;
# the extracted top-level folder name may vary, so we locate it by searching for package.json below.
BRANCH="${BRANCH:-main}"
REPO_SLUG="ActualBroeckchen/Familiar"
REPO_TARBALL="https://github.com/${REPO_SLUG}/archive/refs/heads/${BRANCH}.tar.gz"

say() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mXX %s\033[0m\n' "$*"; exit 1; }

# If this IS a git checkout, the installer's git pull is the right path —
# steer the user there rather than overlaying files on top of git.
if [ -d "$DEST/.git" ]; then
  say "This is a git checkout — just run ./install.sh; it updates via git pull."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ "$BRANCH" != "main" ]; then
  say "Updating from branch '$BRANCH' (non-default — pass BRANCH=main to switch back)."
fi

say "Downloading the latest Familiar…"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$REPO_TARBALL" -o "$TMP/pf.tar.gz" || die "Download failed — check your internet connection."
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP/pf.tar.gz" "$REPO_TARBALL" || die "Download failed — check your internet connection."
else
  die "Need curl or wget to download. Install one and re-run."
fi

say "Extracting…"
tar -xzf "$TMP/pf.tar.gz" -C "$TMP" || die "Could not extract the download."
# Find the extracted top-level dir rather than hardcoding the name, so a
# repo/branch rename (or a differently-named fork) doesn't silently break
# the updater — any top-level dir carrying a package.json is it.
SRC="$(find "$TMP" -maxdepth 2 -name package.json -not -path "$TMP/package.json" | head -n 1 | xargs -r dirname)"
[ -n "$SRC" ] && [ -f "$SRC/package.json" ] || die "Unexpected archive layout — aborting without changing anything."

# Update the updater scripts too — but SAFELY. An in-place `cp` truncates and
# rewrites the very file this process is reading, which can corrupt the run.
# Rename-into-place instead (atomic): the running script keeps its open handle
# to the old inode and finishes cleanly, while the NEXT run picks up the new
# one. Without this the updater could never update ITSELF, so an improvement
# here (like this restart step) would never reach an existing download install.
for f in update.sh update.command update.bat; do
  if [ -f "$SRC/$f" ]; then
    cp "$SRC/$f" "$DEST/$f.pfnew" 2>/dev/null && mv -f "$DEST/$f.pfnew" "$DEST/$f" 2>/dev/null && chmod +x "$DEST/$f" 2>/dev/null || true
  fi
done
# Drop them from the source so the bulk overlay below can't re-copy (and
# truncate) the script we're currently running.
rm -f "$SRC/update.sh" "$SRC/update.command" "$SRC/update.bat"

# Is a server currently running? Capture this BEFORE we overlay files, so we
# know whether to restart afterwards. A live server keeps running the OLD code
# even after the files change — it read the version + parsers at boot — so the
# browser shows the new static UI while every server-side feature stays old.
# That reads as "the update did nothing / still on the old version", and is the
# exact failure this restart fixes.
PORT="${PORT:-8742}"
WAS_RUNNING=0
if (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then WAS_RUNNING=1; fi

say "Applying update — your settings, memories, tomes, and logs are preserved…"
cp -R "$SRC/." "$DEST/" || die "Copy failed."

# Keep the launchers/updaters runnable after the overlay.
chmod +x "$DEST"/*.sh "$DEST"/*.command 2>/dev/null || true

say "Running the installer for dependencies + database migrations…"
# Tell install.sh it's running under the updater so it doesn't print the
# "not a git checkout — run ./update.sh" warning back at us.
PF_FROM_UPDATER=1 bash "$DEST/install.sh"

# Restart the running server so the new code actually takes effect. Without
# this, the update silently leaves the old process serving old code (old
# version badge, old import parser, missing new endpoints) even though the
# files on disk are new. stop.sh is a no-op if nothing is running; start.sh
# launches a fresh detached server and reopens the browser on the new version.
# Guarded so a hiccup here still reaches a clear final message.
if [ "$WAS_RUNNING" = "1" ]; then
  say "Restarting Familiar so the new version takes effect…"
  bash "$DEST/stop.sh" || true
  if PORT="$PORT" bash "$DEST/start.sh"; then
    say "Update complete — Familiar restarted on the new version. Reload the browser tab if it doesn't refresh on its own."
  else
    say "Update applied, but the automatic restart hit a snag. Run ./stop.sh then ./start.sh (or your usual launcher) to finish."
  fi
else
  say "Update complete. Start Familiar (./start.sh, or your usual launcher) to use the new version."
fi
