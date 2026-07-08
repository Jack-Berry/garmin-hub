# Postgres (migration target)

Stage-1 artifacts for the SQLite → Postgres migration. The dev target is the
**local Homebrew PostgreSQL 14** service already running on `:5432` (not Docker:
it isn't installed here, and production is bare launchd/systemd services on the
Pi, which native Postgres mirrors better). Everything is isolated in a dedicated
database + roles and fully reversible.

## Setup / reset

```sh
bash db/setup_local.sh            # create roles + garminhub db + schema (idempotent)
psql -h localhost -d postgres -c 'DROP DATABASE garminhub'   # teardown (data too!)
```

## Connection strings

| Purpose | Mirrors | URL |
|---|---|---|
| reads  | Node `db.js` (read-only) | `postgres://garminhub_ro:garminhub_ro@localhost:5432/garminhub` |
| writes | Node `writeDb` + Python ingest | `postgres://garminhub_rw:garminhub_rw@localhost:5432/garminhub` |

`garminhub_ro` is SELECT-only; `garminhub_rw` is DML-only (no DDL) — a real
enforcement of the old better-sqlite3 db/writeDb split. Passwords are dev-only
placeholders (local connections are trusted); parameterise them before any
remote host.

Env overrides (defaults are the local URLs above): Python ingest reads
`DATABASE_URL` (rw); the Node API reads `DATABASE_URL_RO` / `DATABASE_URL_RW`
(server/.env); `PG_ADMIN_URL` is the DDL connection for `ingest/init_db.py`.

## Schema notes (`schema.pg.sql`)

- **Date/time columns are real types** (stage 5a): `start_time_local` /
  `lt_detected_date` → `timestamp` (local wall-clock, no zone), `calendar_date`
  columns / `fetched_at` / `record_date` / `date_range_*` → `date`,
  `created_at` / `updated_at` → `timestamptz`. The Node API's pg type parsers
  (server/db.js) serialize them back to the exact legacy string shapes, so the
  frontend contract is unchanged.
- **`*_json` / `raw_json` columns are `jsonb`** (stage 5b): pg returns parsed
  objects/arrays — no `JSON.parse` on reads; writes may pass JSON text (PG
  coerces) or objects. Note jsonb canonicalises object key order. (The stage-2
  ETL is a retired one-time artifact — its text-based verification predates
  both promotions and would report type mismatches by design.)
- **bigint ids**: `activities.activity_id`, `laps.activity_id`,
  `personal_records.activity_id` (activity ids reach ~23.5B),
  `planned_workouts.schedule_id` (negative 60-bit ical hashes) and
  `planned_workouts.workout_id` (already 1.6B) all overflow or crowd int4.
- **HR columns** (`avg_hr`, `max_hr`, `lt_hr`) are `double precision` — SQLite's
  loose affinity let a real into `activities.avg_hr`; every other
  integer-declared column was audited clean and stays `integer`.
- **Race flags** stay `smallint` 0/1 with semantic NULL (`is_race_override`
  NULL = no override) — the API's `0/1/null` contract is unchanged.
- `coach_notes.id` is `GENERATED ALWAYS AS IDENTITY`: the stage-2 load must use
  `OVERRIDING SYSTEM VALUE` to keep existing ids, then
  `setval(pg_get_serial_sequence('coach_notes','id'), max(id))`.
- Column order matches the live SQLite tables (migration-added columns last,
  including `profile.routines_json`, which `ingest/schema.sql` lacks) so
  positional loads line up.
