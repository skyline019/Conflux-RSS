#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin"
cd /mnt/e/Astock/rss/ai-powered-rss-aggregator-system
export DATABASE_URL="${DATABASE_URL:-postgresql:///conflux?host=/var/run/postgresql}"
echo "building..."
npx next build
echo BUILD_OK
