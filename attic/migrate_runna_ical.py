#!/usr/bin/env python3.13
"""One-time migration for the Runna ical feed (full-plan ingest).

Adds:
  - profile.runna_ical_url        — the Runna calendar-feed URL (user-edited)
  - planned_workouts.source       — 'garmin' | 'runna_ical'; existing rows
                                    backfilled to 'garmin'

Idempotent — safe to re-run.
"""

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "garmin.db"


def cols(conn, table):
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def main():
    conn = sqlite3.connect(DB_PATH)
    try:
        did = []
        if "runna_ical_url" not in cols(conn, "profile"):
            conn.execute("ALTER TABLE profile ADD COLUMN runna_ical_url TEXT")
            did.append("profile.runna_ical_url")
        if "source" not in cols(conn, "planned_workouts"):
            conn.execute("ALTER TABLE planned_workouts ADD COLUMN source TEXT")
            conn.execute("UPDATE planned_workouts SET source = 'garmin' WHERE source IS NULL")
            did.append("planned_workouts.source (backfilled 'garmin')")
        conn.commit()
        print("Added: " + ", ".join(did) if did else "Already migrated — nothing to do.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
