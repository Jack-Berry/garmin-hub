import inspect
import unittest

from ingest import ingest_activities, remove_overlapping_apple_activities


class Result:
    def __init__(self, rows=None):
        self.rows = rows or []

    def fetchall(self):
        return self.rows


class Connection:
    def __init__(self, matches=None):
        self.matches = matches or []
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if sql.startswith("SELECT apple.activity_id"):
            return Result(self.matches)
        if sql.startswith("DELETE FROM activities"):
            return Result(self.matches)
        return Result()


class AppleOverlapTests(unittest.TestCase):
    def test_apple_first_then_garmin_removes_apple_activity_and_laps(self):
        conn = Connection(matches=[(-101,)])
        self.assertEqual(remove_overlapping_apple_activities(conn, 202), 1)
        statements = [sql for sql, _ in conn.executed]
        self.assertIn("activity_windows_overlap(", statements[0])
        self.assertIn("garmin.source='garmin'", statements[0])
        self.assertIn("apple.source='apple_health'", statements[0])
        self.assertTrue(statements[1].startswith("DELETE FROM laps"))
        self.assertIn("source='apple_health'", statements[2])
        self.assertEqual(conn.executed[1][1], ([-101],))
        self.assertEqual(conn.executed[2][1], ([-101],))

    def test_no_overlap_leaves_apple_rows_untouched(self):
        conn = Connection()
        self.assertEqual(remove_overlapping_apple_activities(conn, 202), 0)
        self.assertEqual(len(conn.executed), 1)

    def test_activity_ingest_runs_cleanup_before_lap_refresh(self):
        source = inspect.getsource(ingest_activities)
        cleanup = source.index("remove_overlapping_apple_activities(conn, aid)")
        laps = source.index("ingest_laps(g, conn, aid, summary)")
        self.assertLess(cleanup, laps)


if __name__ == "__main__":
    unittest.main()
