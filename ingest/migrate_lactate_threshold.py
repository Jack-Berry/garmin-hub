#!/usr/bin/env python3.13
"""One-time migration: add lactate-threshold columns to the profile table.

Garmin's get_lactate_threshold(latest=True) returns a single CURRENT reading (not
a series). We store it on profile (single-row coaching config, id=1) — it's
coaching config, not per-day wellness, so it does NOT belong on recovery. Ingest
owns these three columns and overwrites them each run via a scoped UPDATE that
never touches user-edited fields. Idempotent — safe to re-run.

  lt_speed_mps      REAL     LT speed in TRUE m/s (raw Garmin speed x LT_SPEED_SCALE)
  lt_hr             INTEGER  LT heart rate, bpm
  lt_detected_date  TEXT     source calendarDate (ISO), for staleness reasoning
"""

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "garmin.db"

NEW_COLS = {
    "lt_speed_mps": "REAL",
    "lt_hr": "INTEGER",
    "lt_detected_date": "TEXT",
}


def cols(conn):
    return {r[1] for r in conn.execute("PRAGMA table_info(profile)")}


def main():
    conn = sqlite3.connect(DB_PATH)
    try:
        existing = cols(conn)
        added = [name for name in NEW_COLS if name not in existing]
        for name in added:
            conn.execute(f"ALTER TABLE profile ADD COLUMN {name} {NEW_COLS[name]}")
        conn.commit()
        print("Added profile columns:", ", ".join(added) if added
              else "(none — already migrated)")
        print("Columns now:", ", ".join(sorted(cols(conn))))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
