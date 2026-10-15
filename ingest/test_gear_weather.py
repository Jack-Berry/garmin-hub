import unittest
from unittest.mock import patch

import backfill_gear_weather as backfill
from ingest import (
    call_with_rate_limit_retry, gear_row, ingest_activity_weather,
    new_summary, run_sections, weather_row,
)


GEAR = {
    "uuid": "shoe-1", "displayName": "ASICS Superblast 3",
    "gearMakeName": "ASICS", "gearModelName": "Superblast 3",
    "gearStatusName": "active", "dateBegin": "2026-01-02",
}
GEAR_STATS = {"totalDistance": 650123.4, "totalActivities": 82}
WEATHER = {
    "temp": 24.6, "apparentTemp": 25.1, "dewPoint": 18.2,
    "relativeHumidity": 68, "windSpeed": 2.4,
}


class Result:
    def __init__(self, one=None, rows=None):
        self.one = one
        self.rows = rows or []

    def fetchone(self):
        return self.one

    def fetchall(self):
        return self.rows


class Conn:
    def __init__(self, weather=None):
        self.weather = weather
        self.executed = []
        self.commits = 0
        self.rollbacks = 0

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if "SELECT weather_raw_json" in sql:
            return Result((self.weather,))
        return Result()

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class Garmin:
    def __init__(self):
        self.weather_calls = 0

    def get_activity_weather(self, _aid):
        self.weather_calls += 1
        return WEATHER


class GearWeatherTests(unittest.TestCase):
    def test_realistic_shapes_parse_idempotently(self):
        self.assertEqual(gear_row(GEAR, GEAR_STATS), gear_row(GEAR, GEAR_STATS))
        self.assertEqual(gear_row(GEAR, GEAR_STATS)["garmin_total_distance_m"], 650123.4)
        self.assertEqual(weather_row(WEATHER)["dew_point_c"], 18.2)

    def test_weather_is_never_refetched_once_stored(self):
        conn = Conn(weather={"temp": 24.6})
        garmin = Garmin()
        summary = new_summary()
        summary["_changed_run_ids"] = [123]
        ingest_activity_weather(garmin, conn, summary, sleep=lambda _s: None)
        self.assertEqual(garmin.weather_calls, 0)
        self.assertEqual(summary["weather"]["updated"], 0)

    def test_weather_fetch_updates_once_and_is_safe_to_repeat(self):
        conn = Conn(weather=None)
        garmin = Garmin()
        summary = new_summary()
        summary["_changed_run_ids"] = [123]
        ingest_activity_weather(garmin, conn, summary, sleep=lambda _s: None)
        self.assertEqual(garmin.weather_calls, 1)
        self.assertTrue(any("UPDATE activities SET" in sql for sql, _ in conn.executed))

    def test_rate_limit_backoff_retries_once(self):
        calls = []
        sleeps = []

        def request():
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("429 Too Many Requests")
            return WEATHER

        result = call_with_rate_limit_retry(request, "weather", sleeps.append, 5)
        self.assertEqual(result, WEATHER)
        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [5])

    def test_failed_section_rolls_back_and_later_section_runs(self):
        conn = Conn()
        summary = new_summary()
        ran = []

        def bad(_g, _conn, _summary):
            raise RuntimeError("broken")

        def good(_g, _conn, _summary):
            ran.append(True)

        run_sections(object(), conn, summary, (("bad", bad), ("good", good)))
        self.assertEqual(conn.rollbacks, 1)
        self.assertEqual(conn.commits, 1)
        self.assertEqual(ran, [True])

    def test_backfill_dry_run_count_is_capped_without_garmin(self):
        class PendingConn:
            def execute(self, sql):
                if "FROM gear" in sql:
                    return Result(rows=[("shoe-1",), ("shoe-2",)])
                return Result(rows=[(1,), (2,), (3,)])

        self.assertEqual(backfill.planned_call_count(PendingConn(), 4), 4)


if __name__ == "__main__":
    unittest.main()
