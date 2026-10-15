import guardBounds from '../../ingest/guard_bounds.json' with { type: 'json' };

const DEFAULT_SEGMENT_M = 500;
const DEFAULT_BAND_S = 2; // Mirrors workout_builder.py BAND_HALF_S.
const NEG = guardBounds.negative_split;
const skippedStep = (value) => /rest|recover|warm|cool/i.test(value || '');
const activeLap = (lap) => /active|interval/i.test(lap.intensity_type || '');

const parseClock = (value) => {
  const text = String(value || '').trim().toLowerCase();
  const match = text.match(/(\d+):(\d{2})/);
  if (match) return Number(match[1]) * 60 + Number(match[2]);
  const number = Number(text.replace(/sub|mins?|minutes?/g, '').trim());
  return number > 0 ? number * 60 : null;
};

const blockPace = (target) => {
  if (typeof target === 'number' && target > 0) return target;
  const text = String(target || '').replace(/\/k(?:m)?/i, '').trim();
  return text.includes(':') ? parseClock(text) : Number(text) || null;
};

const roundHalfEven = (value) => {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (Math.abs(fraction - 0.5) < 1e-9) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
};

const simplePace = (target, distanceM) => {
  const text = String(target || '').toLowerCase();
  const seconds = parseClock(text.replace(/\/k(?:m)?/i, ''));
  if (!seconds) return null;
  return /\/k(?:m)?/i.test(text) ? seconds : seconds / (distanceM / 1000);
};

const paceBounds = (one, two) => {
  if (!(one > 0) || !(two > 0)) return null;
  const paces = [1000 / one, 1000 / two];
  return { fast: Math.min(...paces), slow: Math.max(...paces) };
};

const segmentLengths = (lengthM, segmentM) => {
  const out = [];
  let remaining = lengthM;
  while (remaining > segmentM + 1e-6) {
    out.push(segmentM);
    remaining -= segmentM;
  }
  if (remaining > 0) out.push(remaining);
  return out;
};

const paceProfile = (count, center, block, segmentM) => {
  const band = Number(block.band_s ?? DEFAULT_BAND_S);
  if (block.strategy !== 'negative') {
    return Array.from({ length: count }, () => ({ fast: center - band, slow: center + band }));
  }
  const tank = count >= NEG.min_segments ? NEG.tank_segments : Math.max(0, count - 1);
  const rampCount = count - tank;
  const out = [];
  if ((block.ramp || 'km_paired') === 'km_paired') {
    const perKm = Math.max(1, roundHalfEven(1000 / segmentM));
    const groups = Math.max(1, Math.ceil(rampCount / perKm));
    for (let i = 0; i < rampCount; i += 1) {
      const group = Math.floor(i / perKm);
      const offset = groups === 1 ? NEG.start_offset_s
        : NEG.start_offset_s + (NEG.end_offset_s - NEG.start_offset_s) * group / (groups - 1);
      out.push({ fast: center + offset - band, slow: center + offset + band });
    }
  } else {
    for (let i = 0; i < rampCount; i += 1) {
      const offset = rampCount === 1 ? NEG.start_offset_s
        : NEG.start_offset_s + (NEG.end_offset_s - NEG.start_offset_s) * i / (rampCount - 1);
      out.push({ fast: center + offset - band, slow: center + offset + band });
    }
  }
  for (let i = 1; i <= tank; i += 1) {
    out.push({ fast: center - NEG.tank_faster_step_s * i, slow: center - NEG.tank_slower_step_s * i });
  }
  return out;
};

const garminPlanSteps = (segments) => {
  const out = [];
  const visit = (step) => {
    if (step?.type === 'RepeatGroupDTO') {
      for (let i = 0; i < (step.numberOfIterations || 1); i += 1) {
        (step.workoutSteps || []).forEach(visit);
      }
      return;
    }
    const label = step?.stepType?.stepTypeKey || 'work';
    if (skippedStep(label)) return;
    const target = step?.targetType?.workoutTargetTypeKey === 'pace.zone'
      ? paceBounds(step.targetValueOne, step.targetValueTwo)
      : null;
    const endKind = step?.endCondition?.conditionTypeKey;
    out.push({
      label,
      targeted: !!target,
      ...target,
      distance_m: endKind === 'distance' ? Number(step.endConditionValue) : null,
      duration_s: endKind === 'time' ? Number(step.endConditionValue) : null,
    });
  };
  (segments || []).flatMap((segment) => segment?.workoutSteps || []).forEach(visit);
  return out;
};

const appPlanSteps = (spec) => {
  const out = [];
  const visit = (block, centerOverride = null) => {
    if (block?.kind === 'repeat') {
      for (let i = 0; i < (block.count || 1); i += 1) (block.blocks || []).forEach(visit);
      return;
    }
    if (!block || block.kind === 'rest' || !block.target) return;
    const segmentM = Number(block.segment_m || DEFAULT_SEGMENT_M);
    const distances = segmentLengths(Number(block.length_m), segmentM);
    const center = centerOverride || blockPace(block.target);
    if (!center || !distances.length) return;
    paceProfile(distances.length, center, block, segmentM).forEach((bounds, index) => {
      out.push({ label: 'work', targeted: true, distance_m: distances[index], duration_s: null, ...bounds });
    });
  };
  if (spec?.blocks) {
    spec.blocks.forEach(visit);
  } else if (spec?.distance_m && spec?.target) {
    const center = simplePace(spec.target, spec.distance_m);
    if (center) visit({
      length_m: spec.distance_m,
      segment_m: spec.segment_m || DEFAULT_SEGMENT_M,
      target: spec.target,
      strategy: spec.strategy,
      ramp: spec.ramp,
      band_s: spec.band_s,
    }, center);
  }
  return out;
};

const planSteps = (steps) => Array.isArray(steps)
  ? garminPlanSteps(steps)
  : appPlanSteps(steps);

export const plannedWorkSteps = (steps) => {
  if (Array.isArray(steps) && steps.every((step) => typeof step === 'string')) return [];
  return planSteps(steps).filter((step) => step.targeted);
};

const lapSeconds = (lap) => lap.duration_s > 0
  ? Number(lap.duration_s)
  : lap.distance_m > 0 && lap.avg_speed_mps > 0 ? lap.distance_m / lap.avg_speed_mps : 0;

// Active laps laid end to end on one distance axis. Pace inside a lap is
// treated as constant, so any span of the axis can be timed pro rata.
const lapAxis = (laps) => {
  let distance = 0;
  let seconds = 0;
  return laps.map((lap) => {
    const row = { lap, d0: distance, t0: seconds, d: Number(lap.distance_m), t: lapSeconds(lap) };
    distance += row.d;
    seconds += row.t;
    return row;
  });
};

const distanceAfter = (axis, fromD, durationS) => {
  let left = durationS;
  for (const row of axis) {
    const from = Math.max(fromD, row.d0);
    if (from >= row.d0 + row.d) continue;
    const spanT = (row.d0 + row.d - from) * row.t / row.d;
    if (spanT >= left) return from + left * row.d / row.t;
    left -= spanT;
  }
  return Infinity;
};

const lapEndAfter = (axis, fromD) => {
  const row = axis.find((item) => item.d0 + item.d > fromD + 1);
  return row ? row.d0 + row.d : Infinity;
};

// A step is too coarse to grade when the laps touching it are much longer
// than the step itself, e.g. 500 m pacer steps recorded as 1 km auto-laps.
const COARSE_RATIO = 1.5;
const MIN_COVERAGE = 0.5;

// Each work step, targeted or not, takes its span of the active-lap distance
// axis in order (distance steps by length, time steps by elapsed time). A
// targeted step is graded on the time spent inside its span, so laps that
// straddle a step boundary are split pro rata instead of drifting later steps.
export const matchIntervals = (laps, steps) => {
  const actual = (laps || []).filter((lap) => activeLap(lap) && lap.distance_m > 0 && lap.avg_speed_mps > 0);
  const axis = lapAxis(actual);
  const matches = [];
  let cursor = 0;
  for (const step of planSteps(steps)) {
    const from = cursor;
    const to = step.distance_m > 0 ? from + step.distance_m
      : step.duration_s > 0 ? distanceAfter(axis, from, step.duration_s)
        : lapEndAfter(axis, from);
    cursor = to;
    if (!step.targeted) continue;
    let distance = 0;
    let seconds = 0;
    let touched = 0;
    const used = [];
    for (const row of axis) {
      const overlap = Math.min(to, row.d0 + row.d) - Math.max(from, row.d0);
      if (overlap <= 1) continue;
      used.push(row.lap);
      distance += overlap;
      seconds += overlap * row.t / row.d;
      touched += row.d;
    }
    const span = Number.isFinite(to) ? to - from : distance;
    const base = { ...step, from, to, laps: used, lap: used[0] || null };
    if (!(distance > 0) || distance < span * MIN_COVERAGE) {
      matches.push({ ...base, pace: null, status: null });
    } else if (touched > span * COARSE_RATIO) {
      matches.push({ ...base, axis, pace: null, status: 'coarse' });
    } else {
      const pace = seconds / (distance / 1000);
      matches.push({ ...base, pace, status: grade(pace, step) });
    }
  }
  return byLapWhereCoarse(matches);
};

const grade = (pace, bounds) => {
  const outside = pace < bounds.fast ? bounds.fast - pace : pace > bounds.slow ? pace - bounds.slow : 0;
  return outside === 0 ? 'hit' : outside <= 10 ? 'close' : 'missed';
};

// Steps too short for the recorded laps are graded per lap instead: each lap
// against the widest band of the steps it covers. That is the finest detail
// the watch recorded, and it never invents splits inside a lap. A lap that is
// mostly outside those steps (half easy, half rep) is shown but not graded.
const LAP_COVERAGE = 0.8;
const byLapWhereCoarse = (matches) => {
  const out = [];
  const seen = new Set();
  for (const match of matches) {
    if (match.status !== 'coarse') { out.push(match); continue; }
    for (const lap of match.laps) {
      if (seen.has(lap)) continue;
      seen.add(lap);
      const covered = matches.filter((item) => item.status === 'coarse' && item.laps.includes(lap));
      const bounds = {
        fast: Math.min(...covered.map((item) => item.fast)),
        slow: Math.max(...covered.map((item) => item.slow)),
      };
      const pace = lapSeconds(lap) / (Number(lap.distance_m) / 1000);
      const axisRow = match.axis.find((row) => row.lap === lap);
      const inside = covered.reduce((sum, item) => sum
        + Math.max(0, Math.min(item.to, axisRow.d0 + axisRow.d) - Math.max(item.from, axisRow.d0)), 0);
      const status = inside >= axisRow.d * LAP_COVERAGE ? grade(pace, bounds) : 'mixed';
      out.push({ ...bounds, byLap: true, steps: covered.length, laps: [lap], lap, pace, status });
    }
  }
  return out;
};

export const plannedDistance = (steps) => {
  if (Array.isArray(steps) && steps.every((step) => typeof step === 'string')) return null;
  if (Array.isArray(steps)) {
    const distanceOf = (step) => {
      if (step?.type === 'RepeatGroupDTO') {
        return (step.workoutSteps || []).reduce((sum, child) => sum + distanceOf(child), 0)
          * Number(step.numberOfIterations || 1);
      }
      return step?.endCondition?.conditionTypeKey === 'distance' ? Number(step.endConditionValue || 0) : 0;
    };
    const distance = steps.flatMap((segment) => segment?.workoutSteps || [])
      .reduce((sum, step) => sum + distanceOf(step), 0);
    return distance || null;
  }
  const blockDistance = (block) => block?.kind === 'repeat'
    ? Number(block.count || 1) * (block.blocks || []).reduce((sum, child) => sum + blockDistance(child), 0)
    : Number(block?.length_m || 0);
  const distance = (steps?.blocks || []).reduce((sum, block) => sum + blockDistance(block), 0)
    || Number(steps?.distance_m || 0);
  return distance + Number(steps?.warmup_m || 0) + Number(steps?.cooldown_m || 0) || null;
};

export const planMatchesActivity = (activity, workout, dayActivities) => {
  if (activity?.activity_group !== 'run') return false;
  const target = Number(workout?.estimated_distance_m) || plannedDistance(workout?.steps);
  if (!(target > 0)) return false;
  const runs = (dayActivities || [activity]).filter((item) => item.activity_group === 'run' && item.distance_m > 0);
  const closest = runs.reduce((best, item) => !best || Math.abs(item.distance_m - target) < Math.abs(best.distance_m - target) ? item : best, null);
  const tolerance = Math.max(500, target * 0.1);
  return String(closest?.activity_id) === String(activity.activity_id)
    && Math.abs(activity.distance_m - target) <= tolerance;
};

// A run below this share of the planned distance is shown as partial rather
// than leaving a planned cell looking complete.
export const PARTIAL_DISTANCE_RATIO = 0.7;

export const planDayStatus = (workout, dayActivities) => {
  const runs = (dayActivities || []).filter((activity) => activity.activity_group === 'run');
  if (!runs.length) return 'pending';
  if (runs.some((activity) => planMatchesActivity(activity, workout, runs))) return 'done';
  const target = Number(workout?.estimated_distance_m) || plannedDistance(workout?.steps);
  return target > 0 && runs.some((activity) => Number(activity.distance_m) < target * PARTIAL_DISTANCE_RATIO)
    ? 'partial'
    : 'pending';
};
