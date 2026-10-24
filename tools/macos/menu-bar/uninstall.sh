#!/bin/bash
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.nousos.menubar.plist"
/bin/launchctl bootout "gui/$(id -u)/com.nousos.menubar" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$HOME/Applications/NousOS Menu.app"
