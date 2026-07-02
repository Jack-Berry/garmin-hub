"""Pacer workout builder (Stage 5b — block-based).

Pure construction: turns pacer parameters into the Garmin structured-workout dict
ready for upload. No network, no scheduling — see CLAUDE.md "Pacer / Engo 3
constraint". Reverse-engineered from the "Sub 20 5k" planned workout: interval
steps, pace.zone targets, targetValueOne/Two as m/s bounds (One = faster = higher
m/s), per-segment paces for negative splits.

Core model — a workout is an ordered list of segment BLOCKS. Each block:
    {length_m, segment_m, target, strategy, ramp?, band_s?}
i.e. "this portion of the race, split into segment_m chunks, at this pace/strategy".

Two entry points:
  * build_pacer(distance_m, target, ...)  — simple sugar: one block over the whole
    distance (preserves the Stage 5a interface).
  * build_pacer_blocks(blocks, ...)       — explicit block list.

Both return the Garmin workout dict directly (ready for upload_workout()).
"""

import json
import math
from pathlib import Path

# Negative-split shape constants live in guard_bounds.json — the single source
# shared with the validation guard (pacer_cli.py) and the coach's advisory copy
# (server/context.js), so the coach can pre-check what the builder will emit.
_NEG = json.loads(
    (Path(__file__).resolve().parent / "guard_bounds.json").read_text()
)["negative_split"]

# --- Tunables (negative-split shape, mirrors the Sub 20 5k template) ----------
SEGMENT_DEFAULT_M = 500       # default segment length
BAND_HALF_S = 2.0             # default ± s/km each side of target (4 s/km window,
                              # matches the template); block band_s overrides it
NEG_START_OFFSET = float(_NEG["start_offset_s"])   # s/km slower on first ramp seg
NEG_END_OFFSET = float(_NEG["end_offset_s"])       # s/km faster on last ramp seg
TANK_SEGMENTS = int(_NEG["tank_segments"])         # final "empty the tank" segments
TANK_SLOWER_STEP = float(_NEG["tank_slower_step_s"])  # slower bound step per tank seg
TANK_FASTER_STEP = float(_NEG["tank_faster_step_s"])  # faster bound step per tank seg
EASY_PACE_S = 360.0           # 6:00/km, used only to estimate warmup/cooldown time
DEFAULT_RAMP = "km_paired"    # negative ramp: "km_paired" or "continuous"

# --- Garmin enum literals (copied verbatim from the template) -----------------
SPORT_RUN = {"sportTypeId": 1, "sportTypeKey": "running", "displayOrder": 1}
STEP_TYPES = {
    "warmup": {"stepTypeId": 1, "stepTypeKey": "warmup", "displayOrder": 1},
    "cooldown": {"stepTypeId": 2, "stepTypeKey": "cooldown", "displayOrder": 2},
    "interval": {"stepTypeId": 3, "stepTypeKey": "interval", "displayOrder": 3},
    "rest": {"stepTypeId": 5, "stepTypeKey": "rest", "displayOrder": 5},
}
END_DISTANCE = {"conditionTypeId": 3, "conditionTypeKey": "distance",
                "displayOrder": 3, "displayable": True}
END_TIME = {"conditionTypeId": 2, "conditionTypeKey": "time",
            "displayOrder": 2, "displayable": True}
UNIT_KM = {"unitId": 2, "unitKey": "kilometer", "factor": 100000.0}
TARGET_PACE = {"workoutTargetTypeId": 6, "workoutTargetTypeKey": "pace.zone",
               "displayOrder": 6}
TARGET_NONE = {"workoutTargetTypeId": 1, "workoutTargetTypeKey": "no.target",
               "displayOrder": 1}
STROKE_NONE = {"strokeTypeId": 0, "strokeTypeKey": None, "displayOrder": 0}
EQUIP_NONE = {"equipmentTypeId": 0, "equipmentTypeKey": None, "displayOrder": 0}
WEIGHT_KG = {"unitId": 8, "unitKey": "kilogram", "factor": 1000.0}


# --- Pace helpers -------------------------------------------------------------
def fmt_pace(secs):
    """Seconds -> 'M:SS', rounding cleanly (no '3:60')."""
    m, s = divmod(int(round(secs)), 60)
    return f"{m}:{s:02d}"


def parse_pace(t):
    """A per-segment pace into s/km. Accepts a number (already s/km),
    'M:SS', or 'M:SS/km'."""
    if isinstance(t, (int, float)):
        return float(t)
    s = str(t).strip().lower().replace("/km", "").replace("/k", "").replace("min", "").strip()
    if ":" in s:
        mm, ss = s.split(":")
        return int(mm) * 60 + float(ss)
    return float(s)


def parse_target(target, distance_m):
    """Simple-mode goal -> (goal_pace_s_per_km, label).

    Pace target: contains '/km' (e.g. '4:00/km').
    Finish time: otherwise (e.g. 'sub 20', '19:54', '42:00'). 'sub N' -> N:00.
    """
    s = str(target).strip().lower()
    is_pace = "/km" in s or "/k" in s
    is_sub = "sub" in s
    body = (s.replace("/km", "").replace("/k", "").replace("min", "")
             .replace("sub", "").strip())
    secs = (int(body.split(":")[0]) * 60 + float(body.split(":")[1])) if ":" in body \
        else float(body) * 60   # bare number = whole minutes
    if is_pace:
        return secs, f"{fmt_pace(secs)}/km"
    goal = secs / (distance_m / 1000.0)
    label = ("Sub " + body) if is_sub else fmt_pace(secs)
    return goal, label


def dist_label(m):
    if m % 1000 == 0:
        return f"{int(m // 1000)}k"
    if m % 100 == 0:
        return f"{m / 1000:g}k"
    return f"{int(m)}m"


# --- Block expansion ----------------------------------------------------------
def _segment_lengths(length_m, segment_m):
    """Lay down full segment_m chunks; the leftover (< one segment) becomes its
    own final segment. 7300 @ 500 -> 14x500 + 1x300. Remainder is NOT spread."""
    dists, remaining = [], float(length_m)
    while remaining > segment_m + 1e-6:
        dists.append(float(segment_m))
        remaining -= segment_m
    dists.append(round(remaining, 6))
    return dists


def _pace_profile(n, goal_s, strategy, segment_m, ramp, band):
    """Return n tuples (faster_s_per_km, slower_s_per_km, center_s_per_km).

    `band` is a ± tolerance applied EACH SIDE of the center pace (a block's
    band_s, or BAND_HALF_S by default) — band 2 gives a 4 s/km wide window."""
    if strategy != "negative":   # "flat" (default)
        return [(goal_s - band, goal_s + band, goal_s) for _ in range(n)]

    tank = TANK_SEGMENTS if n >= 4 else max(0, n - 1)
    ramp_n = n - tank
    out = []
    if ramp == "km_paired":
        per_km = max(1, round(1000.0 / segment_m))      # segments sharing a pace
        groups = max(1, math.ceil(ramp_n / per_km))
        for i in range(ramp_n):
            g = i // per_km
            off = NEG_START_OFFSET if groups == 1 else (
                NEG_START_OFFSET + (NEG_END_OFFSET - NEG_START_OFFSET) * g / (groups - 1))
            center = goal_s + off
            out.append((center - band, center + band, center))
    else:                                                # "continuous"
        for i in range(ramp_n):
            off = NEG_START_OFFSET if ramp_n == 1 else (
                NEG_START_OFFSET + (NEG_END_OFFSET - NEG_START_OFFSET) * i / (ramp_n - 1))
            center = goal_s + off
            out.append((center - band, center + band, center))
    for j in range(1, tank + 1):
        faster = goal_s - TANK_FASTER_STEP * j
        slower = goal_s - TANK_SLOWER_STEP * j
        out.append((faster, slower, (faster + slower) / 2))
    return out


def expand_block(block):
    """Block dict -> list of (dist_m, faster_s, slower_s, center_s) per segment.

    Rest blocks ({kind: "rest", rest_s} time / {kind: "rest", length_m} distance)
    return a single un-paced marker dict instead of paced tuples — a distinct
    shape the assembler tells apart by type, so the paced path is untouched."""
    if block.get("kind") == "rest":
        if block.get("rest_s") is not None:
            return [{"rest": True, "end_kind": "time", "value": float(block["rest_s"])}]
        return [{"rest": True, "end_kind": "distance", "value": float(block["length_m"])}]

    length = block["length_m"]
    segment_m = block.get("segment_m", SEGMENT_DEFAULT_M)
    strategy = block.get("strategy", "flat")
    ramp = block.get("ramp", DEFAULT_RAMP)
    band = block.get("band_s", BAND_HALF_S)   # ± each side of target
    goal_s = parse_pace(block["target"])
    dists = _segment_lengths(length, segment_m)
    paces = _pace_profile(len(dists), goal_s, strategy, segment_m, ramp, band)
    return [(d, *p) for d, p in zip(dists, paces)]


# --- Garmin step / workout assembly -------------------------------------------
def _step(order, type_key, end_value_m, target=None):
    """Build one ExecutableStepDTO. target = (faster_s, slower_s) or None."""
    s = {
        "type": "ExecutableStepDTO",
        "stepId": None,           # Garmin assigns on upload
        "stepOrder": order,
        "stepType": STEP_TYPES[type_key],
        "childStepId": None,
        "description": None,
        "endCondition": END_DISTANCE,
        "endConditionValue": float(end_value_m),
        "preferredEndConditionUnit": UNIT_KM,
        "endConditionCompare": None,
        "targetType": TARGET_NONE,
        "targetValueOne": None,
        "targetValueTwo": None,
        "targetValueUnit": None,
        "zoneNumber": None,
        "secondaryTargetType": None,
        "secondaryTargetValueOne": None,
        "secondaryTargetValueTwo": None,
        "secondaryTargetValueUnit": None,
        "secondaryZoneNumber": None,
        "endConditionZone": None,
        "strokeType": STROKE_NONE,
        "equipmentType": EQUIP_NONE,
        "category": None,
        "exerciseName": None,
        "workoutProvider": None,
        "providerExerciseSourceId": None,
        "weightValue": -1.0,
        "weightUnit": WEIGHT_KG,
    }
    if target:
        faster_s, slower_s = target
        s["targetType"] = TARGET_PACE
        s["targetValueOne"] = 1000.0 / faster_s   # faster bound = higher m/s
        s["targetValueTwo"] = 1000.0 / slower_s   # slower bound = lower m/s
    return s


def _rest_step(order, end_kind, value):
    """Un-paced Garmin rest step. Matches Runna's proven rest shape exactly:
    stepType rest (id 5), no target, weight nulled. preferredEndConditionUnit is
    null for a TIME rest (Runna's captured shape); a DISTANCE rest mirrors our
    working distance steps (UNIT_KM — the one field not directly Runna-attested,
    since the captured example was time-based)."""
    if end_kind == "time":
        end_cond, unit = END_TIME, None           # seconds; unit null per Runna
    else:
        end_cond, unit = END_DISTANCE, UNIT_KM     # metres
    return {
        "type": "ExecutableStepDTO",
        "stepId": None,           # Garmin assigns on upload
        "stepOrder": order,
        "stepType": STEP_TYPES["rest"],
        "childStepId": None,
        "description": None,
        "endCondition": end_cond,
        "endConditionValue": float(value),
        "preferredEndConditionUnit": unit,
        "endConditionCompare": None,
        "targetType": None,                        # null, NOT no.target
        "targetValueOne": None,
        "targetValueTwo": None,
        "targetValueUnit": None,
        "zoneNumber": None,
        "secondaryTargetType": None,
        "secondaryTargetValueOne": None,
        "secondaryTargetValueTwo": None,
        "secondaryTargetValueUnit": None,
        "secondaryZoneNumber": None,
        "endConditionZone": None,
        "strokeType": STROKE_NONE,
        "equipmentType": EQUIP_NONE,
        "category": None,
        "exerciseName": None,
        "workoutProvider": None,
        "providerExerciseSourceId": None,
        "weightValue": None,                       # nulled, NOT -1.0
        "weightUnit": None,                        # nulled, NOT WEIGHT_KG
    }


def build_pacer_blocks(blocks, warmup_m=None, cooldown_m=None, name=None):
    """Build a Garmin pacer workout from an explicit ordered list of blocks."""
    steps, order, est_secs, total_dist = [], 1, 0.0, 0.0

    if warmup_m:
        steps.append(_step(order, "warmup", warmup_m))
        order += 1
        est_secs += warmup_m / 1000.0 * EASY_PACE_S
        total_dist += warmup_m

    for block in blocks:
        for seg in expand_block(block):
            if isinstance(seg, dict) and seg.get("rest"):
                steps.append(_rest_step(order, seg["end_kind"], seg["value"]))
                order += 1
                if seg["end_kind"] == "time":
                    est_secs += seg["value"]                      # seconds, 0 metres
                else:
                    est_secs += seg["value"] / 1000.0 * EASY_PACE_S
                    total_dist += seg["value"]                    # distance rest covers ground
                continue
            dist, faster_s, slower_s, center_s = seg
            steps.append(_step(order, "interval", dist, target=(faster_s, slower_s)))
            order += 1
            est_secs += dist / 1000.0 * center_s
            total_dist += dist

    if cooldown_m:
        steps.append(_step(order, "cooldown", cooldown_m))
        order += 1
        est_secs += cooldown_m / 1000.0 * EASY_PACE_S
        total_dist += cooldown_m

    return {
        "workoutName": name or "Custom Pacer",
        "description": None,
        "sportType": SPORT_RUN,
        "subSportType": None,
        "estimatedDurationInSecs": round(est_secs),
        "estimatedDistanceInMeters": total_dist,
        "avgTrainingSpeed": None,
        "workoutSegments": [{
            "segmentOrder": 1,
            "sportType": SPORT_RUN,
            "poolLengthUnit": None,
            "poolLength": None,
            "avgTrainingSpeed": None,
            "estimatedDurationInSecs": None,
            "estimatedDistanceInMeters": None,
            "estimatedDistanceUnit": None,
            "estimateType": None,
            "description": None,
            "workoutSteps": steps,
        }],
    }


def build_pacer(distance_m, target, strategy="negative", segment_m=SEGMENT_DEFAULT_M,
                warmup_m=None, cooldown_m=None, ramp=DEFAULT_RAMP):
    """Simple mode (Stage 5a interface): one block over the whole distance.

    target  'sub 20' / '19:54' (finish time) or '4:00/km' (pace).
    """
    goal_s, label = parse_target(target, distance_m)
    block = {"length_m": distance_m, "segment_m": segment_m,
             "target": goal_s, "strategy": strategy, "ramp": ramp}
    name = f"{label} {dist_label(distance_m)} Pacer"
    return build_pacer_blocks([block], warmup_m=warmup_m, cooldown_m=cooldown_m, name=name)


# --- Inspection ---------------------------------------------------------------
def summarise(workout):
    """One-line-per-step human view, for eyeballing against the template."""
    print(f"# {workout['workoutName']}  "
          f"(~{workout['estimatedDurationInSecs']}s, "
          f"{workout['estimatedDistanceInMeters']:.0f}m)")
    for s in workout["workoutSegments"][0]["workoutSteps"]:
        t1, t2 = s["targetValueOne"], s["targetValueTwo"]
        if s["stepType"]["stepTypeKey"] == "rest":
            # rest end value is seconds (time) or metres (distance) — label it right.
            unit = "s" if s["endCondition"]["conditionTypeKey"] == "time" else "m"
            print(f"  step {s['stepOrder']:2d} {'rest':8s} "
                  f"{s['endConditionValue']:6.0f}{unit}  rest")
            continue
        if t1:
            tgt = (f"{fmt_pace(1000 / t1)}-{fmt_pace(1000 / t2)}/km  "
                   f"(t1={t1:.7f} t2={t2:.7f})")
        else:
            tgt = "no target"
        print(f"  step {s['stepOrder']:2d} {s['stepType']['stepTypeKey']:8s} "
              f"{s['endConditionValue']:6.0f}m  {tgt}")
    print()


if __name__ == "__main__":
    print("Simple mode — Sub 20 5k, km-paired negative:")
    summarise(build_pacer(5000, "sub 20", "negative"))

    print("Block mode — 5k @ 1km goal pace, then 2k @ 500m faster, then 200m kick:")
    summarise(build_pacer_blocks([
        {"length_m": 5000, "segment_m": 1000, "target": "4:00/km", "strategy": "flat"},
        {"length_m": 2000, "segment_m": 500, "target": "3:50/km", "strategy": "flat"},
        {"length_m": 200, "segment_m": 200, "target": "3:20/km", "strategy": "flat"},
    ], name="Composed Pacer"))
