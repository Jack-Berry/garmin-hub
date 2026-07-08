#!/usr/bin/env python3.13
"""One-time migration: replace planned_workouts.is_race with the
is_race_auto / is_race_override pair. Idempotent — safe to re-run.

Effective race status is COALESCE(is_race_override, is_race_auto) at query time.
"""

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "garmin.db"


def cols(conn):
    return {r[1] for r in conn.execute("PRAGMA table_info(planned_workouts)")}


def main():
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("PRAGMA foreign_keys = ON;")
        before = conn.execute("SELECT COUNT(*) FROM planned_workouts").fetchone()[0]
        existing = cols(conn)

        if "is_race_auto" not in existing:
            conn.execute("ALTER TABLE planned_workouts ADD COLUMN is_race_auto INTEGER")
            print("Added column is_race_auto")
        if "is_race_override" not in existing:
            conn.execute("ALTER TABLE planned_workouts ADD COLUMN is_race_override INTEGER")
            print("Added column is_race_override (manual override, left NULL)")

        # Backfill is_race_auto for newly-added rows from the title keyword.
        # (Ingest owns/overwrites this column on every run; this is just so
        # existing rows have sensible values until the next ingest.)
        conn.execute(
            "UPDATE planned_workouts SET is_race_auto = "
            "CASE WHEN lower(title) LIKE '%race%' OR lower(title) LIKE '%parkrun%' "
            "THEN 1 ELSE 0 END WHERE is_race_auto IS NULL"
        )

        if "is_race" in cols(conn):
            conn.execute("ALTER TABLE planned_workouts DROP COLUMN is_race")
            print("Dropped old column is_race")

        conn.commit()
        after = conn.execute("SELECT COUNT(*) FROM planned_workouts").fetchone()[0]
        print(f"\nRows: {before} before -> {after} after (no rows lost)")
        print("Columns now:", ", ".join(sorted(cols(conn))))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
