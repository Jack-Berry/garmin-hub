#!/usr/local/bin/python3.13
"""One-off recon probe for Garmin lactate threshold (Stage 8).

READ-ONLY. Writes nothing to the DB, modifies no existing files. Reuses ingest.py's
cached-token login (no MFA re-prompt) and dumps the raw get_lactate_threshold
payloads to ingest/lt_probe_dump.json for reference, like the other *_dump.json files.

    /usr/local/bin/python3.13 ingest/probe_lt.py
"""

import sys
import json
from pathlib import Path
from datetime import date, timedelta

from dotenv import load_dotenv

INGEST_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(INGEST_DIR))
from ingest import login, ENV_PATH  # reuse the exact auth/token pattern

DUMP_PATH = INGEST_DIR / "lt_probe_dump.json"


def show_keys(label, obj):
    """Print top-level keys and any speed/HR-carrying fields, no assumptions."""
    print(f"\n--- {label}: shape ---")
    if isinstance(obj, dict):
        print("top-level keys:", list(obj.keys()))
        for k, v in obj.items():
            if any(s in k.lower() for s in ("speed", "pace", "heart", "hr", "bpm", "value")):
                print(f"   {k} = {v!r}")
    elif isinstance(obj, list):
        print(f"list of {len(obj)} item(s)")
        if obj:
            print("first item keys:", list(obj[0].keys()) if isinstance(obj[0], dict) else type(obj[0]))
    else:
        print("value:", repr(obj))


def main():
    load_dotenv(ENV_PATH)
    g = login()

    today = date.today()
    start = today - timedelta(days=90)

    print("\nCalling get_lactate_threshold(latest=True) ...")
    latest = g.get_lactate_threshold(latest=True)

    print(f"\nCalling get_lactate_threshold(start_date={start}, end_date={today}, aggregation='daily') ...")
    series = g.get_lactate_threshold(
        start_date=start.isoformat(), end_date=today.isoformat(), aggregation="daily"
    )

    print("\n" + "=" * 78)
    print("LATEST (latest=True)")
    print("=" * 78)
    print(json.dumps(latest, indent=2, default=str))
    show_keys("latest", latest)

    print("\n" + "=" * 78)
    print(f"RANGE ({start} -> {today}, daily)")
    print("=" * 78)
    print(json.dumps(series, indent=2, default=str))
    show_keys("range", series)
    if isinstance(series, list):
        print(f"\nrange point count: {len(series)}")

    DUMP_PATH.write_text(json.dumps({"latest": latest, "range": series}, indent=2, default=str))
    print(f"\nSaved raw payloads -> {DUMP_PATH}")


if __name__ == "__main__":
    main()
