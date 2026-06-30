#!/usr/bin/env python3.13
"""One-time migration: add the routines_json column to the profile table.

Stores "Other regular activities" — recurring non-Garmin-planned sessions
(football, gym, cycling…) as a JSON list of {activity, day, intensity}, same
pattern as shoes_json/races_json/injuries_json. Idempotent — safe to re-run.
"""

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "garmin.db"


def cols(conn):
    return {r[1] for r in conn.execute("PRAGMA table_info(profile)")}


def main():
    conn = sqlite3.connect(DB_PATH)
    try:
        if "routines_json" in cols(conn):
            print("Already migrated (routines_json present) — nothing to do.")
            return
        conn.execute("ALTER TABLE profile ADD COLUMN routines_json TEXT")
        conn.commit()
        print("Added profile.routines_json. Columns now:", ", ".join(sorted(cols(conn))))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
