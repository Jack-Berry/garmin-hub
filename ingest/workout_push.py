#!/usr/local/bin/python3.13
"""Garmin write path for pacer workouts — upload / schedule / delete.

Reuses ingest.py's cached-token login (no duplicate auth). The only module in the
project that WRITES to Garmin, so it's kept separate from read-only ingest and is
never run by cron.

Run with Homebrew Python 3.13 (NOT Apple's 3.9):

    /usr/local/bin/python3.13 ingest/workout_push.py --test       # build + push the test
    /usr/local/bin/python3.13 ingest/workout_push.py --delete ID  # clean up afterwards
"""

import sys
import json
import argparse
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workout_builder as wb
from ingest import login, ENV_PATH

# The coming Wednesday — my real Engo hardware test (see --test).
TEST_DATE = "2026-07-01"


# --- Garmin write primitives --------------------------------------------------
def connect():
    """Log in via ingest.py's cached-token flow (MFA only on first run)."""
    load_dotenv(ENV_PATH)
    return login()


def upload(g, workout):
    """Upload a workout dict; return (workout_id, raw_response)."""
    resp = g.upload_workout(workout)
    wid = resp.get("workoutId") or resp.get("id")
    if not wid:
        raise RuntimeError(f"upload returned no workout id: {json.dumps(resp)[:400]}")
    print(f"  uploaded -> workoutId {wid}  ({resp.get('workoutName')})")
    return wid, resp


def schedule(g, workout_id, date_str):
    """Schedule an uploaded workout on a calendar date; return (schedule_id, resp)."""
    resp = g.schedule_workout(workout_id, date_str)
    sid = resp.get("workoutScheduleId") or resp.get("id")
    print(f"  scheduled workout {workout_id} on {date_str} -> scheduleId {sid}")
    return sid, resp


def delete(g, workout_id):
    """Delete a workout from the Garmin library (also removes its schedule)."""
    resp = g.delete_workout(workout_id)
    print(f"  deleted workout {workout_id}")
    return resp


def unschedule(g, schedule_id):
    """Remove one calendar entry WITHOUT deleting the workout template —
    the other half of schedule(); used by the Stage 9d move reconcile."""
    resp = g.unschedule_workout(schedule_id)
    print(f"  unscheduled calendar entry {schedule_id}")
    return resp


def find_schedule_id(g, workout_id, date_str):
    """Locate the Garmin calendar schedule id for workout_id on date_str (the
    push response's schedule id isn't persisted, so a move looks it up live).
    Returns None if no matching calendar entry exists."""
    cal = g.get_scheduled_workouts(int(date_str[:4]), int(date_str[5:7]))
    for item in (cal.get("calendarItems", []) if isinstance(cal, dict) else []):
        if (str(item.get("itemType", "")).lower() == "workout"
                and item.get("workoutId") == workout_id
                and item.get("date") == date_str):
            return item.get("id")
    return None


# --- Test workouts ------------------------------------------------------------
def build_format_check():
    """(a) Sub-20 5k, km-paired negative, 500m — re-confirm template parity."""
    return wb.build_pacer(5000, "sub 20", "negative", segment_m=500)


def build_hardware_test():
    """(b) MY REAL ENGO TEST — 5.5km, 11x500m, deliberately varied paces so the
    Engo pace gauge should visibly jump at every 500m boundary. Each 500m is its
    own flat block at the given pace."""
    paces = ["5:30", "5:00", "5:30", "4:45", "5:30", "5:00",
             "5:30", "4:45", "5:30", "5:00", "5:30"]
    blocks = [{"length_m": 500, "segment_m": 500, "target": p, "strategy": "flat"}
              for p in paces]
    return wb.build_pacer_blocks(blocks, name="TEST 5.5k Engo pace check")


def run_test():
    fmt = build_format_check()
    hw = build_hardware_test()

    print("=" * 78)
    print("(a) FORMAT CHECK — Sub 20 5k, km-paired negative (built only, NOT pushed)")
    print("=" * 78)
    wb.summarise(fmt)
    print(json.dumps(fmt, indent=2))
    print()

    print("=" * 78)
    print(f"(b) HARDWARE TEST — pushing to Garmin, scheduled {TEST_DATE} (Wednesday)")
    print("=" * 78)
    wb.summarise(hw)
    print(json.dumps(hw, indent=2))
    print()

    print("Connecting to Garmin...")
    g = connect()
    print("Pushing hardware test (b)...")
    wid, _ = upload(g, hw)
    schedule(g, wid, TEST_DATE)

    print("\n" + "-" * 78)
    print(f"DONE. Test workout uploaded as workoutId {wid} and scheduled {TEST_DATE}.")
    print("Clean up AFTER Wednesday's run with:")
    print(f"    /usr/local/bin/python3.13 ingest/workout_push.py --delete {wid}")
    print("-" * 78)
    print("""
Next steps:
  1. Open Garmin Connect (web/app) -> Training -> Calendar: confirm
     'TEST 5.5k Engo pace check' appears on Wed 2026-07-01 with 11 x 500m steps
     at the alternating paces.
  2. Let it sync to your watch (open Garmin Connect on the phone near the watch).
  3. Wednesday: run it. Watch the Engo 3 pace gauge — it should visibly jump at
     each 500m boundary (5:30 -> 5:00 -> 5:30 -> 4:45 ...).
  4. Once you've confirmed the Engo tracks the per-segment targets, delete it with
     the --delete command above.
""")


def main():
    ap = argparse.ArgumentParser(description="Pacer workout write path (Garmin).")
    ap.add_argument("--test", action="store_true",
                    help="build both test workouts and PUSH the hardware test (b)")
    ap.add_argument("--delete", metavar="ID", type=int,
                    help="delete a workout by id (cleanup)")
    args = ap.parse_args()

    if args.delete:
        g = connect()
        delete(g, args.delete)
    elif args.test:
        run_test()
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
