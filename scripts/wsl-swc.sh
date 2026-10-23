#!/bin/bash
set -eu
export PATH="$HOME/.local/node/bin:$PATH"
cd /mnt/e/Astock/rss/ai-powered-rss-aggregator-system
npm install @next/swc-linux-x64-gnu@16.2.6 --no-save --no-fund --no-audit
