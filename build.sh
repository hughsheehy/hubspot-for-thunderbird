#!/usr/bin/env bash
# Build the .xpi package for HubSpot for Thunderbird.
#
# Usage: ./build.sh
# Produces: dist/hubspot-for-thunderbird-<version>.xpi

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

NAME="hubspot-for-thunderbird"
VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
DIST_DIR="dist"
OUT_FILE="${DIST_DIR}/${NAME}-${VERSION}.xpi"

FILES=(
  manifest.json
  background.js
  popup
  compose
  options
  icons
  _locales
  LICENSE
  PRIVACY.md
)

for f in "${FILES[@]}"; do
  if [ ! -e "$f" ]; then
    echo "error: expected file/dir '$f' not found" >&2
    exit 1
  fi
done

mkdir -p "$DIST_DIR"
rm -f "$OUT_FILE"

# zip -X: no extra file attributes (reproducible-ish); -r: recurse.
zip -X -r -q "$OUT_FILE" "${FILES[@]}" -x '*.DS_Store'

echo "Built $OUT_FILE"
