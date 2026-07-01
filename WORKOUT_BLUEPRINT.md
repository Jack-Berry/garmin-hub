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

**Rest vs recovery** — Garmin has a real `rest` step (stepTypeId 5, no pace target), ending on either **time** (seconds) or **distance** (metres). A rest block — `{kind: "rest", rest_s}` (time) or `{kind: "rest", length_m}` (distance) — emits that real rest step; it is **not** a slow running block. (A deliberate slow *recovery jog* between efforts can still be modelled as a slow paced block if you want the athlete running — but a true rest/standstill is now a real Garmin rest step.)

---

## Assess before proposing

Before proposing ANY plan or session, assess first. The assessment **governs** the proposal — it is not a preamble you write and then ignore.

1. **Scan.** Read the context: `upcoming` (races, planned Runna workouts), `recent_runs` (load already in the legs), and `recovery` (readiness, HRV vs baseline, resting HR, sleep, training status).
2. **Identify constraints.** Name what limits this week: a race to arrive fresh for, a race just completed that needs recovery, high recent load, or poor readiness. A week bracketed by races is the clearest case — the days between exist to keep the athlete fresh, not to train.
3. **Check the request against the constraints.** Hold whatever was asked for up against what you found. If it would compromise a race or pile onto fatigue, the constraint wins over what sounds appealing.
4. **State the assessment and the constraint before proposing.** One or two sentences: what you see and the limit it sets ("A race Saturday and another the following Saturday, so this week stays minimal — freshness, not volume.").
5. **Propose the lightest defensible plan within that constraint.** Start from the floor and let the athlete ADD, rather than proposing a full week they have to talk you down from.

---

## Pace reference

Pace reference — now LT-derived (implemented). Zone paces are no longer a static table. They're computed live by server/zones.js from the athlete's current lactate threshold (profile.lt_speed_mps), via per-zone ratios + derived bands. Goal/target paces (for "reach" sessions) come from server/goalpaces.js. Archetypes below reference zone names (easy, steady, marathon, threshold, tenk, fivek, rep) — the builder resolves these to m/s at build time from the live modules. See CLAUDE.md Stage 8a for the full pace system.

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

**Trains:** VO2max / speed. **Structure:** warmup + N×[hard rep, real rest] + cooldown, no trailing rest. **Segments:** each hard rep is ONE block (`segment_m == length_m`); recoveries are real rest steps.

```
warmup_m: <e.g. 1500>
blocks: [
  { length_m: <rep>, segment_m: <rep>, target: 5k_pace, strategy: flat }, // hard rep, one block
  { kind: "rest", rest_s: <e.g. 60> },                                     // real rest (time), OR
  { kind: "rest", length_m: <e.g. 200> },                                  //   real rest (distance)
  ... rep, rest, ... N reps with N-1 rests between them, no trailing rest ...
]
cooldown_m: <e.g. 1000>
```

e.g. "7×400m at 5k pace, 200m recovery" = 7 rep blocks + 6 rest blocks (13 blocks, no trailing rest).

### 5. Tempo

**Trains:** threshold / sustained effort. **Structure:** warmup + one (or few) long threshold block + cooldown. **Segments:** 500m.

```
warmup_m: 1500
blocks: [ { length_m: <e.g. 5000>, segment_m: 500, target: threshold, strategy: flat } ]
cooldown_m: 1000
```

### 6. Threshold (reps)

**Trains:** threshold via longer cruise reps with short rests. **Structure:** warmup + N×[threshold rep, short real rest] + cooldown, no trailing rest. Like intervals but longer reps, shorter rests, threshold (not 5k) pace. **Segments:** each rep is ONE block (`segment_m == length_m`) — a rep is a single effort, not chopped. (Continuous threshold running is a *tempo*, archetype 5, which gets 500m; a rep does not.)

```
warmup_m: 1500
blocks: [
  { length_m: 1600, segment_m: 1600, target: threshold, strategy: flat }, // rep, one block
  { kind: "rest", rest_s: 60 },                                           // short real rest
  ... rep, rest, ... ×N, no trailing rest ...
]
cooldown_m: 1000
```

### 7. Fartlek

**Trains:** speed variation, sustained varied-pace effort. **Core principle:** _continuous_ running that alternates between a faster and a less-fast (but still working) pace, with **no rest between the alternations** — the slower portion is an active float, not a recovery. A genuine rest (if any) comes **once, at the end, after all reps are complete**.

Key points the system must understand:

- The reps run **continuously** — hard/float/hard/float with no stopping between them. The "float" is still a fast-ish pace (e.g. hard 4:00, float 4:50 — both quick), NOT an easy recovery jog. Both hard and float are **paced running blocks**; a float is never a rest step.
- The rest comes **after the whole set**, not between reps, and it is a **real rest step** (`{kind: "rest", rest_s}` — e.g. 7×[300m/300m] straight through, THEN a single `{kind: "rest", rest_s: 90}`).
- Warmup + cooldown bookend as usual.
- Many shapes exist — don't over-prescribe; convey the principle (continuous alternating effort) and let the coach compose specifics.

Example (a real one the user has done): warmup 2km ≤5:10 → **7× [300m @ 4:00, 300m @ 4:50] run continuously** (all paced blocks) → `{kind: "rest", rest_s: 90}` → cooldown 2km easy. The 7 reps are unbroken; the only rest is the single 90s rest step after all of them.

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

**Trains:** varied intervals. **Structure:** reps that grow then shrink (e.g. 200-400-800-400-200), each separated by a real rest step, no trailing rest. **Segments:** each rep is ONE block (`segment_m == length_m`); recoveries are real rest steps.

```
warmup_m: 1500
blocks: [
  { 200m hard rep, one block }, { kind: "rest", ... },
  { 400m hard rep, one block }, { kind: "rest", ... },
  { 800m hard rep, one block }, { kind: "rest", ... },
  { 400m hard rep, one block }, { kind: "rest", ... },
  { 200m hard rep, one block }                          // last rep, no trailing rest
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

- LT-derived pace system implemented (zones.js + goalpaces.js) — see CLAUDE.md 8a.
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
