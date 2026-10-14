const assert = require('node:assert/strict');
const test = require('node:test');
const { deriveSignals, sectionWeeklyMileage } = require('./context');

const baseRecovery = (latest) => ({
  latest: {
    hrv: null,
    hrv_status: null,
    hrv_baseline: [null, null],
    readiness_score: null,
    readiness_level: null,
    readiness_measured: null,
    readiness_on_waking: null,
    readiness_level_on_waking: null,
    ...latest,
  },
  avg_14d: { readiness_on_waking: 70 },
});

const weeks = [
  { week_start: '2026-10-12', km: 0, complete: false },
  { week_start: '2026-10-05', km: 30, complete: true },
  { week_start: '2026-09-28', km: 28, complete: true },
  { week_start: '2026-09-21', km: 31, complete: true },
];

test('readiness flags use the wake reading, not a post-exercise score', () => {
  const signals = deriveSignals(baseRecovery({
    readiness_score: 20,
    readiness_level: 'LOW',
    readiness_measured: 'after_exercise',
    readiness_on_waking: 88,
    readiness_level_on_waking: 'HIGH',
  }), weeks);
  assert.equal(signals.flags.some((flag) => flag.startsWith('readiness')), false);

  const fallback = deriveSignals(baseRecovery({
    readiness_score: 25,
    readiness_level: 'LOW',
    readiness_measured: 'on_waking',
  }), weeks);
  assert.ok(fallback.flags.includes('readiness LOW'));
});

test('weekly mileage labels Mondays, inserts current zero, and flags only complete weeks', async () => {
  const db = {
    all: async () => [
      { week_start: '2026-10-05', m: 50000 },
      { week_start: '2026-09-28', m: 30000 },
      { week_start: '2026-09-21', m: 30000 },
      { week_start: '2026-09-14', m: 30000 },
    ],
  };
  const mileage = await sectionWeeklyMileage(db, '2026-10-14');
  assert.deepEqual(mileage[0], { week_start: '2026-10-12', km: 0, complete: false });
  assert.deepEqual(mileage[1], { week_start: '2026-10-05', km: 50, complete: true });
  assert.ok(deriveSignals(baseRecovery({}), mileage).flags.includes(
    'weekly mileage spike vs prior weeks'));

  mileage[0].km = 100;
  mileage[1].km = 30;
  assert.equal(deriveSignals(baseRecovery({}), mileage).flags.includes(
    'weekly mileage spike vs prior weeks'), false);
});
