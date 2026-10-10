#!/usr/bin/env bash
# Bring up a Postgres for development and tests and print its DATABASE_URL on stdout (logs go to stderr).
#
#   export DATABASE_URL="$(bash scripts/dev-db.sh)"                 # database sweetspot, kept
#   export DATABASE_URL="$(bash scripts/dev-db.sh sweetspot_e2e --fresh)"   # dropped and recreated first
#
# Three ways to get a server, tried in order, so one command works on a laptop, in CI, and in the agent sandbox
# (design §3.2, §13.1; the sandbox constraint is written up in docs/ROUTINES.md):
#   1. DATABASE_URL is set and its server answers -> use that server.
#   2. The Docker daemon is up                    -> `docker compose up -d db`, the documented local path.
#   3. Postgres is installed on the host          -> start it directly (the sandbox has no Docker daemon).
# The requested database is created if missing; the server itself is left running.
#
# --fresh drops the requested database first. It only ever touches the database named on the command line, so keep
# test databases under their own name; scripts/agent-check.sh uses sweetspot_e2e.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="sweetspot"
FRESH=""
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    -*) echo "dev-db: unknown option $arg" >&2; exit 2 ;;
    *) DB_NAME="$arg" ;;
  esac
done

DB_USER="${POSTGRES_USER:-sweetspot}"
DB_PASS="${POSTGRES_PASSWORD:-sweetspot}"
DB_PORT="${POSTGRES_PORT:-5432}"

say() { echo "dev-db: $*" >&2; }

# Everything below ends with a server reachable as $ADMIN_URL (a superuser-ish connection to the postgres database)
# and the connection string to hand back in $TARGET_URL.
ADMIN_URL=""
TARGET_URL=""

# --- 1. A server from the environment: CI's service container, or one the developer runs themselves.
if [ -n "${DATABASE_URL:-}" ]; then
  base="${DATABASE_URL%%\?*}"                       # postgresql://user:pass@host:port/dbname
  query="schema=public"; case "$DATABASE_URL" in *\?*) query="${DATABASE_URL#*\?}" ;; esac
  server="${base%/*}"                               # postgresql://user:pass@host:port
  if psql "$server/postgres" -c 'select 1' >/dev/null 2>&1; then
    say "using the server from DATABASE_URL"
    ADMIN_URL="$server/postgres"
    TARGET_URL="$server/${DB_NAME}?${query}"
  else
    say "DATABASE_URL is set but its server does not answer; falling back to a local one"
  fi
fi

# --- 2. Docker: the documented local path.
if [ -z "$ADMIN_URL" ] && docker info >/dev/null 2>&1; then
  say "docker daemon is up; starting the db service"
  docker compose up -d db >&2
  for _ in $(seq 1 60); do
    docker compose exec -T db pg_isready -U "$DB_USER" -d postgres >/dev/null 2>&1 && break
    sleep 1
  done
  docker compose exec -T db pg_isready -U "$DB_USER" -d postgres >/dev/null 2>&1 ||
    { say "the db container never became ready"; docker compose logs db >&2; exit 1; }
  ADMIN_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:${DB_PORT}/postgres"
  TARGET_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:${DB_PORT}/${DB_NAME}?schema=public"
fi

# --- 3. No daemon: start the Postgres installed on the host (how the agent sandbox runs).
if [ -z "$ADMIN_URL" ]; then
  PGBIN=""
  for d in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin; do [ -x "$d/pg_ctl" ] && PGBIN="$d"; done
  [ -n "$PGBIN" ] || { command -v pg_ctl >/dev/null 2>&1 && PGBIN="$(dirname "$(command -v pg_ctl)")"; }
  if [ -z "$PGBIN" ]; then
    say "no Docker daemon and no Postgres server on this host."
    say "start Docker and run 'docker compose up db', or install postgresql-16, or point DATABASE_URL at a server."
    exit 1
  fi
  say "no docker daemon; using the Postgres server at $PGBIN"

  # initdb and postgres refuse to run as root, so superuser work goes through the postgres OS account.
  if [ "$(id -u)" = 0 ]; then as_postgres() { su postgres -c "$1"; }
  elif command -v sudo >/dev/null 2>&1 && [ "$(id -un)" != postgres ]; then as_postgres() { sudo -u postgres bash -c "$1"; }
  else as_postgres() { bash -c "$1"; }
  fi

  if ! pg_isready -h localhost -p "$DB_PORT" >/dev/null 2>&1; then
    if command -v pg_lsclusters >/dev/null 2>&1 && [ -n "$(pg_lsclusters -h 2>/dev/null)" ]; then
      read -r ver cluster _ <<<"$(pg_lsclusters -h | head -1)"
      say "starting system cluster ${ver}/${cluster}"
      pg_ctlcluster "$ver" "$cluster" start >&2 || true
    else
      # No packaged cluster: lay down a throwaway one, owned by the postgres account.
      PGDATA="${PGDATA:-/var/tmp/sweetspot-pgdata}"
      say "no system cluster; initialising one at $PGDATA"
      as_postgres "[ -s '$PGDATA/PG_VERSION' ] || $PGBIN/initdb -D '$PGDATA' -U postgres --auth-host=scram-sha-256 >/dev/null"
      as_postgres "$PGBIN/pg_ctl -D '$PGDATA' -l '$PGDATA/server.log' -o \"-p $DB_PORT -c listen_addresses=localhost\" -w start" >&2
    fi
  fi
  for _ in $(seq 1 30); do pg_isready -h localhost -p "$DB_PORT" >/dev/null 2>&1 && break; sleep 1; done
  pg_isready -h localhost -p "$DB_PORT" >/dev/null 2>&1 || { say "Postgres never came up on port ${DB_PORT}"; exit 1; }

  # Superuser so that `prisma migrate dev` can create its shadow database.
  local_q() { as_postgres "psql -p $DB_PORT -d postgres -v ON_ERROR_STOP=1 -tAc \"$1\""; }
  if [ -z "$(local_q "select 1 from pg_roles where rolname='${DB_USER}'")" ]; then
    say "creating role ${DB_USER}"
    local_q "create role \\\"${DB_USER}\\\" with login superuser password '${DB_PASS}'" >/dev/null
  else
    local_q "alter role \\\"${DB_USER}\\\" with login superuser password '${DB_PASS}'" >/dev/null
  fi
  ADMIN_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:${DB_PORT}/postgres"
  TARGET_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:${DB_PORT}/${DB_NAME}?schema=public"
fi

adm() { psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -tAc "$1"; }
if [ -n "$FRESH" ] && [ -n "$(adm "select 1 from pg_database where datname='${DB_NAME}'")" ]; then
  say "dropping database ${DB_NAME} for a clean run"
  adm "drop database \"${DB_NAME}\" with (force)" >/dev/null
fi
if [ -z "$(adm "select 1 from pg_database where datname='${DB_NAME}'")" ]; then
  say "creating database ${DB_NAME}"
  adm "create database \"${DB_NAME}\"" >/dev/null
fi

say "ready: ${DB_NAME} on port ${DB_PORT}"
echo "$TARGET_URL"
