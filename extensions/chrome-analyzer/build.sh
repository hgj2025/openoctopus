#!/usr/bin/env bash
set -euo pipefail

DEST=~/Downloads/ai-page-analyzer
NODE=~/.nvm/versions/node/v22.20.0/bin/node
WXT=node_modules/wxt/bin/wxt.mjs

cd "$(dirname "$0")"

echo "Building..."
"$NODE" "$WXT" build

rm -rf "$DEST"
cp -r .output/chrome-mv3 "$DEST"

echo "Done → $DEST"
