import sys
import types
import unittest

import pacer_cli as p
import workout_push as real_wp


SPEC = {
    "name": "Tempo",
    "date": "2026-10-20",
    "blocks": [{"length_m": 1000, "segment_m": 500,
                "target": "4:00", "strategy": "flat"}],
    "_idempotency_key": "stable-key",
}


class FakeGarmin:
    def __init__(self):
        self.items = []
        self.workouts = {}
        self.next_workout = 10
        self.next_schedule = 101
        self.fail_after_schedule = True

    def get_scheduled_workouts(self, year, month):
        return {"calendarItems": list(self.items)}

    def get_workout_by_id(self, workout_id):
        return self.workouts[workout_id]


class IdempotencyTests(unittest.TestCase):
    def setUp(self):
        self.g = FakeGarmin()
        fake = types.ModuleType("workout_push")
        fake.connect = lambda: self.g
        fake.find_idempotent_push = real_wp.find_idempotent_push
        fake.upload = self.upload
        fake.schedule = self.schedule
        fake.delete = lambda g, wid: None
        fake.find_schedule_id = self.find_schedule
        fake.has_schedule_id = lambda g, sid, date: any(
            str(i["id"]) == str(sid) and i["date"] == date for i in g.items)
        fake.unschedule = lambda g, sid: g.items.__setitem__(
            slice(None), [i for i in g.items if str(i["id"]) != str(sid)])
        self.old = sys.modules.get("workout_push")
        sys.modules["workout_push"] = fake

    def tearDown(self):
        if self.old is None:
            sys.modules.pop("workout_push", None)
        else:
            sys.modules["workout_push"] = self.old

    def upload(self, g, workout):
        wid = g.next_workout
        g.next_workout += 1
        g.workouts[wid] = workout
        return wid, {}

    def schedule(self, g, wid, date):
        sid = g.next_schedule
        g.next_schedule += 1
        g.items.append({"id": sid, "workoutId": wid, "date": date,
                        "itemType": "workout",
                        "title": g.workouts[wid]["workoutName"]})
        if g.fail_after_schedule:
            g.fail_after_schedule = False
            raise TimeoutError("response lost after Garmin accepted it")
        return sid, {}

    def find_schedule(self, g, wid, date):
        return next((i["id"] for i in g.items
                     if i["workoutId"] == wid and i["date"] == date), None)

    def test_timeout_then_retry_adopts_one_workout(self):
        with self.assertRaises(RuntimeError):
            p.cmd_push(SPEC)
        result = p.cmd_push(SPEC)
        self.assertEqual(len(self.g.items), 1)
        self.assertEqual(result["workout_id"], 10)
        self.assertEqual(result["schedule_id"], 101)

    def test_same_name_and_date_with_another_key_is_not_adopted(self):
        self.g.workouts[9] = {"workoutName": "Tempo",
                              "description": "Garmin Hub request another-key"}
        self.g.items.append({"id": 99, "workoutId": 9, "date": "2026-10-20",
                             "itemType": "workout", "title": "Tempo"})
        self.assertIsNone(real_wp.find_idempotent_push(
            self.g, "2026-10-20", "Tempo", "stable-key"))

    def test_move_retry_adopts_target_schedule(self):
        self.g.fail_after_schedule = False
        self.g.workouts[10] = {"workoutName": "Tempo"}
        self.g.items.append({"id": 100, "workoutId": 10, "date": "2026-10-20",
                             "itemType": "workout", "title": "Tempo"})
        first = p.cmd_reconcile({"op": "move", "workout_id": 10,
                                 "from_date": "2026-10-20", "to_date": "2026-10-21"})
        second = p.cmd_reconcile({"op": "move", "workout_id": 10,
                                  "from_date": "2026-10-20", "to_date": "2026-10-21"})
        self.assertEqual(first["schedule_id"], second["schedule_id"])
        self.assertEqual(len([i for i in self.g.items if i["date"] == "2026-10-21"]), 1)


if __name__ == "__main__":
    unittest.main()
