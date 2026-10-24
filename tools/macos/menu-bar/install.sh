#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
KIT_PATH="$(cd ../connector && pwd)/nousos-tunnel.sh"
./build.sh
mkdir -p "$HOME/Applications" "$HOME/Library/LaunchAgents"
rm -rf "$HOME/Applications/NousOS Menu.app"
ditto "build/NousOS Menu.app" "$HOME/Applications/NousOS Menu.app"
cat > "$HOME/Library/LaunchAgents/com.nousos.menubar.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.nousos.menubar</string>
<key>ProgramArguments</key><array><string>$HOME/Applications/NousOS Menu.app/Contents/MacOS/NousOSMenu</string></array>
<key>EnvironmentVariables</key><dict><key>NOUSOS_TUNNEL_KIT</key><string>$KIT_PATH</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
</dict></plist>
PLIST
plutil -lint "$HOME/Library/LaunchAgents/com.nousos.menubar.plist"
