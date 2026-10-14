const paceSeconds = (value) => {
  if (typeof value === 'number' && value > 0) return value;
  const match = String(value || '').match(/(\d+):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

const paceBounds = (one, two) => {
  if (!(one > 0) || !(two > 0)) return null;
  const paces = [1000 / one, 1000 / two];
  return { fast: Math.min(...paces), slow: Math.max(...paces) };
};

const isRecovery = (value) => /rest|recover|warm|cool/i.test(value || '');

const garminSteps = (steps) => {
  const out = [];
  const visit = (step) => {
    if (step?.type === 'RepeatGroupDTO') {
      for (let i = 0; i < (step.numberOfIterations || 1); i += 1) {
        (step.workoutSteps || []).forEach(visit);
      }
      return;
    }
    const kind = step?.stepType?.stepTypeKey || '';
    const bounds = step?.targetType?.workoutTargetTypeKey === 'pace.zone'
      ? paceBounds(step.targetValueOne, step.targetValueTwo)
      : null;
    if (bounds && !isRecovery(kind)) out.push({ label: kind || 'work', ...bounds });
  };
  (steps || []).flatMap((segment) => segment?.workoutSteps || []).forEach(visit);
  return out;
};

const appSteps = (spec) => {
  const out = [];
  const visit = (block) => {
    if (block?.kind === 'repeat') {
      for (let i = 0; i < (block.count || 1); i += 1) (block.blocks || []).forEach(visit);
      return;
    }
    if (!block || block.kind === 'rest' || !block.target) return;
    const center = paceSeconds(block.target);
    if (!center) return;
    const count = Math.max(1, Math.ceil((block.length_m || 0) / (block.segment_m || block.length_m || 1)));
    const band = Number(block.band_s ?? 3);
    for (let i = 0; i < count; i += 1) {
      out.push({ label: 'work', fast: center - band, slow: center + band });
    }
  };
  const blocks = spec?.blocks || (spec?.distance_m && spec?.target ? [{
    length_m: spec.distance_m,
    segment_m: spec.segment_m,
    target: spec.target,
    band_s: spec.band_s,
  }] : []);
  blocks.forEach(visit);
  return out;
};

export const plannedWorkSteps = (steps) => {
  if (Array.isArray(steps) && steps.every((step) => typeof step === 'string')) return [];
  return Array.isArray(steps) ? garminSteps(steps) : appSteps(steps);
};

// Simple by design: pace-target work steps and non-recovery laps are paired in
// order. Inside the target band is hit, within 10 s/km of it is close, and any
// larger miss is missed. Extra steps or laps remain unmatched rather than being
// guessed into place.
export const matchIntervals = (laps, steps) => {
  const actual = (laps || []).filter((lap) => /active|interval/i.test(lap.intensity_type || '') && lap.avg_speed_mps > 0);
  return plannedWorkSteps(steps).map((step, index) => {
    const lap = actual[index];
    if (!lap) return { ...step, lap: null, status: null };
    const pace = 1000 / lap.avg_speed_mps;
    const outside = pace < step.fast ? step.fast - pace : pace > step.slow ? pace - step.slow : 0;
    return { ...step, lap, pace, status: outside === 0 ? 'hit' : outside <= 10 ? 'close' : 'missed' };
  });
};
