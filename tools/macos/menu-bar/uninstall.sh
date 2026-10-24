#!/bin/bash
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.nousos.menubar.plist"
APP_DIR="${NOUSOS_MENU_APP_DIR:-$HOME/Applications}"
/bin/launchctl bootout "gui/$(id -u)/com.nousos.menubar" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$APP_DIR/NousOS Menu.app"
