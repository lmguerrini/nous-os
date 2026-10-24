#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
APP_DIR="${NOUSOS_MENU_APP_DIR:-$HOME/Applications}"
APP="build/NousOS Menu.app"
mkdir -p "$APP/Contents/MacOS"
swiftc -module-cache-path /tmp/nousos-swift-module-cache -O -framework AppKit -framework UserNotifications StateClassifier.swift App.swift -o "$APP/Contents/MacOS/NousOSMenu"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>NousOSMenu</string>
<key>CFBundleIdentifier</key><string>com.nousos.menubar</string>
<key>CFBundleName</key><string>NousOS Menu</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST
plutil -lint "$APP/Contents/Info.plist"
cat > "build/com.nousos.menubar.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.nousos.menubar</string>
<key>ProgramArguments</key><array><string>$APP_DIR/NousOS Menu.app/Contents/MacOS/NousOSMenu</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>Crashed</key><true/></dict>
</dict></plist>
PLIST
plutil -lint "build/com.nousos.menubar.plist"
codesign --force --deep --sign - "$APP"
