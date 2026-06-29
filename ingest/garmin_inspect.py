#!/usr/local/bin/python3.13
# garmin_inspect.py — disposable, pulls raw JSON for schema design.
#
# IMPORTANT: garminconnect 0.3.6 (with the workout/scheduled-workout methods)
# is installed under Homebrew's Python 3.13, NOT Apple's /usr/bin/python3 (3.9).
# Run this with:  /usr/local/bin/python3.13 garmin_inspect.py
# (or just ./garmin_inspect.py thanks to the shebang above)

import os
import json
import warnings
from datetime import date, timedelta

# --- Suppress the harmless LibreSSL-vs-OpenSSL warning (NotOpenSSLWarning) ---
try:
    from urllib3.exceptions import NotOpenSSLWarning
    warnings.filterwarnings("ignore", category=NotOpenSSLWarning)
except Exception:
    pass
warnings.filterwarnings("ignore", message=r".*OpenSSL.*")

import garminconnect

EMAIL = "ADDEMAIL"
PASSWORD = "PASS"

OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "garmin_dump.json")


def prompt_mfa() -> str:
    """Interactive MFA — Garmin calls this only when a code is required."""
    return input("Enter Garmin MFA / 2FA code: ").strip()


# garminconnect 0.3.6 handles interactive MFA via the prompt_mfa callback.
g = garminconnect.Garmin(EMAIL, PASSWORD, prompt_mfa=prompt_mfa)
g.login()

dump = {}


def truncate_lists(obj, n=5):
    """Recursively cap every list to its first n elements (keeps file small)."""
    if isinstance(obj, dict):
        return {k: truncate_lists(v, n) for k, v in obj.items()}
    if isinstance(obj, list):
        return [truncate_lists(x, n) for x in obj[:n]]
    return obj


def find_scheduled_ids(obj):
    """Walk a scheduled-workout calendar payload and collect plausible
    scheduled-workout IDs (to feed get_scheduled_workout_by_id)."""
    ids = []

    def walk(o):
        if isinstance(o, dict):
            item_type = str(o.get("itemType", "")).lower()
            if "workout" in item_type and o.get("id") is not None:
                ids.append(o["id"])
            for k, v in o.items():
                if k in ("scheduledWorkoutId", "scheduleId") and isinstance(v, (int, str)):
                    ids.append(v)
                walk(v)
        elif isinstance(o, list):
            for x in o:
                walk(x)

    walk(obj)
    seen, out = set(), []
    for i in ids:
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out


# --- Scheduled/planned workouts (Runna's prescriptions) -----------------------
# get_scheduled_workouts is now calendar-based: (year, month) -> dict per month.
# Fetch every month spanning the previous 60 days through the next 30 days.
today = date.today()
window_start = today - timedelta(days=60)
window_end = today + timedelta(days=30)

months = []
y, m = window_start.year, window_start.month
while (y, m) <= (window_end.year, window_end.month):
    months.append((y, m))
    m += 1
    if m > 12:
        m, y = 1, y + 1

scheduled_by_month = {}
for (yy, mm) in months:
    key = f"{yy:04d}-{mm:02d}"
    try:
        scheduled_by_month[key] = g.get_scheduled_workouts(yy, mm)
    except Exception as e:
        scheduled_by_month[key] = {"error": str(e)}

dump["scheduled_workouts_window"] = {
    "from": str(window_start),
    "to": str(window_end),
    "months": [f"{yy:04d}-{mm:02d}" for (yy, mm) in months],
}
dump["scheduled_workouts_by_month"] = scheduled_by_month

# Full detail of one scheduled workout, to expose the step/target structure.
sched_ids = find_scheduled_ids(scheduled_by_month)
dump["scheduled_workout_ids_found"] = sched_ids
if sched_ids:
    sid = sched_ids[0]
    try:
        dump["sample_scheduled_workout_detail"] = g.get_scheduled_workout_by_id(sid)
        dump["sample_scheduled_workout_detail_id"] = sid
    except Exception as e:
        dump["sample_scheduled_workout_detail_error"] = f"{sid}: {e}"

# --- Workout library (the templates Runna created) ----------------------------
try:
    dump["workouts"] = g.get_workouts(0, 100)
except Exception as e:
    dump["workouts_error"] = str(e)

# --- Last 15 actual activities ------------------------------------------------
try:
    acts = g.get_activities(0, 15)
    dump["activities"] = acts
    # Full detail + splits for the most recent run, to see step-level data.
    if acts:
        first = acts[0] if isinstance(acts, list) else acts
        aid = first["activityId"]
        # Per-second GPS/HR lists here are huge — truncate every list to 5.
        dump["sample_activity_detail"] = truncate_lists(g.get_activity_details(aid), 5)
        dump["sample_activity_splits"] = g.get_activity_splits(aid)
except Exception as e:
    dump["activities_error"] = str(e)

with open(OUT_PATH, "w") as f:
    json.dump(dump, f, indent=2, default=str)

print(f"Wrote {OUT_PATH}")
