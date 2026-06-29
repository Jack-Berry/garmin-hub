#!/usr/local/bin/python3.13
"""Garmin Hub ingest — pulls Garmin data and upserts into data/garmin.db.

Idempotent (safe to re-run from cron): all writes are upserts. Token caching
means MFA is only needed on first login / token expiry.

Run with Homebrew Python 3.13 (NOT Apple's 3.9):
    /usr/local/bin/python3.13 ingest/ingest.py
"""

import os
import re
import json
import time
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
RECOVERY_WINDOW = 30         # days back from today to fetch recovery data
RECOVERY_REFETCH = 3         # always re-fetch the most recent N days (fill in late)
RECOVERY_DELAY_S = 0.5       # pause between per-date fetches (rate-limit courtesy)

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


def first(*vals):
    """First value that is not None (preserves 0, 0.0, False)."""
    for v in vals:
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


_RACE_RE = re.compile(r"\b(race|parkrun)\b", re.IGNORECASE)


def is_race_keyword(*texts):
    """1 if any text contains the whole word 'race' or 'parkrun', else 0.

    Garmin's own race flag is unreliable (false even for titles like
    '10km Race'), so we derive race status from the title/description."""
    return 1 if any(t and _RACE_RE.search(t) for t in texts) else 0


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
                "workout_id": first(pick(workout, "workoutId"), pick(item, "workoutId")),
                "calendar_date": pick(detail, "calendarDate") or pick(item, "date"),
                "title": pick(item, "title") or pick(workout, "workoutName"),
                "sport_type": nested(workout, "sportType", "sportTypeKey")
                              or pick(item, "sportTypeKey"),
                # Keyword-derived; is_race_override is intentionally NOT written
                # here so manual overrides survive re-ingest.
                "is_race_auto": is_race_keyword(pick(item, "title"),
                                                pick(workout, "description"),
                                                pick(workout, "workoutName")),
                "estimated_distance_m": first(pick(workout, "estimatedDistanceInMeters"),
                                              pick(seg0, "estimatedDistanceInMeters"),
                                              pick(item, "distance")),
                "estimated_duration_s": first(pick(workout, "estimatedDurationInSecs"),
                                              pick(seg0, "estimatedDurationInSecs"),
                                              pick(item, "duration")),
                "steps_json": dumps(segments) if segments else None,
                "raw_json": dumps(detail or item),
            }
            result = upsert(conn, "planned_workouts", ["schedule_id"], row)
            summary["planned"][result] += 1


# =========================================================================
# Pull 3 — Recovery (HRV, sleep, readiness, stress, body battery per day)
# =========================================================================
def _is_rate_limit(e):
    """True if an exception looks like a Garmin 429 / rate-limit response."""
    s = str(e).lower()
    return "429" in s or "too many requests" in s or "rate limit" in s


def ingest_recovery(g, conn, summary):
    today = date.today()
    dates = [str(today - timedelta(days=i)) for i in range(RECOVERY_WINDOW)]

    # Skip dates already stored, but always re-fetch the most recent few —
    # same-day/recent recovery metrics (sleep, readiness) fill in late.
    existing = {r[0] for r in
                conn.execute("SELECT calendar_date FROM recovery").fetchall()}
    recent = set(dates[:RECOVERY_REFETCH])
    todo = [d for d in dates if d not in existing or d in recent]
    print(f"Fetching recovery for {len(todo)} dates "
          f"(skipping {len(dates) - len(todo)} already stored)…")

    # (key, fn) per per-date shape. A missing/errored shape becomes NULL; a
    # rate-limit error is re-raised so the whole date can be backed off + retried.
    shapes = (
        ("hrv_data", lambda d: g.get_hrv_data(d)),
        ("rhr_day", lambda d: g.get_rhr_day(d)),
        ("sleep_data", lambda d: g.get_sleep_data(d)),
        ("training_readiness", lambda d: g.get_training_readiness(d)),
        ("training_status", lambda d: g.get_training_status(d)),
        ("all_day_stress", lambda d: g.get_all_day_stress(d)),
        ("body_battery", lambda d: g.get_body_battery(d, d)),
    )

    def fetch_shapes(d):
        sources, failed = {}, []
        for key, fn in shapes:
            try:
                sources[key] = fn(d)
            except Exception as e:
                if _is_rate_limit(e):
                    raise
                sources[key] = None
                failed.append(key)
        return sources, failed

    for d in todo:
        # Fetch all shapes; on a rate-limit error back off and retry the date once.
        try:
            sources, failed = fetch_shapes(d)
        except Exception:
            print(f"  recovery {d} … rate-limited — backing off 5s, retrying once")
            time.sleep(5)
            try:
                sources, failed = fetch_shapes(d)
            except Exception as e:
                summary["errors"].append(f"recovery {d}: rate-limited: {e}")
                print(f"  recovery {d} … FAILED (rate limit)")
                continue

        hrv = nested(sources.get("hrv_data") or {}, "hrvSummary") or {}
        sleep = nested(sources.get("sleep_data") or {}, "dailySleepDTO") or {}
        stress = sources.get("all_day_stress") or {}
        ts = sources.get("training_status") or {}

        # training_readiness / body_battery are lists (most recent first).
        tr_list = sources.get("training_readiness")
        tr = tr_list[0] if isinstance(tr_list, list) and tr_list else {}
        bb_list = sources.get("body_battery")
        bb = bb_list[0] if isinstance(bb_list, list) and bb_list else {}

        # Resting HR is buried under a metrics map.
        rhr_metrics = nested(sources.get("rhr_day") or {}, "allMetrics",
                             "metricsMap", "WELLNESS_RESTING_HEART_RATE")
        resting_hr = (pick(rhr_metrics[0], "value")
                      if isinstance(rhr_metrics, list) and rhr_metrics else None)

        # Training status: label & vo2max live under device-keyed maps.
        ts_map = nested(ts, "mostRecentTrainingStatus", "latestTrainingStatusData")
        ts_data = next(iter(ts_map.values()), {}) if isinstance(ts_map, dict) else {}
        training_status = pick(ts_data, "trainingStatusFeedbackPhrase")
        vo2max = nested(ts, "mostRecentVO2Max", "generic", "vo2MaxValue")

        row = {
            "calendar_date": d,

            "hrv_last_night": pick(hrv, "lastNightAvg"),
            "hrv_weekly_avg": pick(hrv, "weeklyAvg"),
            "hrv_status": pick(hrv, "status"),
            "hrv_baseline_low": nested(hrv, "baseline", "lowUpper"),
            "hrv_baseline_balanced_low": nested(hrv, "baseline", "balancedLow"),
            "hrv_baseline_balanced_upper": nested(hrv, "baseline", "balancedUpper"),

            "resting_hr": resting_hr,

            "sleep_seconds": pick(sleep, "sleepTimeSeconds"),
            "deep_sleep_seconds": pick(sleep, "deepSleepSeconds"),
            "light_sleep_seconds": pick(sleep, "lightSleepSeconds"),
            "rem_sleep_seconds": pick(sleep, "remSleepSeconds"),
            "awake_seconds": pick(sleep, "awakeSleepSeconds"),
            "sleep_score": nested(sleep, "sleepScores", "overall", "value"),
            "sleep_score_qualifier": nested(sleep, "sleepScores", "overall", "qualifierKey"),
            "avg_sleep_stress": pick(sleep, "avgSleepStress"),

            "readiness_score": pick(tr, "score"),
            "readiness_level": pick(tr, "level"),
            "readiness_feedback": pick(tr, "feedbackShort"),
            "recovery_time_minutes": pick(tr, "recoveryTime"),
            "acute_load": pick(tr, "acuteLoad"),
            "sleep_factor_pct": pick(tr, "sleepScoreFactorPercent"),
            "recovery_time_factor_pct": pick(tr, "recoveryTimeFactorPercent"),
            "acwr_factor_pct": pick(tr, "acwrFactorPercent"),
            "stress_factor_pct": pick(tr, "stressHistoryFactorPercent"),
            "hrv_factor_pct": pick(tr, "hrvFactorPercent"),
            "sleep_history_factor_pct": pick(tr, "sleepHistoryFactorPercent"),

            "training_status": training_status,
            "vo2max": vo2max,

            "avg_stress": pick(stress, "avgStressLevel"),
            "max_stress": pick(stress, "maxStressLevel"),

            "bb_charged": pick(bb, "charged"),
            "bb_drained": pick(bb, "drained"),

            "raw_json": dumps(sources),
        }
        result = upsert(conn, "recovery", ["calendar_date"], row)
        summary["recovery"][result] += 1
        status = "ok" if not failed else "ok (missing: " + ", ".join(failed) + ")"
        print(f"  recovery {d} … {status}")
        time.sleep(RECOVERY_DELAY_S)


# =========================================================================
# Main
# =========================================================================
def main():
    load_dotenv(ENV_PATH)

    summary = {
        "activities": {"inserted": 0, "updated": 0},
        "laps": {"inserted": 0, "updated": 0},
        "planned": {"inserted": 0, "updated": 0},
        "recovery": {"inserted": 0, "updated": 0},
        "errors": [],
    }

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA foreign_keys = ON;")

    g = login()

    for label, fn in (("activities", ingest_activities),
                      ("planned", ingest_planned),
                      ("recovery", ingest_recovery)):
        try:
            fn(g, conn, summary)
            conn.commit()
        except Exception as e:
            summary["errors"].append(f"{label} pull failed: {e}")

    conn.close()

    # --- Summary -----------------------------------------------------------
    print("\n=== Ingest summary ===")
    for t in ("activities", "laps", "planned", "recovery"):
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
