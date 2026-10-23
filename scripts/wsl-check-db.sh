#!/usr/bin/env bash
set -euo pipefail
psql -d conflux -c '\dt'
psql -d conflux -c 'select count(*) as feeds from feeds;'
psql -d conflux -c 'select count(*) as articles from articles;'
# test connection string node-pg would use
export PATH="$HOME/.local/node/bin:/usr/bin:$PATH"
node -e "
const { Pool } = require('pg');
const urls = [
  'postgresql:///conflux?host=/var/run/postgresql',
  'postgresql://voyagerstar@127.0.0.1:5432/conflux',
];
(async () => {
  for (const u of urls) {
    try {
      const p = new Pool({ connectionString: u });
      const r = await p.query('select count(*)::int n from feeds');
      console.log('OK', u, 'feeds=', r.rows[0].n);
      await p.end();
    } catch (e) {
      console.log('FAIL', u, e.message);
    }
  }
})();
"
