#!/bin/sh
set -eu
npx drizzle-kit push --force
exec npx next start --hostname 0.0.0.0 --port 3000
