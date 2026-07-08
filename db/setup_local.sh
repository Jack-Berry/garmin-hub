#!/bin/bash
# Stand up the Garmin Hub Postgres dev target on the local (Homebrew) instance:
# two roles (ro/rw), the garminhub database, and the stage-1 schema. Idempotent.
#
#   bash db/setup_local.sh
#
# Passwords below are LOCAL DEV ONLY (Homebrew pg_hba trusts local connections
# anyway); set real ones when a remote/Pi host enters the picture.
set -euo pipefail

PGHOST="${PGHOST:-localhost}"
DB=garminhub
HERE="$(cd "$(dirname "$0")" && pwd)"

admin() { psql -h "$PGHOST" -d postgres -v ON_ERROR_STOP=1 "$@"; }

# Roles (cluster-level, so created here rather than in schema.pg.sql).
admin <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'garminhub_ro') THEN
    CREATE ROLE garminhub_ro LOGIN PASSWORD 'garminhub_ro';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'garminhub_rw') THEN
    CREATE ROLE garminhub_rw LOGIN PASSWORD 'garminhub_rw';
  END IF;
END $$;
SQL

# Database (CREATE DATABASE can't run inside DO/transaction).
admin -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB}'" | grep -q 1 \
  || admin -c "CREATE DATABASE ${DB}"

# Schema + grants.
psql -h "$PGHOST" -d "$DB" -v ON_ERROR_STOP=1 -f "$HERE/schema.pg.sql"

echo "OK — database '${DB}' ready on ${PGHOST}:5432 (roles garminhub_ro / garminhub_rw)"
