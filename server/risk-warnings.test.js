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

test('does not warn for a small three-day fall well above baseline', () => {
  const input = base(); input.recovery.last_7_days = [
    { date: '2026-10-15', hrv: 70 }, { date: '2026-10-14', hrv: 71 }, { date: '2026-10-13', hrv: 72 },
  ];
  assert.equal(deriveRiskWarnings(input).some((warning) => warning.code === 'hrv_streak'), false);
});

test('warns when TSB is below -20 within seven days of a race', () => {
  const input = base(); input.training_load.today.tsb = -20.1;
  input.upcoming = [{ date: '2026-10-22', title: '5K Race', is_race: true }];
  assert.equal(deriveRiskWarnings(input)[0].code, 'race_fatigue');
});

test('uses profile race dates and ignores race practice without a manual override', () => {
  const input = base(); input.training_load.today.tsb = -21;
  input.upcoming = [{ date: '2026-10-18', title: '10K Race Practice', is_race: true }];
  assert.equal(deriveRiskWarnings(input).some((warning) => warning.code === 'race_fatigue'), false);
  input.profile.races = ['Autumn 10K on 2026-10-20'];
  assert.equal(deriveRiskWarnings(input).some((warning) => warning.code === 'race_fatigue'), true);
  input.profile.races = [];
  input.upcoming[0].is_race_override = 1;
  assert.equal(deriveRiskWarnings(input).some((warning) => warning.code === 'race_fatigue'), true);
});

test('warns for the same niggle mentioned on two distinct days', () => {
  const input = base(); input.coach_memory = [
    { date: '2026-10-12', fact: 'Right knee niggle after the run.' },
    { date: '2026-10-14', fact: 'Right knee pain returned.' },
  ];
  assert.equal(deriveRiskWarnings(input)[0].code, 'repeated_niggle');
});

test('niggle matching rejects substring, bare back, stale and resolved false positives', () => {
  const input = base(); input.coach_memory = [
    { date: '2026-10-14', fact: 'Reached a new volume target.' },
    { date: '2026-10-13', fact: 'Coached through the session.' },
    { date: '2026-10-12', fact: 'Back-to-back long runs went well.' },
    { date: '2026-10-11', fact: 'Came back strong.' },
    { date: '2026-10-10', fact: 'A scheduling constraint changed.' },
    { date: '2026-10-09', fact: 'Travelled to Spain.' },
    { date: '2025-03-01', fact: 'Old calf strain, fully resolved.' },
    { date: '2025-03-02', fact: 'Calf no longer sore.' },
  ];
  assert.equal(deriveRiskWarnings(input).some((warning) => warning.code === 'repeated_niggle'), false);
});
