#!/bin/bash
set -e
echo "== health =="
curl -s -m 15 http://127.0.0.1:3010/api/health
echo
echo "== media proxy range =="
curl -s -m 40 -D /tmp/mh.txt -o /tmp/m.bin -H 'Range: bytes=0-64' \
  'http://127.0.0.1:3010/api/proxy/media?url=https%3A%2F%2Fcommondatastorage.googleapis.com%2Fgtv-videos-bucket%2Fsample%2FForBiggerBlazes.mp4'
head -20 /tmp/mh.txt
wc -c /tmp/m.bin
echo
echo "== parse dailymotion =="
curl -s -m 15 -X POST http://127.0.0.1:3010/api/media/parse \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.dailymotion.com/video/x8abcdef"}'
echo
echo "== parse soundcloud =="
curl -s -m 15 -X POST http://127.0.0.1:3010/api/media/parse \
  -H 'content-type: application/json' \
  -d '{"url":"https://soundcloud.com/forss/flickermood"}'
echo
