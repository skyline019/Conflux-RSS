#!/bin/bash
export PATH="$HOME/.local/node/bin:$PATH"
cd /mnt/e/Astock/rss/ai-powered-rss-aggregator-system
GW=$(ip route | awk '/default/ {print $3; exit}')
export NEWS_PROXY="http://${GW}:10808"
echo "proxy $NEWS_PROXY"
node scripts/probe-news-search.mjs
