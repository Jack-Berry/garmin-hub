#!/usr/local/bin/python3.13
"""One-time ETL: data/garmin.db (SQLite, read-only) -> garminhub (Postgres).

Stage 2 of the migration. Text-first, byte-identical: every value is passed
through as-is (dates stay strings, JSON stays raw text, NULLs stay NULL). No
parsing, no coercion — the only type widening is schema-side (avg_hr's stray
REAL lands in a double precision column natively).

Idempotent: each run DELETEs and reloads every table (DELETE, not TRUNCATE —
the rw role is deliberately DML-only). Everything, including verification,
runs in ONE Postgres transaction; the load only COMMITs if every check passes,
so a failed run leaves the previous state untouched. SQLite is opened read-only
(URI mode) and is never modified.

    /usr/local/bin/python3.13 db/etl_sqlite_to_pg.py

Env overrides: SQLITE_PATH, DATABASE_URL (defaults below).
"""

import os
import sys
import sqlite3
from pathlib import Path

import psycopg

REPO_ROOT = Path(__file__).resolve().parent.parent
SQLITE_PATH = os.getenv("SQLITE_PATH", str(REPO_ROOT / "data" / "garmin.db"))
DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgres://garminhub_rw:garminhub_rw@localhost:5432/garminhub")

# (table, pk columns) in FK-safe load order: activities before laps.
TABLES = [
    ("activities", ["activity_id"]),
    ("laps", ["activity_id", "lap_index"]),
    ("planned_workouts", ["schedule_id"]),
    ("recovery", ["calendar_date"]),
    ("coach_notes", ["id"]),
    ("profile", ["id"]),
    ("personal_records", ["type_id"]),
    ("race_predictions", ["calendar_date"]),
]

# Known-extreme ids from recon — verified explicitly after load.
BIGINT_SPOT_CHECKS = [
    ("activities", "activity_id", 23486519870),
    ("personal_records", "activity_id", 23473054109),
    ("planned_workouts", "schedule_id", -1135745970769200807),
    ("planned_workouts", "workout_id", 1622275647),
]


def fail(msg):
    print(f"FAIL: {msg}")
    sys.exit(1)


def main():
    lite = sqlite3.connect(f"file:{SQLITE_PATH}?mode=ro", uri=True)
    pg = psycopg.connect(DATABASE_URL)
    checks = []  # (label, ok, detail)

    def check(label, ok, detail=""):
        checks.append((label, ok, detail))
        if not ok:
            print(f"  ✗ {label}: {detail}")

    with pg:  # one transaction: commit on clean exit, rollback on exception
        cur = pg.cursor()

        # --- Load -----------------------------------------------------------
        # Clear in reverse order (laps before activities) for the FK.
        for table, _ in reversed(TABLES):
            cur.execute(f"DELETE FROM {table}")

        for table, pk in TABLES:
            cols = [r[1] for r in lite.execute(f"PRAGMA table_info({table})")]
            cur.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name=%s", (table,))
            pg_cols = {r[0] for r in cur.fetchall()}
            if set(cols) != pg_cols:
                raise RuntimeError(
                    f"{table}: column mismatch SQLite-only={set(cols) - pg_cols} "
                    f"PG-only={pg_cols - set(cols)}")

            rows = lite.execute(
                f"SELECT {', '.join(cols)} FROM {table}").fetchall()
            override = " OVERRIDING SYSTEM VALUE" if table == "coach_notes" else ""
            stmt = (f"INSERT INTO {table} ({', '.join(cols)}){override} "
                    f"VALUES ({', '.join(['%s'] * len(cols))})")
            cur.executemany(stmt, rows)
            print(f"loaded {table}: {len(rows)} rows")

        cur.execute("SELECT setval(pg_get_serial_sequence('coach_notes','id'), "
                    "(SELECT MAX(id) FROM coach_notes))")

        # --- Verify (inside the transaction — a failure rolls the load back) --
        for table, pk in TABLES:
            cols = [r[1] for r in lite.execute(f"PRAGMA table_info({table})")]
            order = ", ".join(pk)
            sel = f"SELECT {', '.join(cols)} FROM {table} ORDER BY {order}"
            src = lite.execute(sel).fetchall()
            cur.execute(sel)
            dst = cur.fetchall()

            check(f"{table} count", len(src) == len(dst),
                  f"sqlite={len(src)} pg={len(dst)}")

            pk_idx = [cols.index(c) for c in pk]
            src_pks = [tuple(r[i] for i in pk_idx) for r in src]
            dst_pks = [tuple(r[i] for i in pk_idx) for r in dst]
            check(f"{table} sorted PK list", src_pks == dst_pks,
                  "PK sets differ")

            mismatches = [
                (pkv, cols[j], a, b)
                for pkv, sr, dr in zip(src_pks, src, dst)
                for j, (a, b) in enumerate(zip(sr, dr))
                if a != b
            ]
            check(f"{table} row-by-row (all {len(cols)} cols)",
                  not mismatches,
                  f"first mismatch: {mismatches[0]}" if mismatches else "")

        # BIGINT extremes landed intact.
        for table, col, val in BIGINT_SPOT_CHECKS:
            cur.execute(f"SELECT COUNT(*) FROM {table} WHERE {col} = %s", (val,))
            check(f"bigint extreme {table}.{col}={val}",
                  cur.fetchone()[0] == 1, "row not found at exact value")

        # JSON text columns byte-identical (explicit samples; row-by-row above
        # already covers all of them — this makes the guarantee visible).
        json_samples = [
            ("activities", "activity_id", "raw_json"),
            ("planned_workouts", "schedule_id", "steps_json"),
            ("recovery", "calendar_date", "raw_json"),
            ("profile", "id", "routines_json"),
        ]
        for table, pk1, col in json_samples:
            src = lite.execute(
                f"SELECT {pk1}, {col} FROM {table} "
                f"WHERE {col} IS NOT NULL ORDER BY {pk1} LIMIT 3").fetchall()
            ok = True
            for pkv, text in src:
                cur.execute(f"SELECT {col} FROM {table} WHERE {pk1} = %s", (pkv,))
                got = cur.fetchone()[0]
                ok = ok and isinstance(got, str) and got == text
            check(f"{table}.{col} byte-identical ({len(src)} samples)", ok)

        # NULL fidelity: is_race_override NULL counts must match.
        n_src = lite.execute("SELECT COUNT(*) FROM planned_workouts "
                             "WHERE is_race_override IS NULL").fetchone()[0]
        cur.execute("SELECT COUNT(*) FROM planned_workouts "
                    "WHERE is_race_override IS NULL")
        check("is_race_override NULLs preserved", n_src == cur.fetchone()[0],
              f"sqlite={n_src}")

        # Identity sequence positioned after MAX(id).
        cur.execute("SELECT last_value FROM coach_notes_id_seq")
        seq = cur.fetchone()[0]
        cur.execute("SELECT MAX(id) FROM coach_notes")
        check("coach_notes identity setval", seq == cur.fetchone()[0],
              f"last_value={seq}")

        # Aggregates (belt over the row-by-row braces).
        aggs = [
            ("activities", "SUM(distance_m)"),
            ("laps", "SUM(duration_s)"),
            ("activities", "MIN(activity_id) || '/' || MAX(activity_id)"),
            ("planned_workouts", "MIN(schedule_id) || '/' || MAX(schedule_id)"),
        ]
        for table, expr in aggs:
            s = lite.execute(f"SELECT {expr} FROM {table}").fetchone()[0]
            cur.execute(f"SELECT {expr} FROM {table}")
            p = cur.fetchone()[0]
            same = (s == p) if isinstance(s, str) else abs(s - p) < 1e-6
            check(f"{table} {expr}", same, f"sqlite={s} pg={p}")

        # --- Report ----------------------------------------------------------
        width = max(len(c[0]) for c in checks)
        print("\n=== Verification ===")
        for label, ok, detail in checks:
            print(f"  {'PASS' if ok else 'FAIL'}  {label:<{width}}"
                  + (f"  {detail}" if not ok and detail else ""))

        bad = [c for c in checks if not c[1]]
        if bad:
            raise RuntimeError(
                f"{len(bad)} verification check(s) failed — rolling back load")

    print(f"\nOK — all {len(checks)} checks passed; load committed.")
    lite.close()
    pg.close()


if __name__ == "__main__":
    main()
