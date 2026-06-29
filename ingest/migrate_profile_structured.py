#!/usr/bin/env python3.13
"""One-time migration: restructure the profile table from five flat text
columns into JSON list fields. Idempotent — safe to re-run.

Old: shoe_rotation, goal_races, typical_paces, injuries_constraints, general_notes
New: shoes_json, races_json, injuries_json, general_notes

The profile is a single-row settings table (id = 1) the user edits by hand;
the old placeholder data is discarded (per the task), so we just rebuild it.
typical_paces is dropped entirely — the coach infers paces from run data.
"""

import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "garmin.db"


def cols(conn):
    return {r[1] for r in conn.execute("PRAGMA table_info(profile)")}


def main():
    conn = sqlite3.connect(DB_PATH)
    try:
        if "shoes_json" in cols(conn):
            print("Already migrated (shoes_json present) — nothing to do.")
            return

        conn.execute("DROP TABLE IF EXISTS profile")
        conn.execute(
            """
            CREATE TABLE profile (
              id            INTEGER PRIMARY KEY CHECK (id = 1),
              shoes_json    TEXT,
              races_json    TEXT,
              injuries_json TEXT,
              general_notes TEXT,
              updated_at    TEXT
            )
            """
        )
        conn.execute("INSERT OR IGNORE INTO profile (id) VALUES (1)")
        conn.commit()
        print("Rebuilt profile table. Columns now:", ", ".join(sorted(cols(conn))))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
