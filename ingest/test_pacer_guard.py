import json
import unittest
from pathlib import Path

import pacer_cli as p


BASE = {"length_m": 1000, "segment_m": 500, "target": "4:00", "strategy": "flat"}


class GuardTests(unittest.TestCase):
    def reject(self, blocks, check, warmup=0, cooldown=0):
        with self.assertRaises(p.GuardError) as caught:
            p.validate_blocks(blocks, warmup, cooldown)
        self.assertEqual(caught.exception.check, check)

    def test_bounds_are_loaded_from_json(self):
        bounds = json.loads((Path(__file__).parent / "guard_bounds.json").read_text())
        self.assertEqual(p.SEGMENT_MIN_M, bounds["segment_min_m"])
        self.assertEqual(p.MAX_STEPS, bounds["max_steps"])
        self.assertEqual(p.REPEAT_COUNT_MAX, bounds["repeat_count_max"])
        self.assertEqual(p.NEG_MIN_SEGMENTS, bounds["negative_split"]["min_segments"])

    def test_segment_sanity(self):
        self.reject([{**BASE, "segment_m": p.SEGMENT_MIN_M - 1}], "segment_min")
        self.reject([{**BASE, "segment_m": 1001}], "segment_le_length")

    def test_pace_bounds_and_band_sanity(self):
        self.reject([{**BASE, "target": p.PACE_FLOOR_S}], "pace_bounds")
        self.reject([{**BASE, "target": p.PACE_CEIL_S}], "pace_bounds")
        self.reject([{**BASE, "band_s": 0}], "band_s")

    def test_total_distance_and_warmcool_sanity(self):
        self.reject([{**BASE, "length_m": 300, "segment_m": 100}], "total_distance")
        self.reject([BASE], "warmup_m", warmup=p.WARMCOOL_MAX_M + 1)

    def test_rest_sanity(self):
        self.reject([BASE, {"kind": "rest", "rest_s": p.REST_TIME_MAX_S + 1}], "rest_time_max")
        self.reject([BASE, {"kind": "rest", "length_m": p.REST_DIST_MAX_M + 1}], "rest_dist_max")

    def test_step_count(self):
        self.reject([{**BASE, "length_m": (p.MAX_STEPS + 1) * 100, "segment_m": 100}], "max_steps")

    def test_negative_split_floor_and_minimum(self):
        self.reject([{**BASE, "length_m": 1500, "strategy": "negative"}], "negative_min_segments")
        self.reject([{**BASE, "length_m": 2000, "target": p.PACE_FLOOR_S + 10,
                      "strategy": "negative"}], "pace_bounds")

    def test_repeat_count_nesting_and_negative(self):
        child = {**BASE, "length_m": 500}
        self.reject([{"kind": "repeat", "count": 1, "blocks": [child]}], "repeat_count")
        self.reject([{"kind": "repeat", "count": p.REPEAT_COUNT_MAX + 1,
                      "blocks": [child]}], "repeat_count_max")
        self.reject([{"kind": "repeat", "count": 2, "blocks": [
            {"kind": "repeat", "count": 2, "blocks": [child]}]}], "repeat_nested")
        self.reject([{"kind": "repeat", "count": 2, "blocks": [
            {**child, "strategy": "negative"}]}], "negative_in_repeat")

    def test_repeat_payload_step_count_is_not_unrolled(self):
        children = [{**BASE, "length_m": 100, "segment_m": 100} for _ in range(p.MAX_STEPS)]
        self.reject([{"kind": "repeat", "count": 2, "blocks": children}], "max_steps")
        ok_children = children[:-1]
        p.validate_blocks([{"kind": "repeat", "count": 2, "blocks": ok_children}], 0, 0)


if __name__ == "__main__":
    unittest.main()
