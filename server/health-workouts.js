const crypto = require('crypto');

const MAX_BATCH = 50;
const MAX_SPLITS = 500;
const ACTIVITY_TYPES = new Map([
  [24, ['hiking', 'walk']],
  [37, ['running', 'run']],
  [41, ['soccer', 'football']],
  [52, ['walking', 'walk']],
]);

const finite = (value) => value == null || (typeof value === 'number' && Number.isFinite(value));
const nonNegative = (value) => finite(value) && (value == null || value >= 0);
const isoDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

function healthActivityId(uuid) {
  const digest = crypto.createHash('sha1').update(uuid.toLowerCase()).digest('hex').slice(0, 15);
  const value = BigInt(`0x${digest}`) || 1n;
  return String(-value);
}

function mapActivityType(value) {
  const numeric = Number(value);
  if (ACTIVITY_TYPES.has(numeric)) {
    const [activityType, activityGroup] = ACTIVITY_TYPES.get(numeric);
    return { activityType, activityGroup };
  }
  return { activityType: `healthkit_${Number.isInteger(numeric) ? numeric : 'other'}`, activityGroup: 'other' };
}

function validateWorkout(workout, index) {
  const prefix = `workouts[${index}]`;
  if (!workout || typeof workout !== 'object' || Array.isArray(workout)) return `${prefix} must be an object`;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workout.uuid || '')) return `${prefix}.uuid is invalid`;
  if (typeof workout.activityType !== 'number' || !Number.isInteger(workout.activityType)) return `${prefix}.activityType is invalid`;
  if (!isoDate(workout.start) || !isoDate(workout.end) || Date.parse(workout.end) <= Date.parse(workout.start)) return `${prefix} has an invalid time window`;
  for (const field of ['duration', 'distance', 'energy', 'averageHR', 'maxHR']) {
    if (!nonNegative(workout[field])) return `${prefix}.${field} must be a non-negative finite number or null`;
  }
  if (!Array.isArray(workout.splits) || workout.splits.length > MAX_SPLITS) return `${prefix}.splits is invalid`;
  if (workout.routeStart != null && (
    typeof workout.routeStart !== 'object' || !finite(workout.routeStart.latitude)
    || !finite(workout.routeStart.longitude) || Math.abs(workout.routeStart.latitude) > 90
    || Math.abs(workout.routeStart.longitude) > 180
  )) return `${prefix}.routeStart is invalid`;
  for (let splitIndex = 0; splitIndex < workout.splits.length; splitIndex++) {
    const split = workout.splits[splitIndex];
    if (!split || typeof split !== 'object') return `${prefix}.splits[${splitIndex}] is invalid`;
    for (const field of ['distance', 'duration', 'averageHR', 'averageSpeed']) {
      if (!nonNegative(split[field])) return `${prefix}.splits[${splitIndex}].${field} is invalid`;
    }
    if (!(split.distance > 0) || !(split.duration > 0) || !(split.averageSpeed > 0)) return `${prefix}.splits[${splitIndex}] must have positive distance, duration and speed`;
  }
  return null;
}

function validateBatch(body) {
  if (!body || !Array.isArray(body.workouts)) return { error: 'workouts must be an array' };
  if (body.workouts.length > MAX_BATCH) return { error: `workouts is capped at ${MAX_BATCH}` };
  for (let index = 0; index < body.workouts.length; index++) {
    const error = validateWorkout(body.workouts[index], index);
    if (error) return { error };
  }
  return { workouts: body.workouts };
}

const overlapSql = `SELECT activity_id::text AS activity_id FROM activities
  WHERE source = 'garmin'
    AND activity_windows_overlap(
      start_time_local, duration_s,
      $1::timestamptz AT TIME ZONE 'Europe/London',
      $2::timestamptz AT TIME ZONE 'Europe/London')
  LIMIT 1`;

const upsertSql = `INSERT INTO activities (
    activity_id, source, name, start_time_local, activity_type, activity_group,
    distance_m, duration_s, moving_duration_s, elapsed_duration_s, avg_speed_mps,
    calories, lap_count, avg_hr, max_hr, start_lat, start_lng, raw_json
  ) VALUES (
    $1::bigint, 'apple_health', $2, $3::timestamptz AT TIME ZONE 'Europe/London', $4, $5,
    $6, $7, $7, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb
  )
  ON CONFLICT (activity_id) DO UPDATE SET
    name = EXCLUDED.name, start_time_local = EXCLUDED.start_time_local,
    activity_type = EXCLUDED.activity_type, activity_group = EXCLUDED.activity_group,
    distance_m = EXCLUDED.distance_m, duration_s = EXCLUDED.duration_s,
    moving_duration_s = EXCLUDED.moving_duration_s,
    elapsed_duration_s = EXCLUDED.elapsed_duration_s, avg_speed_mps = EXCLUDED.avg_speed_mps,
    calories = EXCLUDED.calories, lap_count = EXCLUDED.lap_count,
    avg_hr = EXCLUDED.avg_hr, max_hr = EXCLUDED.max_hr,
    start_lat = EXCLUDED.start_lat, start_lng = EXCLUDED.start_lng, raw_json = EXCLUDED.raw_json
  WHERE activities.source = 'apple_health'
  RETURNING activity_id`;

const insertLapsSql = `INSERT INTO laps (
    activity_id, lap_index, distance_m, duration_s, moving_duration_s,
    avg_speed_mps, avg_hr, intensity_type, raw_json)
  SELECT $1::bigint, split.lap_index, split.distance_m, split.duration_s,
         split.duration_s, split.average_speed, split.average_hr, 'ACTIVE', split.raw_json
  FROM jsonb_to_recordset($2::jsonb) AS split(
    lap_index integer, distance_m double precision, duration_s double precision,
    average_speed double precision, average_hr double precision, raw_json jsonb)`;

async function syncWorkouts({ db, writeDb }, workouts) {
  const result = { imported: [], skipped: [] };
  for (const workout of workouts) {
    const activityId = healthActivityId(workout.uuid);
    const overlap = await db.get(overlapSql, [workout.start, workout.end]);
    if (overlap) {
      result.skipped.push({ uuid: workout.uuid, reason: 'garmin_overlap', garmin_activity_id: String(overlap.activity_id) });
      continue;
    }
    const mapped = mapActivityType(workout.activityType);
    const distance = workout.distance ?? null;
    const duration = workout.duration ?? ((Date.parse(workout.end) - Date.parse(workout.start)) / 1000);
    const splits = workout.splits.map((split, index) => ({
      lap_index: index + 1,
      distance_m: split.distance,
      duration_s: split.duration,
      average_speed: split.averageSpeed,
      average_hr: split.averageHR ?? null,
      raw_json: split,
    }));
    const values = [
      activityId, `Apple Watch ${mapped.activityType.replace(/_/g, ' ')}`, workout.start,
      mapped.activityType, mapped.activityGroup, distance, duration,
      distance > 0 && duration > 0 ? distance / duration : null,
      workout.energy ?? null, splits.length, workout.averageHR ?? null, workout.maxHR ?? null,
      workout.routeStart?.latitude ?? null, workout.routeStart?.longitude ?? null,
      JSON.stringify(workout), JSON.stringify(splits),
    ];
    const lapCount = await writeDb.transaction(async (tx) => {
      const written = await tx.run(upsertSql, values.slice(0, 15));
      if (!written.rowCount) throw new Error('activity id belongs to another source');
      await tx.run('DELETE FROM laps WHERE activity_id = $1::bigint', [activityId]);
      return (await tx.run(insertLapsSql, [activityId, JSON.stringify(splits)])).rowCount;
    });
    result.imported.push({ uuid: workout.uuid, activity_id: activityId, laps: lapCount });
  }
  return result;
}

function createHealthWorkoutsRouter({ db, writeDb }) {
  const express = require('express');
  const router = express.Router();
  router.post('/health/workouts', async (req, res) => {
    const validated = validateBatch(req.body);
    if (validated.error) return res.status(400).json({ error: validated.error });
    try {
      const result = await syncWorkouts({ db, writeDb }, validated.workouts);
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  return router;
}

module.exports = {
  MAX_BATCH, createHealthWorkoutsRouter, healthActivityId, mapActivityType,
  syncWorkouts, validateBatch,
};
