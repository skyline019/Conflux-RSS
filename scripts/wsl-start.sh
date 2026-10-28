#!/usr/bin/env bash
# 稳定模式：production start（避免 Windows→WSL 转发时 HMR 触发
# "Router action dispatched before initialization" 导致卡在启动页）
# 在 ~/conflux-app（Linux 本地盘）跑，避免 /mnt/e 9p I/O 卡死编译。
set -euo pipefail
if [[ "${HOME:-}" != /home/* ]]; then
  HOME=$(getent passwd "$(id -un)" | cut -d: -f6)
  export HOME
fi
export PATH="$HOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin"
SRC=/mnt/e/Astock/rss/ai-powered-rss-aggregator-system
DST=${CONFLUX_HOME:-$HOME/conflux-app}
if ! pg_isready -q 2>/dev/null; then
  if [[ -n "${SUDO_PASS:-}" ]]; then
    printf '%s\n' "$SUDO_PASS" | sudo -S service postgresql start >/dev/null 2>&1 || true
  else
    service postgresql start 2>/dev/null || true
  fi
fi
mkdir -p "$DST"
if [[ "${SKIP_SYNC:-}" != "1" ]]; then
  rsync -a --delete \
    --exclude node_modules --exclude .next --exclude .git \
    --exclude mobile/node_modules --exclude mobile/.expo \
    --exclude "*.log" --exclude .turbo \
    "$SRC/" "$DST/"
fi
cd "$DST"
if [[ ! -d node_modules/next ]]; then
  npm install --prefer-offline --no-audit --no-fund
fi
export DATABASE_URL="${DATABASE_URL:-postgresql:///conflux?host=/var/run/postgresql}"
export NODE_ENV=production
echo "node=$(command -v node) $(node -v)"
echo "cwd=$(pwd)"
echo "db=conflux(unix-socket) mode=production"
if [[ ! -f .next/BUILD_ID ]] || [[ "${FORCE_BUILD:-}" == "1" ]]; then
  echo "building..."
  npx next build
fi
exec npx next start --hostname 0.0.0.0 --port 3010
