const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_BATCH, healthActivityId, mapActivityType, syncWorkouts, validateBatch,
} = require('./health-workouts');

const workout = (overrides = {}) => ({
  uuid: '9FB87B4D-5D91-4A36-97C6-9698FBC92F90', activityType: 37,
  start: '2026-11-13T07:00:00Z', end: '2026-11-13T07:25:00Z', duration: 1500,
  distance: 5000, energy: 320, averageHR: 150, maxHR: 172,
  routeStart: { latitude: 51.5, longitude: -0.1 },
  splits: [
    { distance: 1000, duration: 300, averageHR: 145, averageSpeed: 3.333 },
    { distance: 1000, duration: 295, averageHR: 151, averageSpeed: 3.39 },
  ], ...overrides,
});

function memoryStore({ overlap = false } = {}) {
  const activities = new Map();
  const laps = new Map();
  let pendingId;
  const runner = { run: async (sql, params) => {
    if (sql.startsWith('INSERT INTO activities')) {
      pendingId = params[0];
      activities.set(pendingId, { id: pendingId, source: 'apple_health', raw: JSON.parse(params[14]) });
      return { rowCount: 1, rows: [{ activity_id: pendingId }] };
    }
    if (sql.startsWith('DELETE FROM laps')) { laps.delete(params[0]); return { rowCount: 1, rows: [] }; }
    const rows = JSON.parse(params[1]);
    laps.set(params[0], rows);
    return { rowCount: rows.length, rows: [] };
  } };
  return {
    activities, laps,
    db: { get: async () => overlap ? { activity_id: '123' } : undefined },
    writeDb: { transaction: async (work) => work(runner) },
  };
}

test('payload validation rejects malformed and oversized batches', () => {
  assert.match(validateBatch({}).error, /array/);
  assert.match(validateBatch({ workouts: Array(MAX_BATCH + 1).fill(workout()) }).error, /capped/);
  assert.match(validateBatch({ workouts: [workout({ splits: [{ distance: 0, duration: 1, averageSpeed: 1 }] })] }).error, /positive/);
  assert.match(validateBatch({ workouts: [workout({ activityType: '37' })] }).error, /activityType/);
  assert.deepEqual(validateBatch({ workouts: [workout()] }).workouts.length, 1);
});

test('HealthKit activity types map to readable groups', () => {
  assert.deepEqual(mapActivityType(37), { activityType: 'running', activityGroup: 'run' });
  assert.deepEqual(mapActivityType(52), { activityType: 'walking', activityGroup: 'walk' });
  assert.deepEqual(mapActivityType(24), { activityType: 'hiking', activityGroup: 'walk' });
  assert.deepEqual(mapActivityType(41), { activityType: 'soccer', activityGroup: 'football' });
  assert.deepEqual(mapActivityType(99), { activityType: 'healthkit_99', activityGroup: 'other' });
});

test('UUID hash is stable, negative and bounded to 60 bits', () => {
  const first = healthActivityId(workout().uuid);
  assert.equal(first, healthActivityId(workout().uuid.toLowerCase()));
  assert.match(first, /^-[1-9]\d*$/);
  assert.ok(-BigInt(first) < (1n << 60n));
});

test('re-post replaces laps and does not duplicate the activity', async () => {
  const store = memoryStore();
  await syncWorkouts(store, [workout()]);
  await syncWorkouts(store, [workout({ splits: [workout().splits[0]] })]);
  assert.equal(store.activities.size, 1);
  assert.equal(store.laps.size, 1);
  assert.equal([...store.laps.values()][0].length, 1);
});

test('Garmin overlap skips without writing', async () => {
  const store = memoryStore({ overlap: true });
  const result = await syncWorkouts(store, [workout()]);
  assert.equal(result.imported.length, 0);
  assert.deepEqual(result.skipped, [{
    uuid: workout().uuid, reason: 'garmin_overlap', garmin_activity_id: '123',
  }]);
  assert.equal(store.activities.size, 0);
});

test('lap rows are written and reported', async () => {
  const store = memoryStore();
  const result = await syncWorkouts(store, [workout()]);
  assert.equal(result.imported[0].laps, 2);
  assert.deepEqual([...store.laps.values()][0].map((lap) => lap.lap_index), [1, 2]);
});

test('activity and lap replacement use one transaction', async () => {
  let transactions = 0;
  const statements = [];
  const store = memoryStore();
  store.writeDb.transaction = async (work) => {
    transactions += 1;
    return work({ run: async (sql, params) => {
      statements.push(sql);
      if (sql.startsWith('INSERT INTO activities')) return { rowCount: 1, rows: [{}] };
      if (sql.startsWith('INSERT INTO laps')) return { rowCount: JSON.parse(params[1]).length, rows: [] };
      return { rowCount: 1, rows: [] };
    } });
  };
  await syncWorkouts(store, [workout()]);
  assert.equal(transactions, 1);
  assert.equal(statements.length, 3);
  assert.match(statements[0], /^INSERT INTO activities/);
  assert.match(statements[0], /WHERE activities\.source = 'apple_health'/);
  assert.match(statements[1], /^DELETE FROM laps/);
  assert.match(statements[2], /^INSERT INTO laps/);
});

test('schema source and id sign guard keeps ingest away from Apple rows', () => {
  const schema = fs.readFileSync(path.resolve(__dirname, '..', 'db', 'schema.pg.sql'), 'utf8');
  const migration = fs.readFileSync(path.resolve(__dirname, '..', 'db', 'migrate_apple_health_activities.sql'), 'utf8');
  for (const sql of [schema, migration]) {
    assert.match(sql, /source = 'garmin' AND activity_id > 0/);
    assert.match(sql, /source = 'apple_health' AND activity_id < 0/);
  }
});
