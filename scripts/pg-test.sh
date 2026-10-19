#!/usr/bin/env bash
# Starts a throwaway local PostgreSQL (16) cluster for tests/db/*.test.ts.
# Usage: scripts/pg-test.sh start|stop   → exports TEST_DATABASE_URL hint.
set -euo pipefail
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
DIR=${PGTEST_DIR:-/tmp/aura-pgtest}
PORT=${PGTEST_PORT:-54329}
RUN_AS=""
if [ "$(id -u)" = "0" ]; then RUN_AS="runuser -u postgres --"; fi
case "${1:-start}" in
  start)
    if [ ! -d "$DIR/data" ]; then
      mkdir -p "$DIR" && chown -R postgres "$DIR" 2>/dev/null || true
      $RUN_AS "$PGBIN/initdb" -D "$DIR/data" -U postgres --auth=trust >/dev/null
    fi
    $RUN_AS "$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/log" -w start >/dev/null
    echo "TEST_DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/postgres"
    ;;
  stop)
    $RUN_AS "$PGBIN/pg_ctl" -D "$DIR/data" -m fast stop >/dev/null || true
    ;;
esac
