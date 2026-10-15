const assert = require('node:assert/strict');
const test = require('node:test');
const {
  longRunDrift,
  trainingHistorySummary,
  planComplianceSummary,
} = require('./coach-evidence');
const { computeTrainingLoad } = require('./training-load');

const shift = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

test('CTL, ATL and TSB use 42 day and 7 day EWMA recurrences', () => {
  const today = '2026-10-14';
  const rows = Array.from({ length: 120 }, (_, index) => ({
    date: shift(today, index - 119),
    load: 100,
  }));
  const result = computeTrainingLoad(rows, today);
  const expectedCtl = 100 * (1 - (41 / 42) ** 120);
  const expectedAtl = 100 * (1 - (6 / 7) ** 120);
  assert.equal(result.today.ctl, +expectedCtl.toFixed(1));
  assert.equal(result.today.atl, +expectedAtl.toFixed(1));
  assert.equal(result.today.tsb, +(expectedCtl - expectedAtl).toFixed(1));
  assert.equal(result.trend_8w.length, 8);
  assert.match(result.method, /Garmin activity training load/);
});

test('training history states its intensity, efficiency and drift methods', async () => {
  const db = {
    all: async (sql) => {
      if (sql.includes('FROM activities')) return [
        {
          activity_id: '1', date: '2026-10-10', name: 'Easy long run',
          distance_m: 12000, duration_s: 3600, avg_hr: 142, avg_speed_mps: 3.33,
          avg_grade_adjusted_speed_mps: 3.4, hr_zone1_s: 600, hr_zone2_s: 2400,
          hr_zone3_s: 300, hr_zone4_s: 0, hr_zone5_s: 0, activity_training_load: 120,
          elevation_gain_m: 80,
        },
        {
          activity_id: '2', date: '2026-10-08', name: 'Easy run',
          distance_m: 8000, duration_s: 2450, avg_hr: 143, avg_speed_mps: 3.27,
          avg_grade_adjusted_speed_mps: 3.35, hr_zone1_s: 300, hr_zone2_s: 1900,
          hr_zone3_s: 100, hr_zone4_s: 0, hr_zone5_s: 0, activity_training_load: 70,
          elevation_gain_m: 40,
        },
      ];
      if (sql.includes('FROM laps')) return [
        { activity_id: '1', lap_index: 1, distance_m: 6000, duration_s: 1740,
          avg_hr: 138, avg_grade_adjusted_speed_mps: 3.5, intensity_type: 'ACTIVE' },
        { activity_id: '1', lap_index: 2, distance_m: 6000, duration_s: 1860,
          avg_hr: 146, avg_grade_adjusted_speed_mps: 3.3, intensity_type: 'ACTIVE' },
      ];
      return [{ calendar_date: '2026-10-10', title: 'Autumn Race', estimated_distance_m: 12000,
        is_race_auto: 1, is_race_override: null }];
    },
  };
  const text = await trainingHistorySummary(db, { weeks: 2 }, '2026-10-14');
  assert.match(text, /HR zones/);
  assert.match(text, /average grade-adjusted pace/);
  assert.match(text, /Approximate HR drift/);
  assert.match(text, /20\.0km, 2 runs, longest 12\.0km/);
  assert.match(text, /aerobic efficiency \d+:\d{2}\/km \(2 runs\)/);
  assert.match(text, /long-run drift \d+\.\d%/);
  assert.match(text, /2026-10-10 \(Sat\) Autumn Race/);
});

test('long-run drift excludes races, structured work, and very hilly runs', () => {
  const run = {
    name: 'Easy long run', distance_m: 12000, elevation_gain_m: 100,
    hr_zone1_s: 300, hr_zone2_s: 3000, hr_zone3_s: 200, hr_zone4_s: 0, hr_zone5_s: 0,
  };
  const laps = [
    { distance_m: 6000, duration_s: 1800, avg_hr: 140,
      avg_grade_adjusted_speed_mps: 3.4, intensity_type: 'ACTIVE' },
    { distance_m: 6000, duration_s: 1850, avg_hr: 148,
      avg_grade_adjusted_speed_mps: 3.2, intensity_type: 'ACTIVE' },
  ];
  assert.ok(longRunDrift(run, laps) > 0);
  assert.equal(longRunDrift({ ...run, name: 'Half Marathon Race' }, laps), null);
  assert.equal(longRunDrift(run, [laps[0], { ...laps[1], intensity_type: 'RECOVERY' }]), null);
  assert.equal(longRunDrift({ ...run, elevation_gain_m: 400 }, laps), null);
});

test('plan compliance applies app precedence and race dedupe before matching', async () => {
  const db = {
    all: async (sql) => {
      if (sql.includes('FROM planned_workouts')) return [
        { calendar_date: '2026-10-01', title: 'App tempo', estimated_distance_m: 10000,
          source: 'app', plan_status: 'active', is_race_auto: 0, is_race_override: null },
        { calendar_date: '2026-10-01', title: 'Runna tempo', estimated_distance_m: 10000,
          source: 'runna_ical', plan_status: null, is_race_auto: 0, is_race_override: null },
        { calendar_date: '2026-10-02', title: '5K Race', estimated_distance_m: 5000,
          source: 'garmin', plan_status: null, is_race_auto: 1, is_race_override: null },
        { calendar_date: '2026-10-02', title: '5K Pacer', estimated_distance_m: 5000,
          source: 'garmin', plan_status: null, is_race_auto: 0, is_race_override: null },
      ];
      return [
        { activity_id: '1', date: '2026-10-01', name: 'Tempo done', distance_m: 9000 },
        { activity_id: '2', date: '2026-10-02', name: 'Short race', distance_m: 3000 },
        { activity_id: '3', date: '2026-10-03', name: 'Extra easy', distance_m: 6000 },
      ];
    },
  };
  const text = await planComplianceSummary(db, { weeks: 4 }, '2026-10-14');
  assert.match(text, /completed - App tempo/);
  assert.doesNotMatch(text, /Runna tempo/);
  assert.match(text, /partial - 5K Race/);
  assert.doesNotMatch(text, /5K Pacer/);
  assert.match(text, /extra - Extra easy/);
  assert.match(text, /completion 50% \(1\/2\)/);
});

test('Monday weeks=1 uses the most recent complete week', async () => {
  const calls = [];
  const db = { all: async (sql, params) => { calls.push({ sql, params }); return []; } };
  const text = await planComplianceSummary(db, { weeks: 1 }, '2026-10-12');
  assert.deepEqual(calls[0].params, ['2026-10-05', '2026-10-11', '2026-10-12']);
  assert.match(text, /2026-10-05 to 2026-10-11/);
});

test('compliance uses the web-aligned 70% threshold and formats unknown distance', async () => {
  const db = {
    all: async (sql) => sql.includes('FROM planned_workouts') ? [
      { calendar_date: '2026-10-05', title: 'At threshold', estimated_distance_m: 10000,
        source: 'garmin', plan_status: null },
      { calendar_date: '2026-10-06', title: 'Below threshold', estimated_distance_m: 10000,
        source: 'garmin', plan_status: null },
      { calendar_date: '2026-10-07', title: 'Open distance', estimated_distance_m: null,
        source: 'garmin', plan_status: null },
    ] : [
      { activity_id: '1', date: '2026-10-05', name: 'Seven', distance_m: 7000 },
      { activity_id: '2', date: '2026-10-06', name: 'Just short', distance_m: 6999 },
      { activity_id: '3', date: '2026-10-07', name: 'Timed run', distance_m: 5000 },
    ],
  };
  const text = await planComplianceSummary(db, { weeks: 2 }, '2026-10-14');
  assert.match(text, /completed - At threshold/);
  assert.match(text, /partial - Below threshold/);
  assert.match(text, /planned unknown, done 5\.0km/);
  assert.doesNotMatch(text, /n\/akm/);
});
