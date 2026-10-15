const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildContext, buildDayFocus, deriveSignals, sectionProfile,
  sectionRecentRuns, sectionRecovery, sectionTrainingLoad, sectionUpcoming,
  sectionWeeklyMileage,
} = require('./context');

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
  assert.deepEqual(Object.keys(signals), ['flags']);
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

test('a past planned session with no run is framed as missed', async () => {
  const db = {
    all: async () => [],
    get: async (sql) => {
      if (sql.includes('FROM planned_workouts')) {
        return { title: 'Tempo', estimated_distance_m: 5000,
          is_race: 0, steps_json: null };
      }
      if (sql.includes('SELECT routines_json')) return { routines_json: [] };
      return undefined;
    },
  };
  const focus = await buildDayFocus(db, '2000-01-01');
  assert.equal(focus.kind, 'missed');
  assert.equal(focus.planned.title, 'Tempo');
});

test('profile context skips a malformed race date with a warning', async () => {
  const db = {
    get: async () => ({
      races_json: [
        { name: 'Bad race', date: '2026-99-99', goal_time: '20:00' },
        { name: 'Good race', date: '2026-11-01', goal_time: '20:00' },
      ],
    }),
  };
  const profile = await sectionProfile(db);
  assert.equal(profile.races.length, 1);
  assert.match(profile.races[0], /^Good race.*2026-11-01 \(Sun\).*20:00$/);
  assert.match(profile.warnings[0], /Bad race \(2026-99-99\)/);
});

test('recent runs and planned entries carry explicit weekday labels', async () => {
  const recentDb = {
    all: async (sql) => sql.includes('FROM activities') ? [{
      activity_id: '1', date: '2026-10-12', distance_m: 5000, duration_s: 1500,
    }] : [],
  };
  const recent = await sectionRecentRuns(recentDb, '2026-10-14');
  assert.equal(recent[0].day, 'Mon');

  const plannedDb = { all: async () => [{
    calendar_date: '2026-10-18', title: 'Long run', estimated_distance_m: 18000,
    source: 'garmin', is_race_auto: 0, is_race_override: null, is_race: 0,
    steps_json: null, plan_status: null,
  }] };
  const upcoming = await sectionUpcoming(plannedDb, '2026-10-14');
  assert.equal(upcoming[0].day, 'Sun');
});

test('missing recovery load fields stay null rather than becoming zero', async () => {
  const recovery = await sectionRecovery({ all: async () => [{}] }, '2026-10-14');
  assert.equal(recovery.latest.acute_load, null);
  assert.equal(recovery.latest.acwr, null);
  assert.equal(recovery.latest.acwr_readiness_factor_score, null);
  assert.equal(recovery.latest.recovery_time_minutes, null);
  assert.equal(recovery.latest.body_battery, null);
  assert.equal(recovery.avg_14d.acute_load, null);
});

test('recovery exposes real ACWR separately from the Garmin readiness factor score', async () => {
  const row = {
    calendar_date: '2026-10-14', acwr_factor_pct: 86,
    raw_json: { training_status: { mostRecentTrainingStatus: { latestTrainingStatusData: {
      device: { acuteTrainingLoadDTO: {
        dailyAcuteChronicWorkloadRatio: 1.21, acwrStatus: 'OPTIMAL',
      } },
    } } } },
  };
  const recovery = await sectionRecovery({ all: async () => [row] }, '2026-10-14');
  assert.deepEqual(recovery.latest.acwr, { ratio: 1.21, status: 'OPTIMAL' });
  assert.equal(recovery.latest.acwr_readiness_factor_score, 86);
  assert.equal(recovery.avg_14d.acwr_ratio, 1.21);
});

test('training load uses a 365-day warm-up', async () => {
  let params;
  await sectionTrainingLoad({ all: async (_sql, values) => { params = values; return []; } },
    '2026-10-14');
  assert.deepEqual(params, ['2025-10-15', '2026-10-14']);
});

test('routine and rest focus entries carry weekdays', async () => {
  const restDb = {
    all: async () => [],
    get: async (sql) => sql.includes('SELECT routines_json') ? { routines_json: [] } : undefined,
  };
  assert.equal((await buildDayFocus(restDb, '2026-10-18')).day, 'Sun');

  const routineDb = {
    all: async () => [],
    get: async (sql) => sql.includes('SELECT routines_json')
      ? { routines_json: [{ activity: 'Football', day: 'Sun', intensity: 8 }] }
      : undefined,
  };
  const routine = await buildDayFocus(routineDb, '2026-10-18');
  assert.equal(routine.kind, 'routine');
  assert.equal(routine.day, 'Sun');
});

test('context is byte-stable across two builds on the same day', async () => {
  const db = {
    get: async (sql) => {
      if (sql.includes('FROM profile')) return {};
      return undefined;
    },
    all: async (sql) => {
      if (sql.includes("note_type = 'memory'")) return [];
      if (sql.includes('FROM recovery')) return [];
      if (sql.includes('FROM planned_workouts')) return [];
      if (sql.includes('FROM personal_records')) return [];
      if (sql.includes('FROM race_predictions')) return [];
      if (sql.includes('date_trunc')) return [];
      if (sql.includes('activity_training_load AS load')) return [];
      if (sql.includes('FROM activities')) return [];
      return [];
    },
  };
  const first = JSON.stringify(await buildContext(db));
  const second = JSON.stringify(await buildContext(db));
  assert.equal(second, first);
  assert.match(JSON.parse(first).today_day, /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
});
