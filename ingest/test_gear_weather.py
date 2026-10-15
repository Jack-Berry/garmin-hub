import unittest
from datetime import date
from unittest.mock import patch

import backfill_gear_weather as backfill
from ingest import (
    call_with_rate_limit_retry, gear_row, ingest_activity_weather, ingest_gear,
    new_summary, run_sections, weather_row,
)


GEAR = {
    "uuid": "shoe-1", "displayName": "ASICS Superblast 3",
    "gearMakeName": "ASICS", "gearModelName": "Superblast 3",
    "gearStatusName": "active", "dateBegin": "2026-01-02",
}
GEAR_STATS = {"totalDistance": 650123.4, "totalActivities": 82}
WEATHER = {
    "temp": 59, "apparentTemp": 61, "dewPoint": 42,
    "relativeHumidity": 68, "windSpeed": 8,
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
    def __init__(self, weather_rows=None):
        self.weather_rows = weather_rows or []
        self.executed = []
        self.commits = 0
        self.rollbacks = 0

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if "SELECT activity_id, start_time_local::date" in sql:
            return Result(rows=self.weather_rows)
        return Result()

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


class Garmin:
    def __init__(self, weather=WEATHER):
        self.weather_calls = 0
        self.weather = weather

    def get_activity_weather(self, _aid):
        self.weather_calls += 1
        if isinstance(self.weather, Exception):
            raise self.weather
        return self.weather


class GearWeatherTests(unittest.TestCase):
    def test_realistic_shapes_parse_idempotently(self):
        self.assertEqual(gear_row(GEAR, GEAR_STATS), gear_row(GEAR, GEAR_STATS))
        self.assertEqual(gear_row(GEAR, GEAR_STATS)["garmin_total_distance_m"], 650123.4)
        parsed = weather_row(WEATHER)
        self.assertEqual(parsed["temperature_c"], 15.0)
        self.assertAlmostEqual(parsed["dew_point_c"], 5.5556, places=3)
        self.assertAlmostEqual(parsed["wind_speed_mps"], 3.57632, places=4)

    def test_weather_honours_metric_unit_hints(self):
        parsed = weather_row({"temp": 15, "dewPoint": 6, "windSpeed": 3,
                              "temperatureUnit": "celsius", "windSpeedUnit": "m/s"})
        self.assertEqual(parsed["temperature_c"], 15)
        self.assertEqual(parsed["dew_point_c"], 6)
        self.assertEqual(parsed["wind_speed_mps"], 3)

    def test_weather_is_never_refetched_once_stored(self):
        conn = Conn(weather_rows=[])
        garmin = Garmin()
        summary = new_summary()
        summary["_changed_run_ids"] = [123]
        ingest_activity_weather(garmin, conn, summary, sleep=lambda _s: None)
        self.assertEqual(garmin.weather_calls, 0)
        self.assertEqual(summary["weather"]["updated"], 0)

    def test_weather_fetch_updates_once_and_is_safe_to_repeat(self):
        conn = Conn(weather_rows=[(123, date.today())])
        garmin = Garmin()
        summary = new_summary()
        summary["_changed_run_ids"] = [123]
        ingest_activity_weather(garmin, conn, summary, sleep=lambda _s: None)
        self.assertEqual(garmin.weather_calls, 1)
        self.assertIn("start_lat IS NOT NULL", conn.executed[0][0])
        self.assertIn("NOT ILIKE '%treadmill%'", conn.executed[0][0])
        self.assertTrue(any("UPDATE activities SET" in sql for sql, _ in conn.executed))

    def test_recent_empty_weather_stays_null_and_failure_is_only_a_warning(self):
        today = date.today()
        conn = Conn(weather_rows=[(123, today), (124, today)])
        summary = new_summary()
        ingest_activity_weather(Garmin(weather={}), conn, summary, sleep=lambda _s: None)
        self.assertFalse(any("UPDATE activities SET" in sql for sql, _ in conn.executed))

        failed = new_summary()
        ingest_activity_weather(Garmin(weather=RuntimeError("404")), conn, failed,
                                sleep=lambda _s: None)
        self.assertEqual(failed["errors"], [])
        self.assertEqual(len(failed["warnings"]), 2)

        old_conn = Conn(weather_rows=[(125, date(2020, 1, 1))])
        old_summary = new_summary()
        ingest_activity_weather(Garmin(weather={}), old_conn, old_summary,
                                sleep=lambda _s: None)
        update = next(params for sql, params in old_conn.executed
                      if "UPDATE activities SET" in sql)
        self.assertIn("weather_unavailable", update[-2])

    def test_gear_uses_numeric_owner_and_changed_run_calls_only(self):
        class GearGarmin:
            def __init__(self):
                self.calls = []

            def get_gear(self, owner_id):
                self.calls.append(("list", owner_id))
                return [GEAR, {**GEAR, "uuid": "old", "gearStatusName": "retired"}]

            def get_gear_stats(self, uuid):
                self.calls.append(("stats", uuid))
                return GEAR_STATS

            def get_activity_gear(self, aid):
                self.calls.append(("activity", aid))
                return [] if aid == 2 else [GEAR]

        garmin = GearGarmin()
        summary = new_summary()
        summary["_owner_id"] = 143177116
        summary["_changed_run_ids"] = [123]
        with patch("ingest.upsert", return_value="inserted"):
            ingest_gear(garmin, Conn(), summary, sleep=lambda _s: None)
        self.assertEqual(garmin.calls,
                         [("list", 143177116), ("stats", "shoe-1"), ("activity", 123)])
        self.assertIsInstance(garmin.calls[0][1], int)

        three = GearGarmin()
        three_summary = new_summary()
        three_summary["_owner_id"] = 143177116
        three_summary["_changed_run_ids"] = [1, 2, 3]
        three_conn = Conn()
        with patch("ingest.upsert", return_value="inserted"):
            ingest_gear(three, three_conn, three_summary, sleep=lambda _s: None)
        self.assertEqual(len(three.calls), 5)
        self.assertTrue(any(params == (None, 2) for sql, params in three_conn.executed
                            if "SET gear_uuid" in sql))

        quiet = GearGarmin()
        with patch("ingest.upsert", return_value="inserted"):
            ingest_gear(quiet, Conn(), new_summary(), sleep=lambda _s: None)
        self.assertEqual(quiet.calls, [])

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
                return Result(rows=[(1, date.today()), (2, date.today()),
                                    (3, date.today())])

        self.assertEqual(backfill.planned_call_count(PendingConn(), 4), 4)

    def test_backfill_marks_weather_error_and_continues(self):
        old = date(2020, 1, 1)

        class BackfillConn(Conn):
            def execute(self, sql, params=None):
                self.executed.append((sql, params))
                if "SELECT gear_uuid" in sql:
                    return Result(rows=[])
                if "SELECT activity_id, start_time_local::date" in sql:
                    return Result(rows=[(1, old), (2, old)])
                return Result()

        class BackfillGarmin:
            def get_activity_weather(self, aid):
                if aid == 1:
                    raise RuntimeError("404 weather unavailable")
                return WEATHER

        conn = BackfillConn()
        calls = backfill.run_backfill(BackfillGarmin(), conn, 5, sleep=lambda _s: None)
        self.assertEqual(calls, 2)
        updates = [(sql, params) for sql, params in conn.executed
                   if "UPDATE activities SET" in sql]
        self.assertEqual(len(updates), 2)
        self.assertIn("backfill_error", updates[0][1][0])

    def test_backfill_stops_on_rate_limit_without_marking(self):
        old = date(2020, 1, 1)

        class BackfillConn(Conn):
            def execute(self, sql, params=None):
                self.executed.append((sql, params))
                if "SELECT gear_uuid" in sql:
                    return Result(rows=[])
                if "SELECT activity_id, start_time_local::date" in sql:
                    return Result(rows=[(1, old), (2, old)])
                return Result()

        class LimitedGarmin:
            def get_activity_weather(self, aid):
                raise RuntimeError("429 Too Many Requests")

        conn = BackfillConn()
        backfill.run_backfill(LimitedGarmin(), conn, 5, sleep=lambda _s: None)
        self.assertFalse([sql for sql, _ in conn.executed if "UPDATE activities SET" in sql])

    def test_gear_garmin_failure_is_a_warning_and_retired_totals_are_kept(self):
        class FailingGarmin:
            def get_gear(self, owner_id):
                raise RuntimeError("500 Server Error")

        summary = new_summary()
        summary["_owner_id"] = 143177116
        summary["_changed_run_ids"] = [123]
        ingest_gear(FailingGarmin(), Conn(), summary, sleep=lambda _s: None)
        self.assertEqual(len(summary["warnings"]), 1)
        self.assertEqual(summary["errors"], [])
        retired = gear_row({**GEAR, "gearStatusName": "retired"})
        self.assertNotIn("garmin_total_distance_m", retired)
        self.assertNotIn("raw_json", retired)


if __name__ == "__main__":
    unittest.main()
