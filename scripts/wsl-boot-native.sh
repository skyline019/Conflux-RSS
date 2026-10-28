#!/usr/bin/env bash
# Sync needed sources to Linux FS, build, start :3010 (pair with Windows npm run forward).
set -euo pipefail
# Windows wsl.exe injects HOME=C:\Users\... — force Linux home
if [[ "${HOME:-}" != /home/* ]]; then
  HOME=$(getent passwd "$(id -un)" | cut -d: -f6)
  export HOME
fi
export PATH="$HOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin"
SRC=/mnt/e/Astock/rss/ai-powered-rss-aggregator-system
DST="${CONFLUX_HOME:-$HOME/conflux-app}"

start_pg() {
  if pg_isready -q 2>/dev/null; then return 0; fi
  if [[ -n "${SUDO_PASS:-}" ]]; then
    printf '%s\n' "$SUDO_PASS" | sudo -S service postgresql start >/dev/null
  else
    service postgresql start 2>/dev/null || true
  fi
  pg_isready -q
}

start_pg || { echo "postgres not ready"; exit 1; }

mkdir -p "$DST"
echo "sync (selective) -> $DST"
# 只同步运行所需目录/文件，避免 /mnt/e 全量 rsync 卡死
rsync -a --delete \
  --include './' \
  --include 'src/***' \
  --include 'app/***' \
  --include 'public/***' \
  --include 'scripts/***' \
  --include 'drizzle/***' \
  --include 'package.json' \
  --include 'package-lock.json' \
  --include 'next.config.*' \
  --include 'tsconfig*.json' \
  --include 'postcss.config.*' \
  --include 'tailwind.config.*' \
  --include 'drizzle.config.*' \
  --include 'components.json' \
  --include '.env' \
  --include 'middleware.ts' \
  --include 'next-env.d.ts' \
  --exclude '*' \
  "$SRC/" "$DST/"

cd "$DST"
if [[ ! -d node_modules/next ]]; then
  echo "npm install..."
  npm install --prefer-offline --no-audit --no-fund
fi
if [[ ! -d node_modules/@next/swc-linux-x64-gnu ]]; then
  npm install @next/swc-linux-x64-gnu --no-save --no-audit --no-fund || true
fi

export DATABASE_URL="${DATABASE_URL:-postgresql:///conflux?host=/var/run/postgresql}"
export NODE_ENV=production
echo "node=$(command -v node) $(node -v) cwd=$(pwd)"

if [[ ! -f .next/BUILD_ID ]] || [[ "${FORCE_BUILD:-1}" == "1" ]]; then
  echo "building..."
  npx next build
  echo BUILD_OK
fi

echo "starting on 0.0.0.0:3010"
exec npx next start --hostname 0.0.0.0 --port 3010
