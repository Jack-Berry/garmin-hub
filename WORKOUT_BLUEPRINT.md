# Workout Archetype Blueprint

**Purpose:** This document defines the workout styles the AI coach can generate. Each archetype maps a plain-English intent (e.g. "give me a fartlek") onto a `blocks` structure the deterministic builder (`build_pacer_blocks`) can construct and push to Garmin.

The AI's job: pick the archetype, fill in the parameters (distance, paces, rep counts), emit a `blocks` array. The builder's job: construct it exactly and push. This document is the shared vocabulary between them.

---

## Core concepts

**Block** = a portion of the run at one pace intent, chopped into segments.
`{ length_m, segment_m, target, strategy, band_s? }`

- `length_m` — how long this block runs.
- `segment_m` — granularity the block is chopped into. This is **driven by the workout, not a global default**: a 300m rep is a 300m segment, a 1600m threshold rep is a 1600m segment, an easy run is one coarse segment. **500m is the default ONLY for the Engo pacer archetype (#12)** — and even there it's changeable on request. Everywhere else, segment length = whatever that piece of the workout naturally is.
- `target` — goal pace (as pace or m/s).
- `strategy` — `flat` (hold the band) or `negative` (ramp faster through the block).
- `band_s` — ± seconds/km tolerance around target.

**Warmup / cooldown** — optional bookend steps, easy pace, wrap any workout.

**Rest vs recovery** — a "rest" between hard efforts is just a slow block (easy/recovery pace). Garmin has no true "stand still" step in our model; recovery = slow running block.

---

## Pace reference (DRAFT — to be replaced by an LT-derived algorithm)

Based on ~20:03 5k / 44:51 10k.

| Zone | Pace (/km) | Used for |
|---|---|---|
| Easy | 5:15–5:45 | easy runs, warmup, cooldown, recovery |
| Steady | 5:00–5:20 | long-run bulk, steady blocks |
| Marathon | 4:45–5:00 | — |
| Threshold / Tempo | 4:15–4:30 | tempo, threshold reps |
| 10k pace | 4:05–4:15 | cruise intervals |
| 5k pace | 3:55–4:05 | intervals |
| Rep / faster | 3:30–3:50 | short 400m reps, surges |

> **FUTURE (parked):** replace this static table with an algorithm that derives pace zones from Garmin's exposed **lactate threshold** data point + PB times. Garmin does the physiological work; we map LT → zones. This keeps paces accurate as fitness changes instead of hardcoding guesses. Not now — but the archetypes should reference *zone names* (Easy, Threshold, etc.) so that when the algorithm lands, only the table changes, not every archetype.

---

## The archetypes

### 1. Easy
**Trains:** aerobic base, recovery. **Structure:** one block, whole distance, easy band. **Segments:** coarse (no gauge needed).
```
blocks: [ { length_m: <dist>, segment_m: <dist>, target: easy, strategy: flat } ]
```
No warmup/cooldown (the whole thing is easy).

### 2. Long run
**Trains:** endurance. **Structure:** one steady block (optionally a gentle progression to finish). **Segments:** coarse, OR 500m if you want pace feedback.
```
blocks: [ { length_m: <dist>, segment_m: <coarse>, target: steady, strategy: flat } ]
```
Variant — progression long run: single block, `strategy: negative` (ramps faster through).

### 3. Recovery / shakeout
**Trains:** active recovery. **Structure:** identical to Easy but shorter and slower (very easy pace). Distinct name so the coach picks the right intent.
```
blocks: [ { length_m: <short dist>, segment_m: <coarse>, target: very_easy, strategy: flat } ]
```

### 4. Intervals
**Trains:** VO2max / speed. **Structure:** warmup + N×[hard block, recovery block] + cooldown. **Segments:** 500m on the hard reps (Engo gauge), coarse on recoveries.
```
warmup_m: <e.g. 1500>
blocks: [
  { length_m: <rep>, segment_m: 500, target: 5k_pace, strategy: flat },   // hard
  { length_m: <rest>, segment_m: <coarse>, target: easy, strategy: flat }, // recovery
  ... repeated N times ...
]
cooldown_m: <e.g. 1000>
```
e.g. "7×400m at 5k pace, 200m recovery" = 7 hard/recovery pairs.

### 5. Tempo
**Trains:** threshold / sustained effort. **Structure:** warmup + one (or few) long threshold block + cooldown. **Segments:** 500m.
```
warmup_m: 1500
blocks: [ { length_m: <e.g. 5000>, segment_m: 500, target: threshold, strategy: flat } ]
cooldown_m: 1000
```

### 6. Threshold (reps)
**Trains:** threshold via longer cruise reps with short rests. **Structure:** warmup + N×[threshold block, short recovery] + cooldown. Like intervals but longer reps, shorter rests, threshold (not 5k) pace.
```
warmup_m: 1500
blocks: [
  { length_m: 1600, segment_m: 500, target: threshold, strategy: flat },
  { length_m: 400, segment_m: <coarse>, target: easy, strategy: flat },
  ... ×N ...
]
cooldown_m: 1000
```

### 7. Fartlek
**Trains:** speed variation, sustained varied-pace effort. **Core principle:** *continuous* running that alternates between a faster and a less-fast (but still working) pace, with **no rest between the alternations** — the slower portion is an active float, not a recovery. A genuine rest (if any) comes **once, at the end, after all reps are complete**.

Key points the system must understand:
- The reps run **continuously** — hard/float/hard/float with no stopping between them. The "float" is still a fast-ish pace (e.g. hard 4:00, float 4:50 — both quick), NOT an easy recovery jog.
- The rest comes **after the whole set**, not between reps (e.g. 7×[300m/300m] straight through, THEN a 90s walking rest).
- Warmup + cooldown bookend as usual.
- Many shapes exist — don't over-prescribe; convey the principle (continuous alternating effort) and let the coach compose specifics.

Example (a real one the user has done): warmup 2km ≤5:10 → **7× [300m @ 4:00, 300m @ 4:50] run continuously** → 90s walking rest → cooldown 2km easy. The 7 reps are unbroken; the only rest is the single 90s after all of them.

This is a natural fit for a **repeat group** (see §6 headroom): "Set, repeat 7×: [300m hard, 300m float]" then a rest step then cooldown — exactly how Garmin/Runna display it.

### 8. Progression
**Trains:** pace control, finishing strong. **Structure:** several blocks, each faster than the last (or one block with `strategy: negative`). **Segments:** 500m.
```
blocks: [
  { length_m: <dist/3>, segment_m: 500, target: steady, strategy: flat },
  { length_m: <dist/3>, segment_m: 500, target: marathon, strategy: flat },
  { length_m: <dist/3>, segment_m: 500, target: threshold, strategy: flat }
]
```

### 9. Hotspot / surge
**Trains:** surging, changing gears mid-run. **Structure:** steady → embedded hard surge → steady (the one that failed before). **Segments:** 500m on the surge.
```
blocks: [
  { length_m: <steady1>, segment_m: coarse, target: steady, strategy: flat },
  { length_m: <surge>, segment_m: 500, target: 5k_pace, strategy: flat },  // the hotspot
  { length_m: <steady2>, segment_m: coarse, target: steady, strategy: flat }
]
```
Can have multiple hotspots (steady → surge → steady → surge → steady).

### 10. Pyramid
**Trains:** varied intervals. **Structure:** reps that grow then shrink (e.g. 200-400-800-400-200), each with recovery. **Segments:** 500m.
```
warmup_m: 1500
blocks: [
  { 200m hard, recovery },
  { 400m hard, recovery },
  { 800m hard, recovery },
  { 400m hard, recovery },
  { 200m hard, recovery }
]
cooldown_m: 1000
```

### 11. Hill reps — OUT OF SCOPE (not pace-based)
Pace is meaningless uphill, so hill reps don't fit the pace-band model. **Deliberately excluded** from the pacer archetypes. If ever wanted, they'd need an effort- or time-based end condition (different from the distance/pace model everything else uses) — a separate future consideration, not part of this blueprint.

### 12. Negative-split (the Engo pacer)
**Trains:** race execution — YOUR signature use case. **Structure:** the existing pacer, preserved exactly: whole race distance, 500m segments, `strategy: negative` (ramps from +Xs to -Xs through the run). Warmup optional. **This is the current pacer, untouched — just now one archetype among many.**
```
blocks: [ { length_m: <race dist>, segment_m: 500, target: goal_pace, strategy: negative, band_s: <band> } ]
```

---

## Decisions (all resolved)

- Easy pace corrected to 5:15–5:45. Pace table is close enough to build & test with now; **to be replaced later by an LT-derived algorithm** (parked — reference zone *names* so only the table changes).
- Segment length is workout-driven. **500m is a default ONLY for the pacer (#12), changeable on request.** Not a global default.
- Hill reps excluded (not pace-based).
- **Fartlek** = continuous alternating pace (hard/float, no stopping), rest only at the end. Described by principle, not rigid template.
- **Repeat-groups + time-based rests: YES** — the builder will be extended to emit Garmin `RepeatGroupDTO` and time-based end conditions for intervals & fartlek (cleaner, more fluid watch display, matches Runna). **The pacer (#12) stays flattened** — each 500m must be its own step for the Engo gauge; repeats don't apply there.
- **Warmup/cooldown: coach decides per workout** — no fixed default. The coach picks sensible bookends for the session type and user context (typically 1.5–2km each, but its call).

## Reliability / testing plan (this is a big step — build it safely)

An AI emitting workout specs that get pushed to a watch is higher-stakes than the current human Q&A. Guardrails, in order:

1. **Wire the block path + validation guard FIRST, before any AI.** Extend param schema to carry `blocks`; branch `pacer_cli.py` to `build_pacer_blocks`; add a validation guard (segment sanity, pace bounds, distance sanity, repeat-group correctness, warmup/cooldown sanity).
2. **Test every archetype by hand** — feed the builder a hand-written spec for each of the 11 in-scope types, PREVIEW it, confirm correct before Garmin sees anything. Preview = the test harness (same deterministic build as push).
3. **Then connect the AI** — give the coach this blueprint + the blocks schema; test each archetype AI-generated, previewed, several times, before enabling push.
4. **Push last, gated** — keep human confirmation before any Garmin sync (fits the "coach confirms verbally then pushes" vision). Nothing reaches the watch unvalidated.

Four layers between "AI has an idea" and "junk workout on watch": deterministic builder + validation guard + preview-as-test-harness + human confirmation.
