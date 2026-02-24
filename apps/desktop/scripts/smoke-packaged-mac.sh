#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RELEASE_DIR="$DESKTOP_DIR/release"
RUNNER="$SCRIPT_DIR/smoke-unpackaged.cjs"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "smoke-packaged-mac.sh must run on macOS" >&2
  exit 1
fi

if [[ ! -d "$RELEASE_DIR" ]]; then
  echo "Missing release directory: $RELEASE_DIR" >&2
  exit 1
fi

if [[ ! -f "$RUNNER" ]]; then
  echo "Missing smoke runner: $RUNNER" >&2
  exit 1
fi

app_path="$(find "$RELEASE_DIR" -type d -name "*.app" -print -quit)"

mounted=0
mountpoint=""

cleanup() {
  if [[ $mounted -eq 1 && -n "$mountpoint" ]]; then
    hdiutil detach "$mountpoint" >/dev/null 2>&1 || true
    rmdir "$mountpoint" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -z "$app_path" ]]; then
  shopt -s nullglob
  dmg_candidates=("$RELEASE_DIR"/*.dmg)
  shopt -u nullglob

  if [[ ${#dmg_candidates[@]} -eq 0 ]]; then
    echo "No packaged artifact found under $RELEASE_DIR (.app or .dmg required)" >&2
    exit 1
  fi

  dmg_path="${dmg_candidates[0]}"
  mountpoint="$(mktemp -d)"
  hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mountpoint" >/dev/null
  mounted=1

  shopt -s nullglob
  mounted_apps=("$mountpoint"/*.app)
  shopt -u nullglob
  if [[ ${#mounted_apps[@]} -eq 0 ]]; then
    echo "Mounted DMG does not contain an .app bundle: $dmg_path" >&2
    exit 1
  fi
  app_path="${mounted_apps[0]}"
fi

app_name="$(basename "$app_path" .app)"
executable_path="$app_path/Contents/MacOS/$app_name"
if [[ ! -x "$executable_path" ]]; then
  shopt -s nullglob
  macos_bins=("$app_path"/Contents/MacOS/*)
  shopt -u nullglob
  if [[ ${#macos_bins[@]} -eq 0 ]]; then
    echo "No executable found in app bundle: $app_path" >&2
    exit 1
  fi
  executable_path="${macos_bins[0]}"
fi

node "$RUNNER" --mode packaged --label packaged-mac --executable "$executable_path"
