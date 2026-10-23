#!/bin/bash
set -eu
export PATH="$HOME/.local/node/bin:$PATH"
cd /mnt/e/Astock/rss/ai-powered-rss-aggregator-system
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi
export DATABASE_URL="postgresql://voyagerstar@/conflux?host=/var/run/postgresql"
pid=$(ss -ltnp 'sport = :3010' 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1 || true)
if [ -n "${pid:-}" ]; then kill "$pid" || true; fi
sleep 1
npx next build --webpack
exec npx next start --hostname 0.0.0.0 --port 3010
