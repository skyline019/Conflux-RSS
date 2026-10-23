#!/bin/bash
set -eu
cd "$(dirname "$0")/.."
sed -i 's/\r$//' .env scripts/start.sh scripts/wsl-up.sh 2>/dev/null || true

if ! psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='conflux'" | grep -q 1; then
  createdb conflux
fi
echo "db_ready"

NODE_HOME="$HOME/.local/node"
if [ ! -x "$NODE_HOME/bin/node" ]; then
  mkdir -p "$HOME/.local"
  VER="v22.20.0"
  URL="https://nodejs.org/dist/${VER}/node-${VER}-linux-x64.tar.xz"
  curl -fL --retry 3 -o /tmp/node.tar.xz "$URL" || {
    VER="v22.19.0"
    URL="https://nodejs.org/dist/${VER}/node-${VER}-linux-x64.tar.xz"
    curl -fL --retry 3 -o /tmp/node.tar.xz "$URL"
  }
  rm -rf "$HOME/.local/node-${VER}-linux-x64"
  tar -xJf /tmp/node.tar.xz -C "$HOME/.local"
  rm -rf "$NODE_HOME"
  mv "$HOME/.local/node-${VER}-linux-x64" "$NODE_HOME"
fi
export PATH="$NODE_HOME/bin:$PATH"
node -v
npm -v

set -a
. ./.env
set +a
export DATABASE_URL="postgresql://voyagerstar@/conflux?host=/var/run/postgresql"

npm install
npm run build
npx drizzle-kit push --force
exec npx next start --hostname 0.0.0.0 --port 3010
