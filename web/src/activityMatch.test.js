import assert from 'node:assert/strict';
import test from 'node:test';
import { matchIntervals, plannedWorkSteps } from './activityMatch.js';

const target = (fast, slow, type = 'interval') => ({
  type: 'ExecutableStepDTO',
  stepType: { stepTypeKey: type },
  targetType: { workoutTargetTypeKey: 'pace.zone' },
  targetValueOne: 1000 / fast,
  targetValueTwo: 1000 / slow,
});

test('expands Garmin repeats and ignores recovery targets', () => {
  const steps = [{ workoutSteps: [{
    type: 'RepeatGroupDTO', numberOfIterations: 2,
    workoutSteps: [target(240, 250), target(360, 380, 'recovery')],
  }] }];
  assert.equal(plannedWorkSteps(steps).length, 2);
});

test('matches active laps in order and grades target distance', () => {
  const steps = [{ workoutSteps: [target(240, 250), target(240, 250), target(240, 250)] }];
  const laps = [
    { intensity_type: 'active', avg_speed_mps: 1000 / 245 },
    { intensity_type: 'recovery', avg_speed_mps: 1000 / 370 },
    { intensity_type: 'active', avg_speed_mps: 1000 / 257 },
    { intensity_type: 'active', avg_speed_mps: 1000 / 275 },
  ];
  assert.deepEqual(matchIntervals(laps, steps).map((row) => row.status), ['hit', 'close', 'missed']);
});

test('expands app blocks and leaves Runna text ungraded', () => {
  const spec = { blocks: [{ kind: 'repeat', count: 2, blocks: [{ length_m: 400, segment_m: 400, target: '4:00', band_s: 2 }] }] };
  assert.equal(plannedWorkSteps(spec).length, 2);
  assert.equal(plannedWorkSteps({ distance_m: 5000, segment_m: 500, target: '4:00' }).length, 10);
  assert.deepEqual(plannedWorkSteps(['8 x 400m hard', '90 sec recovery']), []);
});
