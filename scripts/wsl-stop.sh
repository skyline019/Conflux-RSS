#!/usr/bin/env bash
ss -ltnp 2>/dev/null | sed -n 's/.*pid=\([0-9]*\).*3010.*/\1/p' | sort -u | while read -r p; do
  [ -n "$p" ] && kill "$p" 2>/dev/null || true
done
pkill -f "next/dist/bin/next" 2>/dev/null || true
sleep 1
ss -ltnp 2>/dev/null | grep 3010 || echo FREE
