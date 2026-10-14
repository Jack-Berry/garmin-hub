#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=ro_password="$GARMINHUB_RO_PASSWORD" --set=rw_password="$GARMINHUB_RW_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE garminhub_ro LOGIN PASSWORD %L', :'ro_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'garminhub_ro') \gexec
SELECT format('ALTER ROLE garminhub_ro PASSWORD %L', :'ro_password') \gexec
SELECT format('CREATE ROLE garminhub_rw LOGIN PASSWORD %L', :'rw_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'garminhub_rw') \gexec
SELECT format('ALTER ROLE garminhub_rw PASSWORD %L', :'rw_password') \gexec
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --file /schema/schema.pg.sql
