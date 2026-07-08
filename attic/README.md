# Attic — retired artifacts (historical record, nothing here runs)

Retired when the SQLite → Postgres migration completed (July 2026). Kept for
the record, not for use; the live schema is `db/schema.pg.sql`.

- **`garmin-pre-migration.db`** — the final SQLite database (gitignored, local
  only). Frozen at the stage-3 cutover when ingest switched to Postgres; the
  Postgres data supersedes it.
- **`schema.sqlite.sql`** — the SQLite schema (was `ingest/schema.sql`).
  Incomplete on its own: `profile.routines_json` only ever existed via
  `migrate_routines.py`.
- **`etl_sqlite_to_pg.py`** — the one-time stage-2 data load (SQLite →
  Postgres, byte-identical, self-verifying). Written against the text-first
  schema; the later type promotions mean re-running it would fail verification
  by design.
- **`migrate_*.py`** — the SQLite-era ad-hoc schema migrations
  (`is_race`, `activity_type`, `profile_structured`, `routines`,
  `lactate_threshold`, `runna_ical`). All applied long ago; their effects are
  baked into `db/schema.pg.sql`.
