#!/usr/local/bin/python3.13
"""Resumable Garmin gear and weather backfill for historical runs."""

import argparse
import os
import time
from datetime import date, timedelta

from dotenv import load_dotenv
import psycopg

from ingest import (
    DEFAULT_DSN, ENV_PATH, WEATHER_RETRY_DAYS, _is_rate_limit,
    call_with_rate_limit_retry, dumps, login, weather_row,
)

CALL_DELAY_S = 2.0


def is_activity_failure(error):
    """True only for a failure tied to this one activity (not found, or a
    payload we cannot parse). Rate limits, expired sessions and network or
    database errors stop the backfill instead, so a rerun can resume without
    any run being wrongly marked as having no weather."""
    if _is_rate_limit(error) or "auth" in type(error).__name__.lower():
        return False
    status = getattr(error, "status_code", None) or getattr(
        getattr(error, "response", None), "status_code", None)
    return status == 404 or "404" in str(error) or isinstance(error, (ValueError, TypeError))


def pending_work(conn):
    gear = [row[0] for row in conn.execute(
        "SELECT gear_uuid FROM gear ORDER BY retired, display_name, gear_uuid").fetchall()]
    weather = list(conn.execute(
        "SELECT activity_id, start_time_local::date FROM activities "
        "WHERE activity_group='run' AND weather_raw_json IS NULL "
        "AND start_lat IS NOT NULL "
        "AND activity_type !~* '(treadmill|indoor)' "
        "ORDER BY start_time_local DESC").fetchall())
    return gear, weather


def planned_call_count(conn, limit):
    gear, weather = pending_work(conn)
    return min(limit, len(gear) + len(weather))


def run_backfill(g, conn, limit, sleep=time.sleep):
    gear, weather = pending_work(conn)
    calls = 0
    for uuid in gear:
        if calls >= limit:
            break
        try:
            activities = call_with_rate_limit_retry(
                lambda uuid=uuid: g.get_gear_activities(uuid),
                f"gear activities {uuid}", sleep)
        except Exception as error:
            calls += 1
            print(f"  gear activities {uuid}: skipped after error: {error}")
            if _is_rate_limit(error):
                return calls
            sleep(CALL_DELAY_S)
            continue
        calls += 1
        for activity in activities if isinstance(activities, list) else []:
            aid = activity.get("activityId")
            if aid is not None:
                conn.execute(
                    "UPDATE activities SET gear_uuid=%s WHERE activity_id=%s",
                    (uuid, aid))
        conn.commit()
        sleep(CALL_DELAY_S)

    for aid, activity_date in weather:
        if calls >= limit:
            break
        try:
            payload = call_with_rate_limit_retry(
                lambda aid=aid: g.get_activity_weather(aid), f"weather {aid}", sleep)
            calls += 1
            values = weather_row(payload)
            if values["temperature_c"] is None:
                if activity_date >= date.today() - timedelta(days=WEATHER_RETRY_DAYS):
                    sleep(CALL_DELAY_S)
                    continue
                values["weather_raw_json"] = dumps({
                    "weather_unavailable": True, "garmin": payload})
            assignments = ", ".join(f"{key}=%s" for key in values)
            conn.execute(
                f"UPDATE activities SET {assignments} WHERE activity_id=%s "
                "AND weather_raw_json IS NULL",
                [*values.values(), aid])
            conn.commit()
        except Exception as error:
            calls += 1
            conn.rollback()
            if not is_activity_failure(error):
                print(f"  weather {aid}: stopping, rerun later: {error}")
                break
            conn.execute(
                "UPDATE activities SET weather_raw_json=%s WHERE activity_id=%s "
                "AND weather_raw_json IS NULL",
                (dumps({"backfill_error": str(error)[:200]}), aid))
            conn.commit()
            print(f"  weather {aid}: marked unavailable after error: {error}")
        sleep(CALL_DELAY_S)
    return calls


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=50,
                        help="maximum Garmin API calls this invocation")
    parser.add_argument("--dry-run", action="store_true",
                        help="print planned calls without Garmin login or API calls")
    args = parser.parse_args(argv)
    if args.limit < 1:
        parser.error("--limit must be at least 1")

    load_dotenv(ENV_PATH)
    conn = psycopg.connect(os.getenv("DATABASE_URL", DEFAULT_DSN))
    count = planned_call_count(conn, args.limit)
    if args.dry_run:
        print(f"Planned Garmin calls: {count} (limit {args.limit})")
        conn.close()
        return 0
    if not count:
        print("Nothing to backfill.")
        conn.close()
        return 0

    calls = run_backfill(login(), conn, args.limit)
    conn.close()
    print(f"Completed Garmin calls: {calls} (limit {args.limit})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
