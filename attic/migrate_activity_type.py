#!/usr/bin/env python3.13
"""One-time migration: add activities.activity_type + activity_group and
backfill both from each row's raw_json. Idempotent — safe to re-run.

No Garmin re-fetch needed: raw_json already holds activityType.typeKey for
every existing row. This script ALTERs the live table itself — schema.sql's
CREATE TABLE IF NOT EXISTS can't add columns to an existing table, which is
the same reason migrate_is_race.py exists.

The activity_group mapping mirrors ingest.activity_group; duplicated here so
this stdlib-only backfill doesn't import the Garmin client stack.
"""

import json
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "garmin.db"


def activity_group(type_key):
    k = (type_key or "").lower()
    if "running" in k:
        return "run"
    if k in ("soccer", "football"):
        return "football"
    if "walking" in k:
        return "walk"
    return "other"


def cols(conn):
    return {r[1] for r in conn.execute("PRAGMA table_info(activities)")}


def main():
    conn = sqlite3.connect(DB_PATH)
    try:
        existing = cols(conn)
        if "activity_type" not in existing:
            conn.execute("ALTER TABLE activities ADD COLUMN activity_type TEXT")
            print("Added column activity_type")
        if "activity_group" not in existing:
            conn.execute("ALTER TABLE activities ADD COLUMN activity_group TEXT")
            print("Added column activity_group")

        rows = conn.execute("SELECT activity_id, raw_json FROM activities").fetchall()
        for aid, raw in rows:
            try:
                a = json.loads(raw) if raw else {}
            except (TypeError, json.JSONDecodeError):
                a = {}
            type_key = (a.get("activityType") or {}).get("typeKey")
            conn.execute(
                "UPDATE activities SET activity_type=?, activity_group=? WHERE activity_id=?",
                (type_key, activity_group(type_key), aid),
            )
        conn.commit()
        print(f"Backfilled {len(rows)} rows\n")

        for grp, typ, n in conn.execute(
            "SELECT activity_group, activity_type, COUNT(*) FROM activities "
            "GROUP BY activity_group, activity_type ORDER BY activity_group, activity_type"
        ):
            print(f"  {grp or '—':9s} {typ or '—':22s} {n}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
