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

const consume = (laps, start, step) => {
  let distance = 0;
  let seconds = 0;
  let index = start;
  const consumed = [];
  while (index < laps.length) {
    const lap = laps[index];
    consumed.push(lap);
    distance += Number(lap.distance_m || 0);
    seconds += lapSeconds(lap);
    index += 1;
    if (step.distance_m > 0 && distance + 1 >= step.distance_m) break;
    if (step.duration_s > 0 && seconds + 1 >= step.duration_s) break;
    if (!(step.distance_m > 0) && !(step.duration_s > 0)) break;
  }
  return { consumed, distance, seconds, next: index };
};

// Walk every work step in order, including untargeted steps, and consume the
// active laps covered by that step's distance or time. Only targeted steps are
// returned for grading. Their actual pace is weighted by distance across every
// consumed lap, so a 4 km planned rep is judged on all four 1 km auto-laps.
export const matchIntervals = (laps, steps) => {
  const actual = (laps || []).filter((lap) => activeLap(lap) && lap.distance_m > 0 && lap.avg_speed_mps > 0);
  const matches = [];
  let lapIndex = 0;
  for (const step of planSteps(steps)) {
    const used = consume(actual, lapIndex, step);
    lapIndex = used.next;
    if (!step.targeted) continue;
    if (!used.consumed.length || !(used.distance > 0) || !(used.seconds > 0)) {
      matches.push({ ...step, laps: [], lap: null, pace: null, status: null });
      continue;
    }
    const pace = used.seconds / (used.distance / 1000);
    const outside = pace < step.fast ? step.fast - pace : pace > step.slow ? pace - step.slow : 0;
    matches.push({ ...step, laps: used.consumed, lap: used.consumed[0], pace, status: outside === 0 ? 'hit' : outside <= 10 ? 'close' : 'missed' });
  }
  return matches;
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
