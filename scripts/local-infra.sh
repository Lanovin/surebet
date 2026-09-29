#!/usr/bin/env bash
# Lokální Postgres 16 + TimescaleDB + Redis 7 bez Dockeru a bez rootu.
# Balíčky se stáhnou přes `apt-get download` a rozbalí do .infra/root.
#   scripts/local-infra.sh setup|start|stop|status|psql
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INFRA="$ROOT_DIR/.infra"
PREFIX="$INFRA/root"
PGBIN="$PREFIX/usr/lib/postgresql/16/bin"
PGDATA="$INFRA/pgdata"
REDIS_DIR="$INFRA/redis"
PGPORT="${PGPORT:-5432}"
REDIS_PORT="${REDIS_PORT:-6379}"
export LD_LIBRARY_PATH="$PREFIX/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"

TSDB_REPO="https://packagecloud.io/timescale/timescaledb/ubuntu"

setup() {
  mkdir -p "$INFRA/debs" "$PREFIX"
  cd "$INFRA/debs"
  apt-get download postgresql-16 postgresql-client-16 libpq5 redis-server redis-tools libjemalloc2 liblzf1
  curl -fsSL "$TSDB_REPO/dists/noble/main/binary-amd64/Packages.gz" -o "$INFRA/tsdb-packages.gz"
  for pkg in timescaledb-2-loader-postgresql-16 timescaledb-2-postgresql-16; do
    f=$(zcat "$INFRA/tsdb-packages.gz" | awk -v P="$pkg" '$0=="Package: "P{p=1} p&&/^Filename:/{f=$2} /^$/{p=0} END{print f}')
    curl -fsSL -o "$(basename "$f")" "$TSDB_REPO/$f"
  done
  for f in "$INFRA"/debs/*.deb; do dpkg -x "$f" "$PREFIX"; done
  echo "setup hotov: $PREFIX"
}

init_pg() {
  [ -f "$PGDATA/PG_VERSION" ] && return 0
  "$PGBIN/initdb" -D "$PGDATA" -U surebet --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
  cat >>"$PGDATA/postgresql.conf" <<EOF
port = $PGPORT
listen_addresses = '127.0.0.1'
unix_socket_directories = '$INFRA'
shared_preload_libraries = 'timescaledb'
timescaledb.telemetry_level = off
shared_buffers = 128MB
max_connections = 40
work_mem = 8MB
max_wal_size = 512MB
EOF
}

start() {
  [ -x "$PGBIN/postgres" ] || setup
  init_pg
  if ! "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    "$PGBIN/pg_ctl" -D "$PGDATA" -l "$INFRA/postgres.log" -w start >/dev/null
    "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U surebet -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='surebet'" | grep -q 1 ||
      "$PGBIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U surebet surebet
  fi
  mkdir -p "$REDIS_DIR"
  if ! "$PREFIX/usr/bin/redis-cli" -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    "$PREFIX/usr/bin/redis-server" --port "$REDIS_PORT" --bind 127.0.0.1 --dir "$REDIS_DIR" \
      --save "" --appendonly no --maxmemory 256mb --daemonize yes --logfile "$REDIS_DIR/redis.log" >/dev/null
  fi
  status
}

stop() {
  "$PREFIX/usr/bin/redis-cli" -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop >/dev/null 2>&1 || true
  echo "zastaveno"
}

status() {
  if "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then echo "postgres: běží (port $PGPORT)"; else echo "postgres: stojí"; fi
  if "$PREFIX/usr/bin/redis-cli" -p "$REDIS_PORT" ping >/dev/null 2>&1; then echo "redis:    běží (port $REDIS_PORT)"; else echo "redis:    stojí"; fi
}

case "${1:-start}" in
  setup) setup ;;
  start) start ;;
  stop) stop ;;
  status) status ;;
  psql) shift; exec "$PGBIN/psql" -h 127.0.0.1 -p "$PGPORT" -U surebet surebet "$@" ;;
  redis-cli) shift; exec "$PREFIX/usr/bin/redis-cli" -p "$REDIS_PORT" "$@" ;;
  *) echo "použití: $0 setup|start|stop|status|psql|redis-cli"; exit 1 ;;
esac
