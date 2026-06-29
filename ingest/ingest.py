#!/usr/local/bin/python3.13
"""Garmin Hub ingest — pulls Garmin data and upserts into data/garmin.db.

Idempotent (safe to re-run from cron): all writes are upserts. Token caching
means MFA is only needed on first login / token expiry.

Run with Homebrew Python 3.13 (NOT Apple's 3.9):
    /usr/local/bin/python3.13 ingest/ingest.py
"""

import os
import json
import sqlite3
import warnings
from pathlib import Path
from datetime import date, timedelta

# --- Suppress the harmless LibreSSL-vs-OpenSSL warning (NotOpenSSLWarning) ---
try:
    from urllib3.exceptions import NotOpenSSLWarning
    warnings.filterwarnings("ignore", category=NotOpenSSLWarning)
except Exception:
    pass
warnings.filterwarnings("ignore", message=r".*OpenSSL.*")

from dotenv import load_dotenv
import garminconnect

# =========================================================================
# Configuration
# =========================================================================
ACTIVITY_COUNT = 30          # how many recent activities to pull
PLANNED_WINDOW_BACK = 60     # days before today to scan for planned workouts
PLANNED_WINDOW_FWD = 30      # days after today to scan for planned workouts

INGEST_DIR = Path(__file__).resolve().parent
REPO_ROOT = INGEST_DIR.parent
DB_PATH = REPO_ROOT / "data" / "garmin.db"
ENV_PATH = INGEST_DIR / ".env"
TOKENSTORE = INGEST_DIR / ".garth"   # gitignored garth token cache


# =========================================================================
# Helpers
# =========================================================================
def pick(d, *keys):
    """First non-None value among keys in dict d, else None.

    Lets us tolerate Garmin's naming drift (e.g. avgPower vs averagePower)
    and missing fields without failing — missing -> NULL."""
    for k in keys:
        v = d.get(k)
        if v is not None:
            return v
    return None


def nested(d, *path):
    """Walk a nested dict path, returning None if any link is missing."""
    cur = d
    for k in path:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def dumps(obj):
    return json.dumps(obj, default=str)


def upsert(conn, table, pk_cols, row):
    """Generic INSERT ... ON CONFLICT(pk) DO UPDATE for a dict of columns.

    Returns 'inserted' or 'updated' based on whether the PK already existed."""
    cols = list(row.keys())
    placeholders = ", ".join("?" for _ in cols)
    col_list = ", ".join(cols)
    updates = ", ".join(f"{c}=excluded.{c}" for c in cols if c not in pk_cols)
    conflict = ", ".join(pk_cols)

    where = " AND ".join(f"{c}=?" for c in pk_cols)
    existed = conn.execute(
        f"SELECT 1 FROM {table} WHERE {where}", [row[c] for c in pk_cols]
    ).fetchone()

    conn.execute(
        f"INSERT INTO {table} ({col_list}) VALUES ({placeholders}) "
        f"ON CONFLICT({conflict}) DO UPDATE SET {updates}",
        [row[c] for c in cols],
    )
    return "updated" if existed else "inserted"


def prompt_mfa():
    """Interactive MFA — Garmin calls this only when a code is required."""
    return input("Enter Garmin MFA / 2FA code: ").strip()


def login():
    """Resume a cached garth session if possible, else do a full (possibly
    MFA-prompting) login and persist tokens to TOKENSTORE."""
    email = os.getenv("GARMIN_EMAIL")
    password = os.getenv("GARMIN_PASSWORD")
    if not email or not password:
        raise SystemExit("GARMIN_EMAIL / GARMIN_PASSWORD not set in ingest/.env")

    g = garminconnect.Garmin(email, password, prompt_mfa=prompt_mfa)
    try:
        g.login(str(TOKENSTORE))   # resume from cached tokens (no MFA)
        print("Resumed cached Garmin session.")
    except Exception:
        print("No valid cached session — performing full login.")
        g.login()                  # full login; prompt_mfa fires if needed
        g.garth.dump(str(TOKENSTORE))
        print(f"Saved session tokens to {TOKENSTORE}")
    return g


def months_between(start, end):
    """Inclusive list of (year, month) tuples spanning start..end."""
    out = []
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        out.append((y, m))
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return out


# =========================================================================
# Pull 1 — Activities (+ laps per activity)
# =========================================================================
def ingest_activities(g, conn, summary):
    acts = g.get_activities(0, ACTIVITY_COUNT)
    if isinstance(acts, dict):
        acts = [acts]

    for a in acts:
        aid = a.get("activityId")
        if aid is None:
            continue
        row = {
            "activity_id": aid,
            "name": pick(a, "activityName"),
            "start_time_local": pick(a, "startTimeLocal"),
            "location_name": pick(a, "locationName"),

            "distance_m": pick(a, "distance"),
            "duration_s": pick(a, "duration"),
            "moving_duration_s": pick(a, "movingDuration"),
            "elapsed_duration_s": pick(a, "elapsedDuration"),
            "avg_speed_mps": pick(a, "averageSpeed"),
            "max_speed_mps": pick(a, "maxSpeed"),
            "avg_grade_adjusted_speed_mps": pick(a, "avgGradeAdjustedSpeed"),

            "calories": pick(a, "calories"),
            "bmr_calories": pick(a, "bmrCalories"),
            "steps": pick(a, "steps"),
            "lap_count": pick(a, "lapCount"),

            "avg_hr": pick(a, "averageHR"),
            "max_hr": pick(a, "maxHR"),
            "hr_zone1_s": pick(a, "hrTimeInZone_1"),
            "hr_zone2_s": pick(a, "hrTimeInZone_2"),
            "hr_zone3_s": pick(a, "hrTimeInZone_3"),
            "hr_zone4_s": pick(a, "hrTimeInZone_4"),
            "hr_zone5_s": pick(a, "hrTimeInZone_5"),

            "avg_cadence_spm": pick(a, "averageRunningCadenceInStepsPerMinute"),
            "max_cadence_spm": pick(a, "maxRunningCadenceInStepsPerMinute"),
            "max_double_cadence": pick(a, "maxDoubleCadence"),

            "avg_power": pick(a, "avgPower", "averagePower"),
            "max_power": pick(a, "maxPower"),
            "norm_power": pick(a, "normPower", "normalizedPower"),
            "power_zone1_s": pick(a, "powerTimeInZone_1"),
            "power_zone2_s": pick(a, "powerTimeInZone_2"),
            "power_zone3_s": pick(a, "powerTimeInZone_3"),
            "power_zone4_s": pick(a, "powerTimeInZone_4"),
            "power_zone5_s": pick(a, "powerTimeInZone_5"),

            "avg_ground_contact_ms": pick(a, "avgGroundContactTime"),
            "avg_stride_length_cm": pick(a, "avgStrideLength"),
            "avg_vertical_oscillation_cm": pick(a, "avgVerticalOscillation"),
            "avg_vertical_ratio": pick(a, "avgVerticalRatio"),

            "aerobic_training_effect": pick(a, "aerobicTrainingEffect"),
            "anaerobic_training_effect": pick(a, "anaerobicTrainingEffect"),
            "training_effect_label": pick(a, "trainingEffectLabel"),
            "activity_training_load": pick(a, "activityTrainingLoad"),
            "vo2max": pick(a, "vO2MaxValue"),
            "moderate_intensity_min": pick(a, "moderateIntensityMinutes"),
            "vigorous_intensity_min": pick(a, "vigorousIntensityMinutes"),
            "difference_body_battery": pick(a, "differenceBodyBattery"),

            "elevation_gain_m": pick(a, "elevationGain"),
            "elevation_loss_m": pick(a, "elevationLoss"),
            "avg_elevation_m": pick(a, "avgElevation"),
            "max_elevation_m": pick(a, "maxElevation"),
            "min_elevation_m": pick(a, "minElevation"),

            "start_lat": pick(a, "startLatitude"),
            "start_lng": pick(a, "startLongitude"),
            "end_lat": pick(a, "endLatitude"),
            "end_lng": pick(a, "endLongitude"),

            "fastest_split_1000_s": pick(a, "fastestSplit_1000"),
            "fastest_split_1609_s": pick(a, "fastestSplit_1609"),
            "fastest_split_5000_s": pick(a, "fastestSplit_5000"),

            "raw_json": dumps(a),
        }

        # Skip the splits fetch when this activity is unchanged and laps
        # already exist (cheap idempotency win for the common cron case).
        prior = conn.execute(
            "SELECT duration_s FROM activities WHERE activity_id=?", (aid,)
        ).fetchone()
        have_laps = conn.execute(
            "SELECT COUNT(*) FROM laps WHERE activity_id=?", (aid,)
        ).fetchone()[0]
        unchanged = prior is not None and prior[0] == row["duration_s"] and have_laps > 0

        result = upsert(conn, "activities", ["activity_id"], row)
        summary["activities"][result] += 1

        if not unchanged:
            ingest_laps(g, conn, aid, summary)


def ingest_laps(g, conn, aid, summary):
    try:
        splits = g.get_activity_splits(aid)
    except Exception as e:
        summary["errors"].append(f"laps {aid}: {e}")
        return

    laps = splits.get("lapDTOs", []) if isinstance(splits, dict) else []
    for i, lap in enumerate(laps):
        row = {
            "activity_id": aid,
            "lap_index": pick(lap, "lapIndex") or i,

            "distance_m": pick(lap, "distance"),
            "duration_s": pick(lap, "duration"),
            "moving_duration_s": pick(lap, "movingDuration"),
            "avg_speed_mps": pick(lap, "averageSpeed"),
            "max_speed_mps": pick(lap, "maxSpeed"),
            "avg_grade_adjusted_speed_mps": pick(lap, "avgGradeAdjustedSpeed"),

            "avg_hr": pick(lap, "averageHR"),
            "max_hr": pick(lap, "maxHR"),

            "avg_cadence_spm": pick(lap, "averageRunCadence",
                                   "averageRunningCadenceInStepsPerMinute"),
            "max_cadence_spm": pick(lap, "maxRunCadence",
                                   "maxRunningCadenceInStepsPerMinute"),

            "avg_power": pick(lap, "averagePower", "avgPower"),
            "max_power": pick(lap, "maxPower"),
            "norm_power": pick(lap, "normalizedPower", "normPower"),

            "ground_contact_ms": pick(lap, "groundContactTime"),
            "stride_length_cm": pick(lap, "strideLength"),
            "vertical_oscillation_cm": pick(lap, "verticalOscillation"),
            "vertical_ratio": pick(lap, "verticalRatio"),

            "elevation_gain_m": pick(lap, "elevationGain"),
            "elevation_loss_m": pick(lap, "elevationLoss"),

            "intensity_type": pick(lap, "intensityType"),
            "calories": pick(lap, "calories"),

            "raw_json": dumps(lap),
        }
        result = upsert(conn, "laps", ["activity_id", "lap_index"], row)
        summary["laps"][result] += 1


# =========================================================================
# Pull 2 — Planned workouts (Runna's prescriptions)
# =========================================================================
def ingest_planned(g, conn, summary):
    today = date.today()
    start = today - timedelta(days=PLANNED_WINDOW_BACK)
    end = today + timedelta(days=PLANNED_WINDOW_FWD)

    for (yy, mm) in months_between(start, end):
        try:
            cal = g.get_scheduled_workouts(yy, mm)
        except Exception as e:
            summary["errors"].append(f"planned {yy}-{mm:02d}: {e}")
            continue

        items = cal.get("calendarItems", []) if isinstance(cal, dict) else []
        for item in items:
            if str(item.get("itemType", "")).lower() != "workout":
                continue
            sched_id = item.get("id")
            if sched_id is None:
                continue

            detail = None
            try:
                detail = g.get_scheduled_workout_by_id(sched_id)
            except Exception as e:
                summary["errors"].append(f"planned detail {sched_id}: {e}")
            detail = detail or {}

            # In the detail payload the workout body is nested under "workout";
            # "race" is a top-level boolean. Distance/duration estimates can be
            # null at workout level — fall back to the segment, then to the
            # calendar item's own distance/duration.
            workout = detail.get("workout") or {}
            segments = workout.get("workoutSegments") or []
            seg0 = segments[0] if segments else {}

            row = {
                "schedule_id": sched_id,
                "workout_id": pick(workout, "workoutId") or pick(item, "workoutId"),
                "calendar_date": pick(detail, "calendarDate") or pick(item, "date"),
                "title": pick(item, "title") or pick(workout, "workoutName"),
                "sport_type": nested(workout, "sportType", "sportTypeKey")
                              or pick(item, "sportTypeKey"),
                "is_race": 1 if (pick(detail, "race") or pick(item, "isRace")) else 0,
                "estimated_distance_m": pick(workout, "estimatedDistanceInMeters") or
                                        pick(seg0, "estimatedDistanceInMeters") or
                                        pick(item, "distance"),
                "estimated_duration_s": pick(workout, "estimatedDurationInSecs") or
                                        pick(seg0, "estimatedDurationInSecs") or
                                        pick(item, "duration"),
                "steps_json": dumps(segments) if segments else None,
                "raw_json": dumps(detail or item),
            }
            result = upsert(conn, "planned_workouts", ["schedule_id"], row)
            summary["planned"][result] += 1


# =========================================================================
# Main
# =========================================================================
def main():
    load_dotenv(ENV_PATH)

    summary = {
        "activities": {"inserted": 0, "updated": 0},
        "laps": {"inserted": 0, "updated": 0},
        "planned": {"inserted": 0, "updated": 0},
        "errors": [],
    }

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON;")

    g = login()

    for label, fn in (("activities", ingest_activities),
                      ("planned", ingest_planned)):
        try:
            fn(g, conn, summary)
            conn.commit()
        except Exception as e:
            summary["errors"].append(f"{label} pull failed: {e}")

    conn.close()

    # --- Summary -----------------------------------------------------------
    print("\n=== Ingest summary ===")
    for t in ("activities", "laps", "planned"):
        s = summary[t]
        print(f"{t:12s} inserted={s['inserted']:4d}  updated={s['updated']:4d}")
    if summary["errors"]:
        print(f"\n{len(summary['errors'])} error(s):")
        for e in summary["errors"]:
            print(f"  - {e}")
    else:
        print("\nNo errors.")


if __name__ == "__main__":
    main()
