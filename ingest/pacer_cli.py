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
# All bounds load from guard_bounds.json — the single source shared with the
# builder (negative-split shape) and server/context.js (the advisory copy the
# planning coach sees). Tune the JSON, not code.
BOUNDS = json.loads(
    (Path(__file__).resolve().parent / "guard_bounds.json").read_text())
PACE_FLOOR_S = BOUNDS["pace_floor_s"]        # faster than any realistic target
PACE_CEIL_S = BOUNDS["pace_ceil_s"]          # slower than this isn't a "pace" workout
TOTAL_DIST_MIN_M = BOUNDS["total_dist_min_m"]   # under a lap = a mistake
TOTAL_DIST_MAX_M = BOUNDS["total_dist_max_m"]   # beyond = out of scope, refuse
WARMCOOL_MAX_M = BOUNDS["warmcool_max_m"]    # warmup / cooldown ceiling, each
REST_TIME_MAX_S = BOUNDS["rest_time_max_s"]  # longer isn't a rest, it's a mistake
REST_DIST_MAX_M = BOUNDS["rest_dist_max_m"]  # longer is a running block, not a rest
SEGMENT_MIN_M = BOUNDS["segment_min_m"]      # finer than this is a silly gauge step
MAX_STEPS = BOUNDS["max_steps"]              # total Garmin steps incl. rests/bookends
NEG_MIN_SEGMENTS = BOUNDS["negative_split"]["min_segments"]  # ramp needs room


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
    n_steps = (1 if warmup_m else 0) + (1 if cooldown_m else 0)
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
            n_steps += 1
            continue

        length = b.get("length_m")
        if not isinstance(length, (int, float)) or length <= 0:
            raise GuardError(f"blocks[{i}]: length_m must be > 0", block=i,
                             check="length_m", value=length)

        segment = b.get("segment_m", wb.SEGMENT_DEFAULT_M)
        if not isinstance(segment, (int, float)) or segment <= 0:
            raise GuardError(f"blocks[{i}]: segment_m must be > 0", block=i,
                             check="segment_m", value=segment)
        if segment < SEGMENT_MIN_M:
            raise GuardError(f"blocks[{i}]: segment_m ({segment:g}) under the "
                             f"{SEGMENT_MIN_M:g}m minimum", block=i,
                             check="segment_min", value=segment)
        if segment > length:
            raise GuardError(f"blocks[{i}]: segment_m ({segment:g}) exceeds "
                             f"length_m ({length:g})", block=i,
                             check="segment_le_length", value=segment)

        band = b.get("band_s")
        if band is not None and (not isinstance(band, (int, float)) or band <= 0):
            raise GuardError(f"blocks[{i}]: band_s must be > 0 (± s/km each side)",
                             block=i, check="band_s", value=band)

        # Resolve the actual per-segment profile the builder will emit and
        # bound-check BOTH edges of every segment (the fast edge is the
        # dangerous one; the slow edge catches not-a-pace-workout targets).
        try:
            segs = wb.expand_block(b)
        except (KeyError, ValueError, TypeError):
            raise GuardError(f"blocks[{i}]: target missing or unparseable",
                             block=i, check="target_parse", value=b.get("target"))
        if b.get("strategy") == "negative" and len(segs) < NEG_MIN_SEGMENTS:
            raise GuardError(
                f"blocks[{i}]: strategy 'negative' needs at least "
                f"{NEG_MIN_SEGMENTS} segments to ramp (got {len(segs)}) — "
                f"use a finer segment_m", block=i,
                check="negative_min_segments", value=len(segs))
        ramp_label = ("negative ramp" if b.get("strategy") == "negative" else "flat")
        for j, (dist, faster_s, slower_s, center_s) in enumerate(segs):
            if slower_s < faster_s:
                raise GuardError(
                    f"blocks[{i}]: expanded segment {j} band is inverted "
                    f"(slow bound faster than fast bound)", block=i,
                    check="band_inverted", value=(faster_s, slower_s))
            for edge, val in (("fast edge", faster_s), ("slow edge", slower_s)):
                if not (PACE_FLOOR_S <= val <= PACE_CEIL_S):
                    raise GuardError(
                        f"blocks[{i}]: expanded segment {j} {edge} "
                        f"{wb.fmt_pace(val)}/km outside "
                        f"[{wb.fmt_pace(PACE_FLOOR_S)}–{wb.fmt_pace(PACE_CEIL_S)}]/km "
                        f"({ramp_label})",
                        block=i, check="pace_bounds", value=val)

        total += float(length)
        n_steps += len(segs)

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
    if n_steps > MAX_STEPS:
        raise GuardError(f"workout expands to {n_steps} steps, over the "
                         f"{MAX_STEPS}-step cap", check="max_steps", value=n_steps)
    return blocks


def build(params):
    """Map approved params -> the Garmin workout dict via the proven builder.

    Two shapes, ONE validation path: simple/no-blocks params are converted to
    the equivalent single-block spec (exactly what wb.build_pacer constructs),
    so EVERY workout passes validate_blocks before build — nothing reaches
    Garmin unvalidated.
    """
    warmup_m = float(params["warmup_m"]) if params.get("warmup_m") else None
    cooldown_m = float(params["cooldown_m"]) if params.get("cooldown_m") else None

    if params.get("blocks"):
        blocks, name = params["blocks"], params.get("name")
    else:
        try:
            distance_m = float(params["distance_m"])
        except (KeyError, TypeError, ValueError):
            raise GuardError("simple mode requires a numeric distance_m",
                             check="distance_m", value=params.get("distance_m"))
        try:
            goal_s, label = wb.parse_target(params["target"], distance_m)
        except (KeyError, ValueError, IndexError, TypeError):
            raise GuardError("target missing or unparseable",
                             check="target_parse", value=params.get("target"))
        blocks = [{"length_m": distance_m,
                   "segment_m": float(params.get("segment_m") or wb.SEGMENT_DEFAULT_M),
                   "target": goal_s,
                   "strategy": params.get("strategy", "flat")}]
        name = params.get("name") or f"{label} {wb.dist_label(distance_m)} Pacer"

    blocks = validate_blocks(blocks, warmup_m, cooldown_m)
    return wb.build_pacer_blocks(blocks, warmup_m=warmup_m,
                                 cooldown_m=cooldown_m, name=name)


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
        try:
            sid, _ = wp.schedule(g, wid, date_str)
        except Exception as e:
            # Upload + schedule isn't atomic — don't strand an unscheduled
            # workout in the Garmin library. Roll the upload back if we can.
            try:
                wp.delete(g, wid)
                detail = "the uploaded workout was rolled back; nothing is left on Garmin"
            except Exception:
                detail = (f"rollback also failed — workout {wid} is uploaded but "
                          f"unscheduled; delete it in Garmin Connect before re-pushing")
            raise RuntimeError(f"scheduling failed after upload ({e}); {detail}") from e
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
    except Exception as e:
        # One clean line, not a traceback — the Node caller surfaces the last
        # stderr line to the UI (and to the planning coach's repair loop).
        sys.exit(f"pacer {sys.argv[1]} failed: {e}")
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
