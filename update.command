#!/usr/bin/env bash
# Proto-Familiar - macOS double-click updater.
# Finder runs .command files in Terminal; this just runs update.sh and
# keeps the window open so you can read the result.
cd "$(dirname "$0")" || exit 1
bash ./update.sh
echo
read -r -p "Update finished. Press Enter to close this window."
