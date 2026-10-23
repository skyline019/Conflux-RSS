#!/usr/bin/env bash
psql -d conflux -c 'select count(*) as clusters from clusters;'
psql -d conflux -c 'select count(*) as clusters2 from clusters where article_count >= 2;'
curl -s --max-time 30 'http://127.0.0.1:3010/api/clusters' | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d); console.log('clusters', j.clusters?.length, 'bytes', d.length);})"
