#!/usr/local/bin/python3.13
"""Garmin Hub ingest — pulls Garmin data and upserts into the garminhub
Postgres database (connection from DATABASE_URL; see db/README.md).

Idempotent (safe to re-run from cron): all writes are upserts. Token caching
means MFA is only needed on first login / token expiry.

Run with Homebrew Python 3.13 (NOT Apple's 3.9):
    /usr/local/bin/python3.13 ingest/ingest.py
"""

import os
import re
import sys
import json
import time
import hashlib
import warnings
from pathlib import Path
from datetime import date, datetime, timedelta, timezone

# --- Suppress the harmless LibreSSL-vs-OpenSSL warning (NotOpenSSLWarning) ---
try:
    from urllib3.exceptions import NotOpenSSLWarning
    warnings.filterwarnings("ignore", category=NotOpenSSLWarning)
except Exception:
    pass
warnings.filterwarnings("ignore", message=r".*OpenSSL.*")

from dotenv import load_dotenv
import psycopg
import garminconnect

# =========================================================================
# Configuration
# =========================================================================
ACTIVITY_COUNT = 30          # how many recent activities to pull
PLANNED_WINDOW_BACK = 60     # days before today to scan for planned workouts
PLANNED_WINDOW_FWD = 84      # days after today to scan (12 wks — the coach's
                             # get_scheduled_workouts tool reaches this far)
RECOVERY_WINDOW = 30         # days back from today to fetch recovery data
RECOVERY_REFETCH = 3         # always re-fetch the most recent N days (fill in late)
RECOVERY_DELAY_S = 0.5       # pause between per-date fetches (rate-limit courtesy)
GEAR_DELAY_S = 0.5           # pause between gear and weather API calls
RATE_LIMIT_BACKOFF_S = 5

# Garmin personal-record typeIds we surface — running only. Garmin sends no
# human label (prTypeLabelKey is null), so the typeId -> (label, value_kind) map
# is hardcoded here. value_kind tells callers how to read `value`: time PRs are
# seconds, Longest Run is metres. Non-running typeIds (step records 12-16 etc.)
# are intentionally filtered out.
PR_TYPES = {
    1: ("1 km", "time"),
    2: ("1 mile", "time"),
    3: ("5K", "time"),
    4: ("10K", "time"),
    5: ("Half Marathon", "time"),
    7: ("Longest Run", "distance"),
}

INGEST_DIR = Path(__file__).resolve().parent
# Postgres DSN — override via DATABASE_URL (ingest/.env or the environment).
# The rw role is DML-only; DDL is db/schema.pg.sql, applied by db/setup_local.sh.
DEFAULT_DSN = "postgres://garminhub_rw:garminhub_rw@localhost:5432/garminhub"
ENV_PATH = INGEST_DIR / ".env"
TOKENSTORE = Path(os.environ.get("TOKENSTORE", str(INGEST_DIR / ".garth")))

# Garmin's lactate-threshold speed comes back needing a x10 scale to reach true
# m/s (confirmed against Garmin Connect's displayed LT pace). Single named knob
# so it's trivial to change if that ever differs.
LT_SPEED_SCALE = 10


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


def as_list(value, *keys):
    """Normalise Garmin endpoints that vary between list and wrapper dicts."""
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in keys:
            if isinstance(value.get(key), list):
                return value[key]
        return [value] if any(value.values()) else []
    return []


def dumps(obj):
    return json.dumps(obj, default=str)


_RACE_RE = re.compile(r"\b(race|parkrun)\b", re.IGNORECASE)


def is_race_keyword(*texts):
    """1 if any text contains the whole word 'race' or 'parkrun', else 0.

    Garmin's own race flag is unreliable (false even for titles like
    '10km Race'), so we derive race status from the title/description."""
    return 1 if any(t and _RACE_RE.search(t) for t in texts) else 0


def activity_group(type_key):
    """Bucket a Garmin activityType.typeKey into a coarse group for filtering.

    run      ← any *_running variant (running, treadmill_running, trail_running…)
    football ← Garmin's 'soccer' (or 'football')
    walk     ← any *walking variant
    other    ← everything else"""
    k = (type_key or "").lower()
    if "running" in k:
        return "run"
    if k in ("soccer", "football"):
        return "football"
    if "walking" in k:
        return "walk"
    return "other"


def upsert(conn, table, pk_cols, row):
    """Generic INSERT ... ON CONFLICT(pk) DO UPDATE for a dict of columns.

    Returns 'inserted' or 'updated': xmax = 0 on the returned row means the
    INSERT arm ran (no prior row version), so no separate existence probe."""
    cols = list(row.keys())
    placeholders = ", ".join("%s" for _ in cols)
    col_list = ", ".join(cols)
    updates = ", ".join(f"{c}=excluded.{c}" for c in cols if c not in pk_cols)
    conflict = ", ".join(pk_cols)

    cur = conn.execute(
        f"INSERT INTO {table} ({col_list}) VALUES ({placeholders}) "
        f"ON CONFLICT({conflict}) DO UPDATE SET {updates} "
        f"RETURNING (xmax = 0)",
        [row[c] for c in cols],
    )
    return "inserted" if cur.fetchone()[0] else "updated"


def prompt_mfa():
    """Interactive MFA. Garmin calls this only when a code is required."""
    return input("Enter Garmin MFA / 2FA code: ").strip()


class GarminReauthRequired(RuntimeError):
    pass


def login(client_factory=garminconnect.Garmin, tokenstore=TOKENSTORE, stdin=sys.stdin):
    """Resume cached tokens, or perform an interactive login that saves them."""
    tokenstore = Path(tokenstore)
    email = os.getenv("GARMIN_EMAIL")
    password = os.getenv("GARMIN_PASSWORD")

    if tokenstore.exists():
        cached = client_factory()
        try:
            cached.login(str(tokenstore))
            print("Resumed cached Garmin session.")
            return cached
        except Exception as error:
            print(f"Cached Garmin session is invalid: {error}")

    if not getattr(stdin, "isatty", lambda: False)():
        raise GarminReauthRequired(
            "Garmin login expired: re-authorise interactively and copy the token cache")
    if not email or not password:
        raise GarminReauthRequired(
            "Garmin login expired: GARMIN_EMAIL / GARMIN_PASSWORD are required")

    print("Performing interactive Garmin login.")
    fresh = client_factory(email, password, prompt_mfa=prompt_mfa)
    fresh.login(str(tokenstore))
    token_files = tokenstore.exists() and any(
        path.is_file() for path in tokenstore.rglob("*"))
    if token_files:
        print(f"Saved session tokens to {tokenstore}")
    else:
        print(f"Warning: Garmin login succeeded but no session tokens were saved to {tokenstore}")
    return fresh


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
            "activity_type": nested(a, "activityType", "typeKey"),
            "activity_group": activity_group(nested(a, "activityType", "typeKey")),

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
            "SELECT duration_s FROM activities WHERE activity_id=%s", (aid,)
        ).fetchone()
        have_laps = conn.execute(
            "SELECT COUNT(*) FROM laps WHERE activity_id=%s", (aid,)
        ).fetchone()[0]
        unchanged = prior is not None and prior[0] == row["duration_s"] and have_laps > 0

        result = upsert(conn, "activities", ["activity_id"], row)
        summary["activities"][result] += 1

        if not unchanged:
            ingest_laps(g, conn, aid, summary)
            if row["activity_group"] == "run":
                summary["_changed_run_ids"].append(aid)


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

    # Track every schedule_id the calendar returned this run, plus whether any
    # month fetch failed — so stale-row cleanup below can safely delete future
    # workouts Garmin no longer lists (a replaced Runna plan) WITHOUT nuking
    # rows just because a transient fetch error hid them.
    seen_ids = set()
    fetch_failed = False

    for (yy, mm) in months_between(start, end):
        try:
            cal = g.get_scheduled_workouts(yy, mm)
        except Exception as e:
            summary["errors"].append(f"planned {yy}-{mm:02d}: {e}")
            fetch_failed = True
            continue

        items = cal.get("calendarItems", []) if isinstance(cal, dict) else []
        for item in items:
            if str(item.get("itemType", "")).lower() != "workout":
                continue
            sched_id = item.get("id")
            if sched_id is None:
                continue
            seen_ids.add(sched_id)

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
                "source": "garmin",
                "raw_json": dumps(detail or item),
            }
            result = upsert(conn, "planned_workouts", ["schedule_id"], row)
            summary["planned"][result] += 1

    # Stale-plan cleanup: drop FUTURE planned rows the calendar no longer lists
    # (Runna replaced/rescheduled the plan). Past rows are left untouched — they
    # are history. Skipped entirely if any month fetch failed, so a transient
    # Garmin error can never mass-delete a still-valid plan. Scoped to this
    # source only, so a Garmin fetch can never wipe ical rows (and vice versa).
    if not fetch_failed:
        summary["planned"]["deleted"] += _delete_stale(conn, "garmin", seen_ids)


def _delete_stale(conn, source, seen_ids):
    """Delete FUTURE planned_workouts rows of one source not in seen_ids.
    Only ever called with 'garmin' / 'runna_ical' — the source = %s scope means
    source='app' rows (API-written, Stage 9) are immune to ingest cleanup."""
    today_str = str(date.today())
    if seen_ids:
        marks = ", ".join("%s" for _ in seen_ids)
        cur = conn.execute(
            f"DELETE FROM planned_workouts WHERE calendar_date >= %s AND source = %s "
            f"AND schedule_id NOT IN ({marks})",
            [today_str, source, *seen_ids],
        )
    else:
        cur = conn.execute(
            "DELETE FROM planned_workouts WHERE calendar_date >= %s AND source = %s",
            [today_str, source],
        )
    return cur.rowcount


# =========================================================================
# Pull 2b — Runna ical feed (the FULL plan; Garmin only syncs ~2 weeks)
# =========================================================================
_DIST_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(km|k)\b", re.IGNORECASE)


def _ical_distance_m(*texts):
    """Best-effort distance from free text ('7.5km run', '10K') -> metres."""
    for t in texts:
        m = _DIST_RE.search(t or "")
        if m:
            return float(m.group(1)) * 1000
    return None


def _ical_schedule_id(uid):
    """Stable NEGATIVE int id from the event UID — negative so it can never
    collide with Garmin's (positive) calendar item ids in the shared PK."""
    return -int(hashlib.sha1(uid.encode()).hexdigest()[:15], 16)


def _ical_steps(description):
    """Description text -> JSON array of step lines (less structured than
    Garmin's steps_json, by design). Drops blanks and link lines ("View in
    the Runna app: https://…") — noise for the coach."""
    lines = [ln.strip() for ln in (description or "").splitlines()]
    lines = [ln for ln in lines if ln and not re.search(r"https?://", ln)]
    return dumps(lines) if lines else None


def ingest_runna_ical(g, conn, summary):
    """Pull the full Runna plan from the profile's ical feed URL (if set).

    Runs AFTER ingest_planned: any date the Garmin calendar already covers is
    skipped (the Garmin row carries richer step JSON), so the ical rows only
    fill in the future beyond Garmin's ~2-week sync horizon. Same window,
    same per-source stale cleanup + fetch-failed guard as the Garmin pull."""
    row = conn.execute("SELECT runna_ical_url FROM profile WHERE id = 1").fetchone()
    url = (row[0] or "").strip() if row else ""
    if not url:
        return  # feature off — never touches ical rows, no cleanup
    import requests
    from icalendar import Calendar

    today = date.today()
    end = today + timedelta(days=PLANNED_WINDOW_FWD)

    try:
        resp = requests.get(re.sub(r"^webcal://", "https://", url), timeout=30)
        resp.raise_for_status()
        cal = Calendar.from_ical(resp.content)
    except Exception as e:
        summary["errors"].append(f"runna_ical: {e}")
        return  # fetch failed — skip upserts AND cleanup (guard, per-source)

    # Dates the Garmin calendar already covers (upserted just above in this
    # run) — keep those rows, skip the ical duplicate. ::text so the set holds
    # 'YYYY-MM-DD' strings (the column is a date; a datetime.date would never
    # match cal_date below and the dedupe would silently stop working).
    garmin_dates = {r[0] for r in conn.execute(
        "SELECT DISTINCT calendar_date::text FROM planned_workouts WHERE source = 'garmin'"
    )}

    seen_ids = set()
    for ev in cal.walk("VEVENT"):
        dtstart = ev.get("dtstart")
        if dtstart is None:
            continue
        d = dtstart.dt.date() if isinstance(dtstart.dt, datetime) else dtstart.dt
        if d < today or d > end:
            continue
        uid = str(ev.get("uid") or f"{d}-{ev.get('summary')}")
        title = str(ev.get("summary") or "").strip() or None
        description = str(ev.get("description") or "")
        cal_date = str(d)
        if cal_date in garmin_dates:
            continue  # Garmin row is richer — not marked seen, so a previously
                      # ingested ical row for this date gets stale-cleaned below

        sched_id = _ical_schedule_id(uid)
        seen_ids.add(sched_id)
        row = {
            "schedule_id": sched_id,
            "workout_id": None,
            "calendar_date": cal_date,
            "title": title,
            "sport_type": "running",
            "is_race_auto": is_race_keyword(title, description),
            "estimated_distance_m": _ical_distance_m(title, description),
            "estimated_duration_s": None,
            "steps_json": _ical_steps(description),
            "source": "runna_ical",
            "raw_json": dumps({"uid": uid, "date": cal_date, "summary": title,
                               "description": description}),
        }
        result = upsert(conn, "planned_workouts", ["schedule_id"], row)
        summary["runna_ical"][result] += 1

    summary["runna_ical"]["deleted"] += _delete_stale(conn, "runna_ical", seen_ids)


# =========================================================================
# Pull 3 — Recovery (HRV, sleep, readiness, stress, body battery per day)
# =========================================================================
def _is_rate_limit(e):
    """True if an exception looks like a Garmin 429 / rate-limit response."""
    s = str(e).lower()
    return "429" in s or "too many requests" in s or "rate limit" in s


def call_with_rate_limit_retry(call, label, sleep=time.sleep,
                               backoff_s=RATE_LIMIT_BACKOFF_S):
    """Call Garmin once, backing off and retrying one 429 response."""
    try:
        return call()
    except Exception as error:
        if not _is_rate_limit(error):
            raise
        print(f"  {label} rate-limited, backing off {backoff_s}s, retrying once")
        sleep(backoff_s)
        return call()


# =========================================================================
# Pull 3 - Gear assignment and activity weather
# =========================================================================
def gear_row(item, stats=None):
    stats = stats or {}
    combined = {**item, **stats}
    uuid = pick(combined, "uuid", "gearUuid", "gearUUID")
    if not uuid:
        return None
    status = pick(combined, "gearStatusName", "status")
    return {
        "gear_uuid": str(uuid),
        "display_name": pick(combined, "displayName", "gearName", "name"),
        "make_name": pick(combined, "gearMakeName", "makeName"),
        "model_name": pick(combined, "gearModelName", "modelName", "customMakeModel"),
        "status": status,
        "date_begin": pick(combined, "dateBegin"),
        "retired": str(status or "").lower() not in ("", "active"),
        "garmin_total_distance_m": pick(combined, "totalDistance", "totalDistanceMeters"),
        "raw_json": dumps({"gear": item, "stats": stats}),
    }


def weather_row(payload):
    payload = payload if isinstance(payload, dict) else {}
    return {
        "temperature_c": pick(payload, "temp", "temperature"),
        "apparent_temperature_c": pick(payload, "apparentTemp", "apparentTemperature"),
        "humidity_pct": pick(payload, "relativeHumidity", "humidity"),
        "dew_point_c": pick(payload, "dewPoint"),
        "wind_speed_mps": pick(payload, "windSpeed"),
        "weather_raw_json": dumps(payload),
    }


def ingest_gear(g, conn, summary, sleep=time.sleep):
    profile_key = getattr(g, "display_name", None)
    if not profile_key:
        raise RuntimeError("Garmin display name unavailable for gear lookup")
    items = as_list(g.get_gear(profile_key), "gear", "gearStats")
    for item in items:
        uuid = pick(item, "uuid", "gearUuid", "gearUUID")
        if not uuid:
            continue
        stats = call_with_rate_limit_retry(
            lambda uuid=uuid: g.get_gear_stats(uuid), f"gear stats {uuid}", sleep)
        row = gear_row(item, stats)
        result = upsert(conn, "gear", ["gear_uuid"], row)
        summary["gear"][result] += 1
        activities = call_with_rate_limit_retry(
            lambda uuid=uuid: g.get_gear_activities(uuid),
            f"gear activities {uuid}", sleep)
        for activity in as_list(activities, "activities", "activityList"):
            aid = pick(activity, "activityId", "activity_id")
            if aid is not None:
                conn.execute(
                    "UPDATE activities SET gear_uuid=%s WHERE activity_id=%s",
                    (str(uuid), aid))
        sleep(GEAR_DELAY_S)


def ingest_activity_weather(g, conn, summary, sleep=time.sleep):
    for aid in summary["_changed_run_ids"]:
        existing = conn.execute(
            "SELECT weather_raw_json FROM activities WHERE activity_id=%s", (aid,)
        ).fetchone()
        if not existing or existing[0] is not None:
            continue
        try:
            payload = call_with_rate_limit_retry(
                lambda aid=aid: g.get_activity_weather(aid),
                f"weather {aid}", sleep)
            values = weather_row(payload)
            assignments = ", ".join(f"{key}=%s" for key in values)
            conn.execute(
                f"UPDATE activities SET {assignments} WHERE activity_id=%s",
                [*values.values(), aid])
            summary["weather"]["updated"] += 1
        except Exception as error:
            summary["errors"].append(f"weather {aid}: {error}")
        sleep(GEAR_DELAY_S)


def ingest_recovery(g, conn, summary):
    today = date.today()
    dates = [str(today - timedelta(days=i)) for i in range(RECOVERY_WINDOW)]

    # Skip dates already stored, but always re-fetch the most recent few —
    # same-day/recent recovery metrics (sleep, readiness) fill in late.
    # ::text to match the 'YYYY-MM-DD' strings in `dates` (column is a date).
    existing = {r[0] for r in
                conn.execute("SELECT calendar_date::text FROM recovery").fetchall()}
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
            print(f"  recovery {d}: rate-limited, backing off {RATE_LIMIT_BACKOFF_S}s, retrying once")
            time.sleep(RATE_LIMIT_BACKOFF_S)
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
        # Garmin RESETS readiness after a workout, so `tr` — the newest snapshot
        # — is the post-exercise value on any day with a run. That is an effect
        # of the session, not the state the athlete began it in (a real case:
        # woke at 94, read 27 after a 16km progressive long run), and the coach
        # was reading it as the latter. Keep the day's wake-up reading beside it
        # as the genuine pre-training baseline. Newest-first ordering means the
        # first match is the most recent wake-up reset.
        tr_wake = next((x for x in tr_list
                        if isinstance(x, dict)
                        and x.get("inputContext") == "AFTER_WAKEUP_RESET"),
                       {}) if isinstance(tr_list, list) else {}
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
            "readiness_context": pick(tr, "inputContext"),
            "readiness_time_local": pick(tr, "timestampLocal"),
            "readiness_wake_score": pick(tr_wake, "score"),
            "readiness_wake_level": pick(tr_wake, "level"),
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
# Pull 4 — Personal records (Garmin-sourced running bests)
# =========================================================================
def ingest_personal_records(g, conn, summary):
    try:
        records = g.get_personal_record()
    except Exception as e:
        summary["errors"].append(f"personal_records: {e}")
        return
    if not isinstance(records, list):
        records = []

    for rec in records:
        type_id = rec.get("typeId")
        if type_id not in PR_TYPES:   # running PRs only; skip step records etc.
            continue
        label, value_kind = PR_TYPES[type_id]
        # Record date: prefer the source activity's local start, fall back to
        # the PR set-time fields; keep just the ISO date (drop the time part).
        stamp = pick(rec, "activityStartDateTimeLocalFormatted",
                     "prStartTimeLocalFormatted",
                     "actStartDateTimeInGMTFormatted",
                     "prStartTimeGmtFormatted")
        record_date = stamp[:10] if stamp else None
        activity_id = pick(rec, "activityId")
        row = {
            "type_id": type_id,
            "label": label,
            "value": pick(rec, "value"),
            "value_kind": value_kind,
            "activity_id": activity_id or None,   # Garmin sends 0 when not run-tied
            "record_date": record_date,
            "raw_json": dumps(rec),
        }
        # Upsert on type_id: one row per record type, so a beaten PR overwrites.
        result = upsert(conn, "personal_records", ["type_id"], row)
        summary["personal_records"][result] += 1


# =========================================================================
# Pull 5 — Race predictions (Garmin's current predicted race times)
# =========================================================================
def ingest_race_predictions(g, conn, summary):
    try:
        rp = g.get_race_predictions()
    except Exception as e:
        summary["errors"].append(f"race_predictions: {e}")
        return
    if not isinstance(rp, dict) or not rp:
        return

    row = {
        "calendar_date": pick(rp, "calendarDate") or str(date.today()),
        "time_5k_s": pick(rp, "time5K"),
        "time_10k_s": pick(rp, "time10K"),
        "time_half_s": pick(rp, "timeHalfMarathon"),
        "time_marathon_s": pick(rp, "timeMarathon"),
        "fetched_at": str(date.today()),
        "raw_json": dumps(rp),
    }
    result = upsert(conn, "race_predictions", ["calendar_date"], row)
    summary["race_predictions"][result] += 1


def ingest_lactate_threshold(g, conn, summary):
    """Store the current lactate threshold on the profile row (id=1).

    Single current value, NOT a series. Scoped UPDATE of only the three LT
    columns so user-edited profile fields (shoes/races/injuries/routines/notes)
    are never clobbered. Missing/null reading -> log and skip, never crash."""
    try:
        data = g.get_lactate_threshold(latest=True)
    except Exception as e:
        summary["errors"].append(f"lactate_threshold: {e}")
        return
    shr = data.get("speed_and_heart_rate") if isinstance(data, dict) else None
    if not isinstance(shr, dict) or shr.get("speed") is None:
        summary["errors"].append("lactate_threshold: no reading returned")
        return

    conn.execute(
        "UPDATE profile SET lt_speed_mps = %s, lt_hr = %s, lt_detected_date = %s "
        "WHERE id = 1",
        (float(shr["speed"]) * LT_SPEED_SCALE,
         pick(shr, "heartRate"), pick(shr, "calendarDate")),
    )
    summary["lactate_threshold"]["updated"] += 1


# =========================================================================
# Main
# =========================================================================
def new_summary():
    return {
        "activities": {"inserted": 0, "updated": 0},
        "laps": {"inserted": 0, "updated": 0},
        "planned": {"inserted": 0, "updated": 0, "deleted": 0},
        "runna_ical": {"inserted": 0, "updated": 0, "deleted": 0},
        "recovery": {"inserted": 0, "updated": 0},
        "personal_records": {"inserted": 0, "updated": 0},
        "race_predictions": {"inserted": 0, "updated": 0},
        "lactate_threshold": {"inserted": 0, "updated": 0},
        "gear": {"inserted": 0, "updated": 0},
        "weather": {"inserted": 0, "updated": 0},
        "_changed_run_ids": [],
        "errors": [],
    }


def record_ingest_state(conn, summary):
    ok = not summary["errors"]
    state = ("no errors" if ok
             else f"{len(summary['errors'])} error(s): "
                  + "; ".join(summary["errors"][:3]))
    try:
        upsert(conn, "ingest_state", ["id"], {
            "id": 1,
            "last_run_at": datetime.now(timezone.utc),
            "ok": ok,
            "summary": state[:500],
        })
        conn.commit()
    except Exception as error:
        conn.rollback()
        print(f"  (could not record ingest_state: {error})")


def run_sections(g, conn, summary, sections):
    """Run independent ingest transactions so one failure cannot poison later pulls."""
    for label, fn in sections:
        try:
            fn(g, conn, summary)
            conn.commit()
        except Exception as error:
            conn.rollback()
            summary["errors"].append(f"{label} pull failed: {error}")


def main():
    load_dotenv(ENV_PATH)

    summary = new_summary()

    conn = psycopg.connect(os.getenv("DATABASE_URL", DEFAULT_DSN))

    try:
        g = login()
    except Exception as error:
        print(f"Garmin login failed: {error}")
        summary["errors"].append("Garmin login expired: re-authorise")
        record_ingest_state(conn, summary)
        conn.close()
        raise SystemExit(1) from error

    run_sections(g, conn, summary, (
        ("activities", ingest_activities),
        ("gear", ingest_gear),
        ("weather", ingest_activity_weather),
        ("planned", ingest_planned),
        ("runna_ical", ingest_runna_ical),
        ("recovery", ingest_recovery),
        ("personal_records", ingest_personal_records),
        ("race_predictions", ingest_race_predictions),
        ("lactate_threshold", ingest_lactate_threshold),
    ))

    # --- Record the run ----------------------------------------------------
    # Written here, at the end of main, so EVERY ingest path records itself:
    # the launchd schedules, the API's Refresh spawn, and a manual terminal run.
    # Its own try/except — bookkeeping must never be the thing that fails a
    # run that actually pulled data.
    record_ingest_state(conn, summary)

    conn.close()

    # --- Summary -----------------------------------------------------------
    print("\n=== Ingest summary ===")
    for t in ("activities", "laps", "planned", "runna_ical", "recovery",
              "personal_records", "race_predictions", "lactate_threshold",
              "gear", "weather"):
        s = summary[t]
        extra = f"  deleted={s['deleted']:4d}" if "deleted" in s else ""
        print(f"{t:12s} inserted={s['inserted']:4d}  updated={s['updated']:4d}{extra}")
    if summary["errors"]:
        print(f"\n{len(summary['errors'])} error(s):")
        for e in summary["errors"]:
            print(f"  - {e}")
        # Non-zero exit so cron/daily.sh and /api/ingest/refresh see the
        # failure instead of a clean 0 from a (partially) failed pull.
        sys.exit(1)
    print("\nNo errors.")


if __name__ == "__main__":
    main()
