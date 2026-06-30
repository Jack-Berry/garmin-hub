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


def build(params):
    """Map approved params -> the Garmin workout dict via the proven builder."""
    return wb.build_pacer(
        distance_m=float(params["distance_m"]),
        target=params["target"],
        strategy=params.get("strategy", "flat"),
        segment_m=float(params.get("segment_m") or wb.SEGMENT_DEFAULT_M),
        warmup_m=float(params["warmup_m"]) if params.get("warmup_m") else None,
        cooldown_m=float(params["cooldown_m"]) if params.get("cooldown_m") else None,
    )


def breakdown(workout):
    """Built workout -> a flat, display-ready segment list (one per step)."""
    segs = []
    for s in workout["workoutSegments"][0]["workoutSteps"]:
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
    out = cmd_preview(params) if sys.argv[1] == "preview" else cmd_push(params)
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
