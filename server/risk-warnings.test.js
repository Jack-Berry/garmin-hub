const assert = require('node:assert/strict');
const test = require('node:test');
const { deriveRiskWarnings } = require('./risk-warnings');

const base = () => ({
  today: '2026-10-15',
  recovery: { latest: { acwr: null, hrv_baseline: [50, 70] }, last_7_days: [] },
  training_load: { today: { tsb: 0 } }, upcoming: [], profile: { injuries: [] }, coach_memory: [],
});

test('warns on an ACWR spike above 1.3', () => {
  const input = base(); input.recovery.latest.acwr = { ratio: 1.31 };
  assert.equal(deriveRiskWarnings(input)[0].code, 'acwr');
});

test('warns on three consecutive below-baseline HRV days', () => {
  const input = base(); input.recovery.last_7_days = [
    { date: '2026-10-15', hrv: 44 }, { date: '2026-10-14', hrv: 46 }, { date: '2026-10-13', hrv: 48 },
  ];
  assert.equal(deriveRiskWarnings(input)[0].code, 'hrv_streak');
});

test('warns when TSB is below -20 within seven days of a race', () => {
  const input = base(); input.training_load.today.tsb = -20.1;
  input.upcoming = [{ date: '2026-10-22', title: '5K Race', is_race: true }];
  assert.equal(deriveRiskWarnings(input)[0].code, 'race_fatigue');
});

test('warns for the same niggle mentioned on two distinct days', () => {
  const input = base(); input.coach_memory = [
    { date: '2026-10-12', fact: 'Right knee niggle after the run.' },
    { date: '2026-10-14', fact: 'Right knee pain returned.' },
  ];
  assert.equal(deriveRiskWarnings(input)[0].code, 'repeated_niggle');
});
