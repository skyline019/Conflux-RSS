#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin"
cd /mnt/e/Astock/rss/ai-powered-rss-aggregator-system
echo "installing linux natives..."
npm install lightningcss-linux-x64-gnu@1.33.0 @next/swc-linux-x64-gnu --no-save
ls -la node_modules/lightningcss-linux-x64-gnu 2>/dev/null | head -5 || true
ls -la node_modules/@next/swc-linux-x64-gnu 2>/dev/null | head -5 || true
echo DONE
