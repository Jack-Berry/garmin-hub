// Temperature plus dew point coaching rule, using the fixed slowdown values
// published at https://marathoncompass.com/tools/heat-pace. This is a practical
// estimate, not a physiological model. Inputs are converted to Fahrenheit
// before summing because the published thresholds use Fahrenheit.
const HEAT_BANDS = Object.freeze([
  [100, 0], [110, 0.005], [120, 0.01], [130, 0.02], [140, 0.03],
  [150, 0.045], [160, 0.06], [Infinity, 0.08],
]);

const cToF = (value) => value * 9 / 5 + 32;

function heatAdjustment(paceSecondsPerKm, temperatureC, dewPointC) {
  if (![paceSecondsPerKm, temperatureC, dewPointC].every(Number.isFinite) || paceSecondsPerKm <= 0) {
    return null;
  }
  const sumF = cToF(temperatureC) + cToF(dewPointC);
  const slowdown = HEAT_BANDS.find(([ceiling]) => sumF <= ceiling)[1];
  return {
    rule: 'Temperature plus dew point',
    estimate: true,
    temperature_dew_point_sum_f: Math.round(sumF),
    slowdown_pct: +(slowdown * 100).toFixed(1),
    cool_equivalent_pace_s_per_km: Math.round(paceSecondsPerKm / (1 + slowdown)),
  };
}

function addHeatAdjustment(activity) {
  const km = Number(activity.distance_m) / 1000;
  const pace = km > 0 ? Number(activity.duration_s) / km : NaN;
  const temperature = activity.temperature_c == null ? NaN : Number(activity.temperature_c);
  const dewPoint = activity.dew_point_c == null ? NaN : Number(activity.dew_point_c);
  return {
    ...activity,
    heat_adjustment: heatAdjustment(pace, temperature, dewPoint),
  };
}

const normalName = (value) => String(value || '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

async function listGear(db) {
  const [rows, profile] = await Promise.all([
    db.all(
      `SELECT g.gear_uuid, g.display_name, g.make_name, g.model_name, g.status,
              g.date_begin, g.retired, g.garmin_total_distance_m,
              COUNT(a.activity_id)::int AS runs,
              COALESCE(SUM(a.distance_m), 0) AS summed_run_distance_m,
              MIN(a.start_time_local::date) AS first_used,
              MAX(a.start_time_local::date) AS last_used
       FROM gear g LEFT JOIN activities a
         ON a.gear_uuid = g.gear_uuid AND a.activity_group = 'run'
       GROUP BY g.gear_uuid ORDER BY g.retired, g.display_name, g.gear_uuid`),
    db.get('SELECT shoes_json FROM profile WHERE id = 1'),
  ]);
  const shoes = Array.isArray(profile?.shoes_json) ? profile.shoes_json : [];
  return {
    match_method: 'Exact name match ignoring case, punctuation and repeated spaces. Garmin gear remains the mileage source of truth.',
    items: rows.map((row) => {
      const shoe = shoes.find((item) => normalName(item?.name) === normalName(row.display_name));
      const threshold = Number(shoe?.mileage_alert_km);
      const garminKm = Number(row.garmin_total_distance_m) / 1000;
      return {
        ...row,
        profile_shoe_name: shoe?.name || null,
        mileage_alert_km: Number.isFinite(threshold) && threshold > 0 ? threshold : null,
        mileage_alert: Number.isFinite(threshold) && threshold > 0 && garminKm >= threshold,
      };
    }),
  };
}

function createGearRouter({ db }) {
  const express = require('express');
  const router = express.Router();
  router.get('/', async (_req, res, next) => {
    try { res.json(await listGear(db)); } catch (error) { next(error); }
  });
  return router;
}

module.exports = { HEAT_BANDS, heatAdjustment, addHeatAdjustment, listGear, createGearRouter };
