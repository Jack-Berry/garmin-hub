#!/usr/local/bin/python3.13
"""Pacer build/push bridge for the Node API (Stage 5c).

JSON-in (stdin) / JSON-out (stdout). Two deterministic modes — the AI never
calls this, only approved structured params do:

  preview   build the workout (NO network) and emit a readable segment breakdown.
  push      build, upload, and schedule on Garmin; emit the workout id. THE ONLY
            mode that writes to Garmin.
  validate  batch-check {"sessions": [...]} (Stage 9b plan generation): every
            session runs the same guard+build as preview, per-session ok/error
            results, NO network. One spawn validates a whole plan.

Both take the SAME params object, so the workout pushed is exactly the one
previewed (deterministic rebuild). Garmin login/upload chatter is sent to stderr
so stdout stays pure JSON for the Node caller to parse.

    echo '{"distance_m":5000,"target":"sub 20","strategy":"negative"}' \
        | /usr/local/bin/python3.13 ingest/pacer_cli.py preview
"""

import re
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
MAX_STEPS = BOUNDS["max_steps"]              # steps in the pushed payload (see note)
REPEAT_COUNT_MAX = BOUNDS["repeat_count_max"]   # iterations cap per repeat group
NEG_MIN_SEGMENTS = BOUNDS["negative_split"]["min_segments"]  # ramp needs room


class GuardError(ValueError):
    """A blocks spec failed validation. Carries which block / check / value
    failed so the caller can report precisely. Never reaches build or Garmin."""
    def __init__(self, message, block=None, check=None, value=None):
        super().__init__(message)
        self.block, self.check, self.value = block, check, value


def _validate_rest(b, i, label):
    """Rest-block checks. Returns the running metres it contributes (a time
    rest adds 0, so running-distance totals are never inflated by standing)."""
    rest_s, length = b.get("rest_s"), b.get("length_m")
    if rest_s is not None:
        if not isinstance(rest_s, (int, float)) or rest_s <= 0:
            raise GuardError(f"{label}: rest_s must be > 0", block=i,
                             check="rest_s", value=rest_s)
        if rest_s > REST_TIME_MAX_S:
            raise GuardError(f"{label}: rest_s ({rest_s:g}s) exceeds "
                             f"{REST_TIME_MAX_S:g}s", block=i,
                             check="rest_time_max", value=rest_s)
        return 0.0
    if not isinstance(length, (int, float)) or length <= 0:
        raise GuardError(f"{label}: rest length_m must be > 0", block=i,
                         check="rest_length_m", value=length)
    if length > REST_DIST_MAX_M:
        raise GuardError(f"{label}: rest length_m ({length:g}m) exceeds "
                         f"{REST_DIST_MAX_M:g}m", block=i,
                         check="rest_dist_max", value=length)
    return float(length)


def _validate_paced(b, i, label):
    """Paced-block checks (segment / band / expanded pace bounds). Returns
    (running metres, expanded step count)."""
    length = b.get("length_m")
    if not isinstance(length, (int, float)) or length <= 0:
        raise GuardError(f"{label}: length_m must be > 0", block=i,
                         check="length_m", value=length)

    segment = b.get("segment_m", wb.SEGMENT_DEFAULT_M)
    if not isinstance(segment, (int, float)) or segment <= 0:
        raise GuardError(f"{label}: segment_m must be > 0", block=i,
                         check="segment_m", value=segment)
    if segment < SEGMENT_MIN_M:
        raise GuardError(f"{label}: segment_m ({segment:g}) under the "
                         f"{SEGMENT_MIN_M:g}m minimum", block=i,
                         check="segment_min", value=segment)
    if segment > length:
        raise GuardError(f"{label}: segment_m ({segment:g}) exceeds "
                         f"length_m ({length:g})", block=i,
                         check="segment_le_length", value=segment)

    band = b.get("band_s")
    if band is not None and (not isinstance(band, (int, float)) or band <= 0):
        raise GuardError(f"{label}: band_s must be > 0 (± s/km each side)",
                         block=i, check="band_s", value=band)

    # Resolve the actual per-segment profile the builder will emit and
    # bound-check BOTH edges of every segment (the fast edge is the
    # dangerous one; the slow edge catches not-a-pace-workout targets).
    try:
        segs = wb.expand_block(b)
    except (KeyError, ValueError, TypeError):
        raise GuardError(f"{label}: target missing or unparseable",
                         block=i, check="target_parse", value=b.get("target"))
    if b.get("strategy") == "negative" and len(segs) < NEG_MIN_SEGMENTS:
        raise GuardError(
            f"{label}: strategy 'negative' needs at least "
            f"{NEG_MIN_SEGMENTS} segments to ramp (got {len(segs)}) — "
            f"use a finer segment_m", block=i,
            check="negative_min_segments", value=len(segs))
    ramp_label = ("negative ramp" if b.get("strategy") == "negative" else "flat")
    for j, (dist, faster_s, slower_s, center_s) in enumerate(segs):
        if slower_s < faster_s:
            raise GuardError(
                f"{label}: expanded segment {j} band is inverted "
                f"(slow bound faster than fast bound)", block=i,
                check="band_inverted", value=(faster_s, slower_s))
        for edge, val in (("fast edge", faster_s), ("slow edge", slower_s)):
            if not (PACE_FLOOR_S <= val <= PACE_CEIL_S):
                raise GuardError(
                    f"{label}: expanded segment {j} {edge} "
                    f"{wb.fmt_pace(val)}/km outside "
                    f"[{wb.fmt_pace(PACE_FLOOR_S)}–{wb.fmt_pace(PACE_CEIL_S)}]/km "
                    f"({ramp_label})",
                    block=i, check="pace_bounds", value=val)
    return float(length), len(segs)


def validate_blocks(blocks, warmup_m, cooldown_m):
    """Hard gate on a blocks spec before build_pacer_blocks / Garmin. Returns
    the blocks unchanged on success; raises GuardError on the first failure.

    Pace bounds are checked against the EXPANDED profile (wb.expand_block), not
    just the block target: negative-split tank segments run faster than the
    block target, so we bound-check what actually gets built. Repeat groups —
    {kind: "repeat", count, blocks} — are recursed one level: every child gets
    the same rest/paced checks, distance counts every iteration, and nesting /
    per-iteration ramps / all-rest groups are rejected.

    Step counting: n_steps counts the steps in the pushed PAYLOAD — a repeat
    group is 1 (the group) + its children ONCE, not iterations x children,
    because that is the shape Garmin's own step ceiling applies to (the group
    is stored once with an iteration count). Unrolled volume is bounded
    separately by total distance and REPEAT_COUNT_MAX."""
    if not isinstance(blocks, list) or not blocks:
        raise GuardError("blocks must be a non-empty list", check="blocks_present")

    total = 0.0
    n_steps = (1 if warmup_m else 0) + (1 if cooldown_m else 0)
    for i, b in enumerate(blocks):
        if not isinstance(b, dict):
            raise GuardError(f"blocks[{i}]: not an object", block=i,
                             check="block_type", value=b)

        if b.get("kind") == "rest":
            total += _validate_rest(b, i, f"blocks[{i}]")
            n_steps += 1
            continue

        if b.get("kind") == "repeat":
            count = b.get("count")
            if not isinstance(count, int) or isinstance(count, bool) or count < 2:
                raise GuardError(f"blocks[{i}]: repeat count must be an integer "
                                 f">= 2", block=i, check="repeat_count", value=count)
            if count > REPEAT_COUNT_MAX:
                raise GuardError(f"blocks[{i}]: repeat count ({count}) exceeds "
                                 f"{REPEAT_COUNT_MAX}", block=i,
                                 check="repeat_count_max", value=count)
            children = b.get("blocks")
            if not isinstance(children, list) or not children:
                raise GuardError(f"blocks[{i}]: repeat blocks must be a non-empty "
                                 f"list", block=i, check="repeat_blocks", value=children)
            iter_dist, group_steps, has_paced = 0.0, 1, False
            for j, c in enumerate(children):
                label = f"blocks[{i}].blocks[{j}]"
                if not isinstance(c, dict):
                    raise GuardError(f"{label}: not an object", block=i,
                                     check="block_type", value=c)
                if c.get("kind") == "repeat":
                    raise GuardError(f"{label}: repeat groups cannot nest",
                                     block=i, check="repeat_nested")
                if c.get("kind") == "rest":
                    iter_dist += _validate_rest(c, i, label)
                    group_steps += 1
                    continue
                if c.get("strategy") == "negative":
                    raise GuardError(
                        f"{label}: strategy 'negative' inside a repeat group "
                        f"(the ramp would restart every iteration) — use flat",
                        block=i, check="negative_in_repeat")
                m, ns = _validate_paced(c, i, label)
                iter_dist += m
                group_steps += ns
                has_paced = True
            if not has_paced:
                raise GuardError(f"blocks[{i}]: repeat group needs at least one "
                                 f"paced block", block=i, check="repeat_no_paced")
            total += iter_dist * count
            n_steps += group_steps
            continue

        m, ns = _validate_paced(b, i, f"blocks[{i}]")
        total += m
        n_steps += ns

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


def _seg_view(s):
    """One ExecutableStepDTO -> display dict (rest / interval / warmup / cooldown)."""
    # Rest steps carry seconds (time) or metres (distance) in endConditionValue
    # — a time rest must NOT land in distance_m. Emit a distinct marker.
    if s["stepType"]["stepTypeKey"] == "rest":
        seg = {"type": "rest", "pace_label": None}
        if s["endCondition"]["conditionTypeKey"] == "time":
            seg["duration_s"] = round(s["endConditionValue"])
        else:
            seg["distance_m"] = round(s["endConditionValue"])
        return seg
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
    return seg


def breakdown(workout):
    """Built workout -> display-ready step list. Repeat groups stay GROUPED —
    {type: "repeat", count, steps: [children once]} — so a preview reads
    "8x [400m, 60s rest]" instead of an unrolled wall of steps (unreadable at
    plan scale, Stage 9b). Totals still count every iteration (the builder's
    estimates already do)."""
    out = []
    for s in workout["workoutSegments"][0]["workoutSteps"]:
        if s["type"] == "RepeatGroupDTO":
            out.append({"type": "repeat",
                        "count": int(s["numberOfIterations"]),
                        "steps": [_seg_view(c) for c in s["workoutSteps"]]})
        else:
            out.append(_seg_view(s))
    return out


def cmd_preview(params):
    w = build(params)
    return {
        "name": w["workoutName"],
        "total_distance_m": round(w["estimatedDistanceInMeters"]),
        "est_duration_s": w["estimatedDurationInSecs"],
        "segments": breakdown(w),
    }


def cmd_validate(params):
    """Batch guard check for a multi-session plan (Stage 9b). Takes
    {"sessions": [<spec>, ...]} — each the exact shape preview/push consume —
    and runs EVERY session through the same build path, collecting per-session
    results instead of dying on the first failure (a plan review must show
    which sessions are bad, not just that one is). No network. A date is
    required here because a persisted session must be pushable later."""
    sessions = params.get("sessions")
    if not isinstance(sessions, list) or not sessions:
        raise ValueError("validate requires a non-empty 'sessions' list")
    out = []
    for s in sessions:
        try:
            if not isinstance(s, dict):
                raise GuardError("session is not an object", check="session_type")
            date = s.get("date")
            if not isinstance(date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
                raise GuardError("session date missing or not YYYY-MM-DD",
                                 check="date", value=date)
            w = build(s)
            out.append({"ok": True, "name": w["workoutName"],
                        "total_distance_m": round(w["estimatedDistanceInMeters"]),
                        "est_duration_s": w["estimatedDurationInSecs"],
                        "segments": breakdown(w)})
        except GuardError as e:
            out.append({"ok": False, "error": str(e)})
        except Exception as e:
            out.append({"ok": False, "error": f"build failed: {e}"})
    return {"sessions": out}


def _upload_and_schedule(g, w, date_str):
    """Upload a built workout and schedule it, rolling the upload back if
    scheduling fails (upload + schedule isn't atomic — never strand an
    unscheduled workout in the Garmin library). Returns (workout_id,
    schedule_id). Shared by push and the reconcile replace op."""
    import workout_push as wp
    wid, _ = wp.upload(g, w)
    try:
        sid, _ = wp.schedule(g, wid, date_str)
    except Exception as e:
        try:
            wp.delete(g, wid)
            detail = "the uploaded workout was rolled back; nothing is left on Garmin"
        except Exception:
            detail = (f"rollback also failed — workout {wid} is uploaded but "
                      f"unscheduled; delete it in Garmin Connect before re-pushing")
        raise RuntimeError(f"scheduling failed after upload ({e}); {detail}") from e
    return wid, sid


def _push_result(w, wid, sid, date_str):
    return {
        "workout_id": wid,
        "schedule_id": sid,
        "name": w["workoutName"],
        "date": date_str,
        # Built totals so the Node caller can persist the planned_workouts row
        # (Stage 9a) without re-deriving them from the spec.
        "total_distance_m": round(w["estimatedDistanceInMeters"]),
        "est_duration_s": w["estimatedDurationInSecs"],
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
        wid, sid = _upload_and_schedule(g, w, date_str)
    finally:
        sys.stdout = real_stdout
    return _push_result(w, wid, sid, date_str)


def cmd_reconcile(params):
    """Single-session Garmin reconcile (Stage 9d) — the ONE primitive the
    move/delete/nudge plan edits funnel through. Three ops:

      move     {op, workout_id, from_date, to_date}: schedule the SAME workout
               template on to_date, THEN unschedule the from_date entry (looked
               up live — the original schedule id isn't persisted). No
               re-upload, no re-build.
      remove   {op, workout_id}: delete the workout template — Garmin removes
               its calendar entry with it (the 9c-established behaviour).
      replace  {op, replace_workout_id, ...spec}: build+guard+upload+schedule
               the new spec (the full push path — nothing reaches Garmin
               unvalidated), THEN delete the old template.

    Ordering is deliberate: the NEW state lands on Garmin before the OLD one is
    removed, so a mid-op failure can only ever leave a cosmetic double-listing
    (surfaced as `warning`), never a vanished session."""
    op = params.get("op")
    if op not in ("move", "remove", "replace"):
        raise ValueError(f"reconcile op must be move/remove/replace, got {op!r}")
    if op == "replace":
        w = build(params)  # guard runs here, BEFORE any network
    real_stdout, sys.stdout = sys.stdout, sys.stderr
    try:
        import workout_push as wp
        g = wp.connect()
        if op == "move":
            wid = int(params["workout_id"])
            from_date, to_date = params["from_date"], params["to_date"]
            old_sid = wp.find_schedule_id(g, wid, from_date)
            sid, _ = wp.schedule(g, wid, to_date)
            warning = None
            if old_sid is None:
                warning = (f"no calendar entry found for workout {wid} on "
                           f"{from_date} — nothing to unschedule")
            else:
                try:
                    wp.unschedule(g, old_sid)
                except Exception as e:
                    warning = (f"new date scheduled but unscheduling the "
                               f"{from_date} entry failed ({e}) — the workout is "
                               f"double-listed on Garmin; remove the {from_date} "
                               f"entry in Garmin Connect")
            out = {"workout_id": wid, "schedule_id": sid, "date": to_date,
                   "warning": warning}
        elif op == "remove":
            wid = int(params["workout_id"])
            wp.delete(g, wid)
            out = {"workout_id": wid, "removed": True}
        elif op == "replace":
            old_wid = int(params["replace_workout_id"])
            wid, sid = _upload_and_schedule(g, w, params["date"])
            warning = None
            try:
                wp.delete(g, old_wid)
            except Exception as e:
                warning = (f"new session is on Garmin but deleting the old "
                           f"workout {old_wid} failed ({e}) — it is double-listed; "
                           f"delete the old one in Garmin Connect")
            out = {**_push_result(w, wid, sid, params["date"]), "warning": warning}
    finally:
        sys.stdout = real_stdout
    return out


def main():
    modes = {"preview": cmd_preview, "push": cmd_push, "validate": cmd_validate,
             "reconcile": cmd_reconcile}
    if len(sys.argv) < 2 or sys.argv[1] not in modes:
        sys.exit("usage: pacer_cli.py {preview|push|validate|reconcile}  (params as JSON on stdin)")
    params = json.loads(sys.stdin.read() or "{}")
    try:
        out = modes[sys.argv[1]](params)
    except GuardError as e:
        sys.exit(f"pacer guard rejected spec: {e}")
    except Exception as e:
        # One clean line, not a traceback — the Node caller surfaces the last
        # stderr line to the UI (and to the planning coach's repair loop).
        sys.exit(f"pacer {sys.argv[1]} failed: {e}")
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
