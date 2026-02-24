#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE_PNG="${1:-$ROOT_DIR/docs/images/logo.png}"
OUT_DIR="$ROOT_DIR/scripts/macos"
ICONSET_DIR="$OUT_DIR/MinerUWebUI.iconset"
OUTPUT_ICNS="$OUT_DIR/MinerUWebUI.icns"

if [[ ! -f "$SOURCE_PNG" ]]; then
  echo "Source image not found: $SOURCE_PNG" >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1; then
  echo "sips is required on macOS." >&2
  exit 1
fi

if ! command -v iconutil >/dev/null 2>&1; then
  echo "iconutil is required on macOS." >&2
  exit 1
fi

mkdir -p "$ICONSET_DIR"

create_png() {
  local size="$1"
  local name="$2"
  sips -z "$size" "$size" "$SOURCE_PNG" --out "$ICONSET_DIR/$name" >/dev/null
}

create_png 16 icon_16x16.png
create_png 32 icon_16x16@2x.png
create_png 32 icon_32x32.png
create_png 64 icon_32x32@2x.png
create_png 128 icon_128x128.png
create_png 256 icon_128x128@2x.png
create_png 256 icon_256x256.png
create_png 512 icon_256x256@2x.png
create_png 512 icon_512x512.png
create_png 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET_DIR" -o "$OUTPUT_ICNS"
rm -rf "$ICONSET_DIR"

echo "Generated: $OUTPUT_ICNS"
