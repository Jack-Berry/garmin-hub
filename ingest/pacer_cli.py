#!/usr/local/bin/python3.13
"""Pacer build/push bridge for the Node API (Stage 5c).

JSON-in (stdin) / JSON-out (stdout). Two deterministic modes — the AI never
calls this, only approved structured params do:

  preview  build the workout (NO network) and emit a readable segment breakdown.
  push     build, upload, and schedule on Garmin; emit the workout id. THE ONLY
           mode that writes to Garmin.

Both take the SAME params object, so the workout pushed is exactly the one
previewed (deterministic rebuild). Garmin login/upload chatter is sent to stderr
so stdout stays pure JSON for the Node caller to parse.

    echo '{"distance_m":5000,"target":"sub 20","strategy":"negative"}' \
        | /usr/local/bin/python3.13 ingest/pacer_cli.py preview
"""

import sys
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import workout_builder as wb


# --- Blocks validation guard (Stage 8 step 1) --------------------------------
# Sane human pace window, seconds per km. Reject a typo'd target that would push
# a dangerous or nonsensical pace. Tunable.
PACE_FLOOR_S = 150.0     # 2:30/km — faster than any realistic pacer target
PACE_CEIL_S  = 480.0     # 8:00/km — slower than this isn't a "pace" workout
# Total workout distance (warmup + blocks + cooldown), metres.
TOTAL_DIST_MIN_M = 400.0     # under a lap = a mistake
TOTAL_DIST_MAX_M = 60000.0   # >60 km = out of scope, refuse
# Warmup / cooldown ceiling, each, metres.
WARMCOOL_MAX_M = 10000.0
# Rest-block magnitude ceilings (rest blocks have no pace to bound-check).
REST_TIME_MAX_S = 300.0   # 5 min — longer than this isn't a rest, it's a mistake
REST_DIST_MAX_M = 1000.0  # 1 km  — a "rest" longer than this is a running block


class GuardError(ValueError):
    """A blocks spec failed validation. Carries which block / check / value
    failed so the caller can report precisely. Never reaches build or Garmin."""
    def __init__(self, message, block=None, check=None, value=None):
        super().__init__(message)
        self.block, self.check, self.value = block, check, value


def validate_blocks(blocks, warmup_m, cooldown_m):
    """Hard gate on a blocks spec before build_pacer_blocks / Garmin. Returns
    the blocks unchanged on success; raises GuardError on the first failure.

    Pace bounds are checked against the EXPANDED profile (wb.expand_block), not
    just the block target: negative-split tank segments run faster than the
    block target, so we bound-check what actually gets built."""
    if not isinstance(blocks, list) or not blocks:
        raise GuardError("blocks must be a non-empty list", check="blocks_present")

    total = 0.0
    for i, b in enumerate(blocks):
        if not isinstance(b, dict):
            raise GuardError(f"blocks[{i}]: not an object", block=i,
                             check="block_type", value=b)

        # Rest blocks have no pace — skip pace bounds, sanity-check magnitude.
        # A time rest adds 0 running metres, so `total` stays running distance
        # (a time-rest-heavy session is never wrongly rejected as "too short").
        if b.get("kind") == "rest":
            rest_s, length = b.get("rest_s"), b.get("length_m")
            if rest_s is not None:
                if not isinstance(rest_s, (int, float)) or rest_s <= 0:
                    raise GuardError(f"blocks[{i}]: rest_s must be > 0", block=i,
                                     check="rest_s", value=rest_s)
                if rest_s > REST_TIME_MAX_S:
                    raise GuardError(f"blocks[{i}]: rest_s ({rest_s:g}s) exceeds "
                                     f"{REST_TIME_MAX_S:g}s", block=i,
                                     check="rest_time_max", value=rest_s)
            else:
                if not isinstance(length, (int, float)) or length <= 0:
                    raise GuardError(f"blocks[{i}]: rest length_m must be > 0", block=i,
                                     check="rest_length_m", value=length)
                if length > REST_DIST_MAX_M:
                    raise GuardError(f"blocks[{i}]: rest length_m ({length:g}m) exceeds "
                                     f"{REST_DIST_MAX_M:g}m", block=i,
                                     check="rest_dist_max", value=length)
                total += float(length)
            continue

        length = b.get("length_m")
        if not isinstance(length, (int, float)) or length <= 0:
            raise GuardError(f"blocks[{i}]: length_m must be > 0", block=i,
                             check="length_m", value=length)

        segment = b.get("segment_m", wb.SEGMENT_DEFAULT_M)
        if not isinstance(segment, (int, float)) or segment <= 0:
            raise GuardError(f"blocks[{i}]: segment_m must be > 0", block=i,
                             check="segment_m", value=segment)
        if segment > length:
            raise GuardError(f"blocks[{i}]: segment_m ({segment:g}) exceeds "
                             f"length_m ({length:g})", block=i,
                             check="segment_le_length", value=segment)

        # Resolve the actual per-segment profile the builder will emit and
        # bound-check every segment's faster bound (the dangerous edge).
        try:
            segs = wb.expand_block(b)
        except (KeyError, ValueError, TypeError):
            raise GuardError(f"blocks[{i}]: target missing or unparseable",
                             block=i, check="target_parse", value=b.get("target"))
        ramp_label = ("negative ramp" if b.get("strategy") == "negative" else "flat")
        for j, (dist, faster_s, slower_s, center_s) in enumerate(segs):
            if not (PACE_FLOOR_S <= faster_s <= PACE_CEIL_S):
                raise GuardError(
                    f"blocks[{i}]: expanded segment {j} pace {wb.fmt_pace(faster_s)}/km "
                    f"outside [{wb.fmt_pace(PACE_FLOOR_S)}–{wb.fmt_pace(PACE_CEIL_S)}]/km "
                    f"({ramp_label})",
                    block=i, check="pace_bounds", value=faster_s)

        total += float(length)

    for label, val in (("warmup_m", warmup_m), ("cooldown_m", cooldown_m)):
        if val is None:
            continue
        if val < 0 or val > WARMCOOL_MAX_M:
            raise GuardError(f"{label} ({val:g}) outside [0–{WARMCOOL_MAX_M:g}] m",
                             check=label, value=val)
        total += float(val)

    if not (TOTAL_DIST_MIN_M <= total <= TOTAL_DIST_MAX_M):
        raise GuardError(f"total distance {total:.0f} m outside "
                         f"[{TOTAL_DIST_MIN_M:.0f}–{TOTAL_DIST_MAX_M:.0f}] m",
                         check="total_distance", value=total)
    return blocks


def build(params):
    """Map approved params -> the Garmin workout dict via the proven builder.

    Two shapes, same warmup/cooldown handling:
      * blocks present -> validate_blocks() then wb.build_pacer_blocks()
      * else           -> the flat pacer sugar (wb.build_pacer), unchanged.
    """
    warmup_m = float(params["warmup_m"]) if params.get("warmup_m") else None
    cooldown_m = float(params["cooldown_m"]) if params.get("cooldown_m") else None

    if params.get("blocks"):
        blocks = validate_blocks(params["blocks"], warmup_m, cooldown_m)
        return wb.build_pacer_blocks(blocks, warmup_m=warmup_m,
                                     cooldown_m=cooldown_m, name=params.get("name"))

    return wb.build_pacer(
        distance_m=float(params["distance_m"]),
        target=params["target"],
        strategy=params.get("strategy", "flat"),
        segment_m=float(params.get("segment_m") or wb.SEGMENT_DEFAULT_M),
        warmup_m=warmup_m,
        cooldown_m=cooldown_m,
    )


def breakdown(workout):
    """Built workout -> a flat, display-ready segment list (one per step)."""
    segs = []
    for s in workout["workoutSegments"][0]["workoutSteps"]:
        # Rest steps carry seconds (time) or metres (distance) in endConditionValue
        # — a time rest must NOT land in distance_m. Emit a distinct marker.
        if s["stepType"]["stepTypeKey"] == "rest":
            seg = {"type": "rest", "pace_label": None}
            if s["endCondition"]["conditionTypeKey"] == "time":
                seg["duration_s"] = round(s["endConditionValue"])
            else:
                seg["distance_m"] = round(s["endConditionValue"])
            segs.append(seg)
            continue
        t1, t2 = s["targetValueOne"], s["targetValueTwo"]
        seg = {
            "type": s["stepType"]["stepTypeKey"],
            "distance_m": round(s["endConditionValue"]),
        }
        if t1:
            faster, slower = 1000.0 / t1, 1000.0 / t2
            seg["pace_label"] = f"{wb.fmt_pace(faster)}–{wb.fmt_pace(slower)}/km"
        else:
            seg["pace_label"] = None  # warmup / cooldown: easy, no target
        segs.append(seg)
    return segs


def cmd_preview(params):
    w = build(params)
    return {
        "name": w["workoutName"],
        "total_distance_m": round(w["estimatedDistanceInMeters"]),
        "est_duration_s": w["estimatedDurationInSecs"],
        "segments": breakdown(w),
    }


def cmd_push(params):
    date_str = params.get("date")
    if not date_str:
        raise ValueError("push requires a 'date' (YYYY-MM-DD) to schedule on")
    w = build(params)
    # Redirect Garmin's login/upload prints to stderr so stdout stays JSON-only.
    real_stdout, sys.stdout = sys.stdout, sys.stderr
    try:
        import workout_push as wp
        g = wp.connect()
        wid, _ = wp.upload(g, w)
        sid, _ = wp.schedule(g, wid, date_str)
    finally:
        sys.stdout = real_stdout
    return {
        "workout_id": wid,
        "schedule_id": sid,
        "name": w["workoutName"],
        "date": date_str,
    }


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("preview", "push"):
        sys.exit("usage: pacer_cli.py {preview|push}  (params as JSON on stdin)")
    params = json.loads(sys.stdin.read() or "{}")
    try:
        out = cmd_preview(params) if sys.argv[1] == "preview" else cmd_push(params)
    except GuardError as e:
        sys.exit(f"pacer guard rejected spec: {e}")
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
