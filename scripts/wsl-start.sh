#!/usr/bin/env bash
# 稳定模式：production start（避免 Windows→WSL 转发时 HMR 触发
# "Router action dispatched before initialization" 导致卡在启动页）
set -euo pipefail
export PATH="$HOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin"
cd /mnt/e/Astock/rss/ai-powered-rss-aggregator-system
service postgresql start 2>/dev/null || true
export DATABASE_URL="${DATABASE_URL:-postgresql:///conflux?host=/var/run/postgresql}"
export NODE_ENV=production
echo "node=$(command -v node) $(node -v)"
echo "db=conflux(unix-socket) mode=production"
if [[ ! -f .next/BUILD_ID ]]; then
  echo "building..."
  npx next build
fi
exec npx next start --hostname 0.0.0.0 --port 3010
