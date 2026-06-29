#!/usr/bin/env python3.13
"""Initialise data/garmin.db from schema.sql. Idempotent — safe to re-run."""

import sqlite3
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA = REPO_ROOT / "ingest" / "schema.sql"
DB_PATH = REPO_ROOT / "data" / "garmin.db"


def main():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("PRAGMA foreign_keys = ON;")
        conn.executescript(SCHEMA.read_text())
        conn.commit()
        tables = [
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
            )
        ]
        print(f"Initialised {DB_PATH}")
        print("Tables:", ", ".join(tables))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
