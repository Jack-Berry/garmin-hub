import assert from 'node:assert/strict';
import test from 'node:test';
import {
  matchIntervals, planCompliance, planDayStatus, planMatchesActivity, plannedDistance, plannedWorkSteps,
} from './activityMatch.js';

const step = (distance, bounds = null, kind = 'interval') => ({
  type: 'ExecutableStepDTO',
  stepType: { stepTypeKey: kind },
  endCondition: { conditionTypeKey: 'distance' },
  endConditionValue: distance,
  targetType: { workoutTargetTypeKey: bounds ? 'pace.zone' : 'no.target' },
  targetValueOne: bounds ? 1000 / bounds[0] : null,
  targetValueTwo: bounds ? 1000 / bounds[1] : null,
});
const lap = (lap_index, pace, distance_m = 1000, intensity_type = 'ACTIVE') => ({
  lap_index, intensity_type, distance_m, avg_speed_mps: 1000 / pace,
});
const garmin = (steps) => [{ workoutSteps: steps }];

test('2026-10-01 consumes untargeted blocks and grades both 4 km reps', () => {
  const plan = garmin([
    step(3000), step(4000, [255, 275]), step(3000), step(4000, [255, 275]), step(3000),
  ]);
  const paces = [349, 327, 315, 264, 261, 263, 268, 315, 317, 314, 265, 267, 266, 265, 323, 345, 328];
  const matches = matchIntervals(paces.map((value, i) => lap(i + 1, value)), plan);
  assert.deepEqual(matches.map((row) => row.status), ['hit', 'hit']);
  assert.deepEqual(matches.map((row) => row.laps.map((item) => item.lap_index)), [[4, 5, 6, 7], [11, 12, 13, 14]]);
});

test('2026-09-29 keeps each 2 km tempo rep together across auto-laps', () => {
  const repeat = {
    type: 'RepeatGroupDTO', numberOfIterations: 2,
    workoutSteps: [step(2000, [240, 260]), {
      type: 'ExecutableStepDTO', stepType: { stepTypeKey: 'rest' },
      endCondition: { conditionTypeKey: 'time' }, endConditionValue: 120,
    }],
  };
  const plan = garmin([step(2500, null, 'warmup'), repeat, step(1500, null, 'cooldown')]);
  const laps = [
    lap(1, 309, 1000, 'WARMUP'), lap(2, 307, 1000, 'WARMUP'), lap(3, 311, 500, 'WARMUP'),
    lap(4, 252), lap(5, 244), lap(6, 1069, 110, 'REST'),
    lap(7, 253), lap(8, 249), lap(9, 2083, 60, 'REST'),
  ];
  const matches = matchIntervals(laps, plan);
  assert.equal(plannedDistance(plan), 8000);
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((row) => row.laps.map((item) => item.lap_index)), [[4, 5], [7, 8]]);
  assert.deepEqual(matches.map((row) => row.status), ['hit', 'hit']);
});

test('2026-09-27 grades one 10 km step from ten laps, not lap one', () => {
  const plan = garmin([step(10000, [250, 260])]);
  const matches = matchIntervals(Array.from({ length: 10 }, (_, i) => lap(i + 1, 254 + i % 3)), plan);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].laps.length, 10);
  assert.equal(matches[0].status, 'hit');
});

test('app negative split mirrors the builder profile and default two-second band', () => {
  const steps = plannedWorkSteps({ blocks: [{ length_m: 20000, segment_m: 500, target: '5:00', strategy: 'negative' }] });
  assert.equal(steps.length, 40);
  assert.deepEqual({ fast: steps[0].fast, slow: steps[0].slow }, { fast: 302, slow: 306 });
  assert.deepEqual({ fast: steps.at(-2).fast, slow: steps.at(-2).slow }, { fast: 270, slow: 295 });
  assert.deepEqual({ fast: steps.at(-1).fast, slow: steps.at(-1).slow }, { fast: 240, slow: 290 });
  assert.deepEqual(
    plannedWorkSteps({ blocks: [{ length_m: 400, segment_m: 400, target: 300 }] }).map(({ fast, slow }) => ({ fast, slow })),
    [{ fast: 298, slow: 302 }],
  );
});

test('simple sub-44 target is converted from 10 km finish time to pace', () => {
  const steps = plannedWorkSteps({ distance_m: 10000, segment_m: 500, target: 'sub 44' });
  assert.equal(steps.length, 20);
  assert.deepEqual({ fast: steps[0].fast, slow: steps[0].slow }, { fast: 262, slow: 266 });
  const fiveK = plannedWorkSteps({ distance_m: 5000, segment_m: 500, target: '19:54' });
  assert.equal(fiveK[0].fast, 236.8);
  assert.equal(fiveK[0].slow, 240.8);
});

test('Runna text stays ungraded', () => {
  assert.deepEqual(plannedWorkSteps(['8 x 400m hard', '90 sec recovery']), []);
});

test('only the closest plausible same-day run matches a planned distance', () => {
  const workout = { steps: garmin([step(10000, [250, 260])]) };
  const warmup = { activity_id: 'warmup', activity_group: 'run', distance_m: 1278 };
  const race = { activity_id: 'race', activity_group: 'run', distance_m: 10069 };
  assert.equal(planMatchesActivity(warmup, workout, [warmup, race]), false);
  assert.equal(planMatchesActivity(race, workout, [warmup, race]), true);
});

test('planned day status uses the 70% boundary and handles overruns', () => {
  const workout = { estimated_distance_m: 10000, steps: [] };
  assert.equal(planDayStatus(workout, [{ activity_group: 'run', distance_m: 7000 }]), 'done');
  assert.equal(planDayStatus(workout, [{ activity_group: 'run', distance_m: 8500 }]), 'done');
  assert.equal(planDayStatus(workout, [{ activity_group: 'run', distance_m: 12000 }]), 'done');
  assert.equal(planDayStatus(workout, [{ activity_group: 'run', distance_m: 6999 }]), 'partial');
  assert.equal(planDayStatus(workout, []), 'pending');
});

test('planned day status treats unknown Runna text and double days correctly', () => {
  const textOnly = { steps: ['8 x 400m hard'] };
  assert.equal(planDayStatus(textOnly, [{ activity_group: 'run', distance_m: 5000 }]), 'done');
  const workout = { estimated_distance_m: 10000 };
  assert.equal(planDayStatus(workout, [
    { activity_group: 'run', distance_m: 2000 },
    { activity_group: 'run', distance_m: 7000 },
  ]), 'done');
  assert.equal(planDayStatus(workout, [{ activity_group: 'football', distance_m: 12000 }]), 'pending');
});

test('plan compliance excludes today pending and does not count partial', () => {
  const planned = {
    '2026-10-12': { estimated_distance_m: 10000 },
    '2026-10-13': { estimated_distance_m: 10000 },
    '2026-10-14': { estimated_distance_m: 10000 },
    '2026-10-15': { estimated_distance_m: 10000 },
  };
  const runs = {
    '2026-10-12': [{ activity_group: 'run', distance_m: 10000 }],
    '2026-10-13': [{ activity_group: 'run', distance_m: 6000 }],
    '2026-10-15': [{ activity_group: 'run', distance_m: 7000 }],
  };
  assert.deepEqual(planCompliance(planned, runs, '2026-10-15'), { done: 2, total: 4 });
});

test('2026-07-12 grades 500 m pacer steps per 1 km lap without drifting', () => {
  const spec = { distance_m: 10000, segment_m: 500, target: 'sub 44', strategy: 'negative' };
  const paces = [269.2, 263.1, 264.7, 265.1, 268.4, 272.7, 267.6, 273.4, 271.4];
  const laps = paces.map((pace, i) => ({ ...lap(i + 1, pace), intensity_type: 'INTERVAL' }));
  laps.push({ ...lap(10, 251.4, 760), intensity_type: 'INTERVAL' });
  const matches = matchIntervals(laps, spec);
  assert.equal(matches.length, 10);
  assert.ok(matches.every((row) => row.byLap && row.steps >= 1));
  assert.deepEqual(matches.map((row) => row.lap.lap_index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(matches[0].status, 'hit');
  assert.equal(matches[9].status, 'hit');
});

test('a short lap straddling a step boundary is split pro rata', () => {
  const plan = garmin([step(1500), step(2000, [255, 265]), step(1500)]);
  const laps = [lap(1, 330), lap(2, 330, 500), lap(3, 260), lap(4, 260), lap(5, 330, 500), lap(6, 330)];
  const [rep] = matchIntervals(laps, plan);
  assert.deepEqual(rep.laps.map((item) => item.lap_index), [3, 4]);
  assert.equal(rep.status, 'hit');
  const offset = [lap(1, 330), lap(2, 330, 1250), lap(3, 260), lap(4, 260), lap(5, 330)];
  assert.deepEqual(matchIntervals(offset, plan).map((row) => [row.lap.lap_index, row.status]),
    [[2, 'mixed'], [3, 'hit'], [4, 'mixed']]);
});

test('a lap that is half easy and half rep is shown but not graded', () => {
  const plan = garmin([step(1500), step(1000, [255, 265]), step(1500)]);
  const rows = matchIntervals([lap(1, 330), lap(2, 300), lap(3, 260), lap(4, 330)], plan);
  assert.deepEqual(rows.map((row) => [row.lap.lap_index, row.status]), [[2, 'mixed'], [3, 'mixed']]);
});
