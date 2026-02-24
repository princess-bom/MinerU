#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
MACOS_DIR="$ROOT_DIR/scripts/macos"
APP_NAME="MinerU WebUI Launcher"
APP_DIR="$MACOS_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_BIN_DIR="$CONTENTS_DIR/MacOS"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
ICON_FILE="$MACOS_DIR/MinerUWebUI.icns"
RUN_SCRIPT="$MACOS_DIR/run_mineru_fullstack.command"

if [[ ! -f "$RUN_SCRIPT" ]]; then
  echo "Missing run script: $RUN_SCRIPT" >&2
  exit 1
fi

if [[ ! -f "$ICON_FILE" ]]; then
  "$MACOS_DIR/generate_macos_icon.sh"
fi

rm -rf "$APP_DIR"
mkdir -p "$MACOS_BIN_DIR" "$RESOURCES_DIR"

cat >"$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIconFile</key>
  <string>MinerUWebUI</string>
  <key>CFBundleIdentifier</key>
  <string>net.mineru.webui.launcher</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>MinerU WebUI Launcher</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
</dict>
</plist>
PLIST

cat >"$MACOS_BIN_DIR/launcher" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

MACOS_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
RUN_SCRIPT="$MACOS_DIR/run_mineru_fullstack.command"

if [[ ! -f "$RUN_SCRIPT" ]]; then
  osascript -e 'display dialog "run_mineru_fullstack.command not found." buttons {"OK"} default button "OK" with icon stop'
  exit 1
fi

osascript <<OSA
tell application "Terminal"
  activate
  do script quoted form of "$RUN_SCRIPT"
end tell
OSA
SH

chmod +x "$MACOS_BIN_DIR/launcher"
cp "$ICON_FILE" "$RESOURCES_DIR/MinerUWebUI.icns"

echo "Built app: $APP_DIR"
