#!/usr/bin/env bash
# /mnt/e 上 next dev --webpack 会卡在 Compiling（9p I/O），实测不可用。
# 转发场景请用 scripts/wsl-start.sh（production）+ Windows: npm run forward
set -euo pipefail
exec "$(dirname "$0")/wsl-start.sh"
