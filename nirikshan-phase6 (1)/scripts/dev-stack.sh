#!/usr/bin/env bash
# Starts the local demo stack used by the browser runs: Postgres on 5545, Redis on 6381, API on 4000, web on 3000.
# Usage: scripts/dev-stack.sh up | down | reset   (reset drops and rebuilds the demo database and prints new demo logins to /var/tmp/seed-out.txt)
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; PGD=/var/tmp/nrk-dev; PGBIN=/usr/lib/postgresql/16/bin
export DATABASE_URL=postgres://postgres@127.0.0.1:5545/nrk_dev REDIS_URL=redis://127.0.0.1:6381 STORAGE_LOCAL_DIR=/var/tmp/nrk-dev-uploads ARGON_MEMORY_KIB=1024
down() { pkill -f "[d]ist/main.js"; pkill -f "[n]ext-server"; pkill -f "[n]ext start"; su postgres -c "$PGBIN/pg_ctl -D $PGD/data stop -m fast" >/dev/null 2>&1; redis-cli -p 6381 shutdown nosave >/dev/null 2>&1; true; }
up() {
  if [ ! -d "$PGD/data" ]; then mkdir -p $PGD && chown postgres $PGD && su postgres -c "$PGBIN/initdb -D $PGD/data -A trust >/dev/null"; fi
  rm -f $PGD/data/postmaster.pid
  su postgres -c "$PGBIN/pg_ctl -D $PGD/data -o '-p 5545 -k /tmp' -l $PGD/log -w start" >/dev/null 2>&1
  redis-cli -p 6381 ping >/dev/null 2>&1 || redis-server --port 6381 --daemonize yes >/dev/null
  psql -h 127.0.0.1 -p 5545 -U postgres -tAc "select 1 from pg_database where datname='nrk_dev'" | grep -q 1 || { psql -h 127.0.0.1 -p 5545 -U postgres -c "create database nrk_dev" >/dev/null; (cd "$ROOT/apps/api" && NODE_ENV=development npm run -s migrate >/dev/null && NODE_ENV=development npm run -s seed > /var/tmp/seed-out.txt 2>&1); }
  (cd "$ROOT/apps/api" && NODE_ENV=development setsid nohup node dist/main.js > /var/tmp/api.log 2>&1 < /dev/null &)
  (cd "$ROOT/apps/web" && NODE_ENV=production setsid nohup npx next start -p 3000 > /var/tmp/web.log 2>&1 < /dev/null &)
  for i in $(seq 1 40); do curl -sf localhost:4000/api/v1/public/system >/dev/null && curl -sf -o /dev/null localhost:3000/search && { echo "stack is up"; return 0; }; sleep 1; done; echo "stack did not come up; see /var/tmp/api.log and /var/tmp/web.log"; return 1
}
case "${1:-up}" in
  up) up ;;
  down) down ;;
  reset) down; sleep 1; rm -rf $PGD/data /var/tmp/nrk-dev-uploads; up ;;
  *) echo "usage: $0 up|down|reset"; exit 2 ;;
esac
