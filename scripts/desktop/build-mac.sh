#!/usr/bin/env bash

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ $# -gt 0 ]]; then
  echo "Unknown argument: $1" >&2
  echo "Usage: bash scripts/desktop/build-mac.sh [--dry-run]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DESKTOP_DIR="$ROOT_DIR/apps/desktop"
OUTPUT_DIR="$DESKTOP_DIR/release"
MANIFEST_DIR="$ROOT_DIR/dist"
MANIFEST_PATH="$MANIFEST_DIR/manifest.json"
VERSION="$(node -p "require(process.argv[1]).version" "$DESKTOP_DIR/package.json")"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "[dry-run] Would execute: npm --prefix \"$DESKTOP_DIR\" run build:mac"
  echo "[dry-run] Expected artifact pattern: $OUTPUT_DIR/*.dmg"
  echo "[dry-run] Would write manifest to: $MANIFEST_PATH"
  echo "[dry-run] Manifest preview:"
  cat <<EOF
{
  "version": "$VERSION",
  "generatedAt": "<ISO-8601>",
  "artifacts": [
    {
      "platform": "mac",
      "filename": "<artifact>.dmg",
      "sha256": "<sha256>"
    }
  ]
}
EOF
  exit 0
fi

npm --prefix "$DESKTOP_DIR" run build:mac

shopt -s nullglob
artifacts=("$OUTPUT_DIR"/*.dmg)
shopt -u nullglob

if [[ ${#artifacts[@]} -eq 0 ]]; then
  echo "No mac artifact found in $OUTPUT_DIR (expected at least one .dmg)." >&2
  exit 1
fi

entries=()
for artifact in "${artifacts[@]}"; do
  digest_line="$(shasum -a 256 "$artifact")"
  digest="${digest_line%% *}"
  file_name="$(basename "$artifact")"
  entries+=("$file_name:$digest")
done

mkdir -p "$MANIFEST_DIR"

node - "$MANIFEST_PATH" "$VERSION" "mac" "${entries[@]}" <<'EOF'
const fs = require('fs');

const [, , manifestPath, version, platform, ...entries] = process.argv;

const artifactsForPlatform = entries.map((entry) => {
  const splitIndex = entry.lastIndexOf(':');
  if (splitIndex === -1) {
    throw new Error(`Invalid artifact entry: ${entry}`);
  }

  return {
    platform,
    filename: entry.slice(0, splitIndex),
    sha256: entry.slice(splitIndex + 1),
  };
});

let existing = { artifacts: [] };
if (fs.existsSync(manifestPath)) {
  existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

const preserved = Array.isArray(existing.artifacts)
  ? existing.artifacts.filter((artifact) => artifact.platform !== platform)
  : [];

const manifest = {
  version,
  generatedAt: new Date().toISOString(),
  artifacts: [...preserved, ...artifactsForPlatform],
};

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
EOF

echo "Manifest written: $MANIFEST_PATH"
