#!/usr/bin/env bash
# Install a Proto-Familiar entry into the user's application menu (Linux).
# After running this once, Proto-Familiar appears in your app launcher / activities overview.

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/../.." && pwd )"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_FILE="$APPS_DIR/proto-familiar.desktop"

mkdir -p "$APPS_DIR"

cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Proto-Familiar
Comment=Lightweight LLM frontend
Exec=bash -c "cd '$PROJECT_ROOT' && ./start.sh"
Icon=utilities-terminal
Terminal=false
Categories=Utility;Development;
StartupNotify=false
EOF

chmod +x "$DESKTOP_FILE"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi

echo "Installed: $DESKTOP_FILE"
echo "Proto-Familiar should now appear in your application menu."
echo "(You may need to log out / back in on some desktops for it to show up.)"
