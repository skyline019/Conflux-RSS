#!/usr/bin/env bash
set -euo pipefail
for p in /api/bootstrap /api/feeds /api/settings /api/collections /api/clusters; do
  code=$(curl -s -o /tmp/boot.json -w "%{http_code}" --max-time 120 "http://127.0.0.1:3010$p" || echo FAIL)
  echo "$p -> $code t=$(wc -c </tmp/boot.json 2>/dev/null || echo 0)"
  head -c 180 /tmp/boot.json 2>/dev/null; echo
done
