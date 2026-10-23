#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin"
cd /mnt/e/Astock/rss/ai-powered-rss-aggregator-system
service postgresql start 2>/dev/null || true
# WSL 用本机 peer 鉴权的 conflux 库（.env 里 Windows 用的 postgres/app_db 在此无效）
export DATABASE_URL="${DATABASE_URL:-postgresql:///conflux?host=/var/run/postgresql}"
echo "node=$(command -v node) $(node -v)"
echo "cwd=$(pwd)"
echo "db=conflux(unix-socket)"
# WSL 上无原生 SWC，须用 webpack（禁用 turbopack）
exec npx next dev --webpack --hostname 0.0.0.0 --port 3010
