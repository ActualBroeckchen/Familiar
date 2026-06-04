#!/usr/bin/env bash
# Proto-Familiar one-click updater (macOS / Linux).
#
# For installs made by downloading the ZIP rather than `git clone`: the
# installer can't `git pull` those, so this fetches the latest code from
# GitHub and lays it over the current folder, then runs the installer
# for dependencies + database migrations.
#
# Your data is preserved. settings.json, logs/, saved tomes, Unruh's
# database, and the entity-core sibling folder are NOT part of the
# download, so copying the new files over the old ones can't touch them.
# The installer also auto-backs up tomes/, logs/, settings, and
# entity-core data into .pf-backups/ before doing anything.
#
# If you installed with `git clone`, you don't need this — just re-run
# the installer; it does `git pull` for you.

set -e

DEST="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# BRANCH defaults to `main`. Override to test a feature branch BEFORE
# it lands on main — e.g.:
#   BRANCH=claude/implement-unruh-mechanism-NTpoc bash update.sh
# GitHub's archive endpoint accepts branch names with slashes verbatim;
# the extracted top-level folder is still globbed by `Proto-Familiar-*`.
BRANCH="${BRANCH:-main}"
REPO_TARBALL="https://github.com/ScarletPrinceEury/Proto-Familiar/archive/refs/heads/${BRANCH}.tar.gz"

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

say "Downloading the latest Proto-Familiar…"
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
# repo/branch rename doesn't silently break the updater.
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'Proto-Familiar-*' | head -n 1)"
[ -n "$SRC" ] && [ -f "$SRC/package.json" ] || die "Unexpected archive layout — aborting without changing anything."

# Never copy the updater scripts over themselves: a running script that
# gets overwritten mid-run can misbehave. You keep your current ones.
rm -f "$SRC/update.sh" "$SRC/update.command" "$SRC/update.bat"

say "Applying update — your settings, memories, tomes, and logs are preserved…"
cp -R "$SRC/." "$DEST/" || die "Copy failed."

# Keep the launchers/updaters runnable after the overlay.
chmod +x "$DEST"/*.sh "$DEST"/*.command 2>/dev/null || true

say "Running the installer for dependencies + database migrations…"
# Tell install.sh it's running under the updater so it doesn't print the
# "not a git checkout — run ./update.sh" warning back at us.
PF_FROM_UPDATER=1 bash "$DEST/install.sh"

say "Update complete. Restart Proto-Familiar (./start.sh, or your usual launcher) to use the new version."
