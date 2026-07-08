#!/usr/bin/env python3.13
"""(Re-)apply the garminhub Postgres schema from db/schema.pg.sql. Idempotent.

DDL needs an admin/owner connection — the app's rw role is deliberately
DML-only — so this connects via PG_ADMIN_URL (default: the local unix socket,
where the OS user is the Homebrew superuser). First-time setup (roles +
database + schema) is db/setup_local.sh; this script only re-applies the
schema to an existing database.

The SQLite-era migrate_*.py scripts are retired to attic/ — already
applied, their effects baked into db/schema.pg.sql.
"""

import os
from pathlib import Path

import psycopg

REPO_ROOT = Path(__file__).resolve().parent.parent
SCHEMA = REPO_ROOT / "db" / "schema.pg.sql"
ADMIN_DSN = os.getenv("PG_ADMIN_URL", "dbname=garminhub")


def main():
    with psycopg.connect(ADMIN_DSN) as conn:  # commits on clean exit
        conn.execute(SCHEMA.read_text())
        tables = [r[0] for r in conn.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'public' ORDER BY table_name")]
    print(f"Applied {SCHEMA.name}")
    print("Tables:", ", ".join(tables))


if __name__ == "__main__":
    main()
