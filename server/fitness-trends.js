const { computeTrainingLoad } = require('./training-load');
const { resolveGoalPaces } = require('./goalpaces');
const { localDate, shiftDate } = require('./context');

const DAY_MS = 86400000;
const clampDays = (value, fallback = 120) => Math.min(366, Math.max(1, Math.floor(Number(value) || fallback)));

const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const fmtDuration = (seconds) => {
  if (seconds == null || !Number.isFinite(Number(seconds))) return null;
  const s = Math.round(Number(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
};

function buildFitnessSeries(rows, today, days = 120) {
  const loadRows = (rows || []).filter((row) => row?.date && row.load != null);
  if (!loadRows.length) return [];
  const firstData = loadRows.reduce((min, row) => (row.date < min ? row.date : min), loadRows[0].date);
  const windowStart = shiftDate(today, -(days - 1));
  const start = firstData > windowStart ? firstData : windowStart;
  const calculated = computeTrainingLoad(loadRows, today, days, { warmupDays: 365, includeSeries: true }).series;
  return calculated.filter((row) => row.date >= start);
}

const predictionFields = [
  ['5k', 'time_5k_s'],
  ['10k', 'time_10k_s'],
  ['half', 'time_half_s'],
  ['marathon', 'time_marathon_s'],
];

function buildPredictionHistory(rows, days = 120) {
  return (rows || []).slice(-days).map((row) => ({
    date: row.calendar_date,
    ...Object.fromEntries(predictionFields.map(([key, field]) => [key, row[field] == null ? null : Number(row[field])])),
  }));
}

function nextRace(races, records, predictions, today) {
  const resolved = resolveGoalPaces(races, records)
    .filter((race) => validDate(race.date) && race.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const race = resolved[0];
  if (!race) return null;
  const daysToGo = Math.round((new Date(`${race.date}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / DAY_MS);
  const key = race.distance?.key;
  const field = predictionFields.find(([candidate]) => candidate === key)?.[1];
  const latest = predictions?.[0];
  const predictionSeconds = field && latest ? latest[field] : null;
  return {
    name: race.name,
    date: race.date,
    days_to_go: daysToGo,
    distance: key || null,
    goal: race.goalTimeSec == null ? null : {
      seconds: race.goalTimeSec,
      display: fmtDuration(race.goalTimeSec),
      pace: race.goalPace?.pace || null,
    },
    prediction: predictionSeconds == null ? null : {
      seconds: Number(predictionSeconds),
      display: fmtDuration(predictionSeconds),
      as_of: latest.calendar_date,
    },
  };
}

module.exports = { buildFitnessSeries, buildPredictionHistory, nextRace, fmtDuration, validDate };

function createFitnessRouter({ db }) {
  const express = require('express');
  const router = express.Router();
  const handler = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (error) { res.status(500).json({ error: error.message }); }
  };

  router.get('/fitness', handler(async (req, res) => {
    const days = clampDays(req.query.days);
    const today = localDate();
    const from = shiftDate(today, -(days + 365 - 1));
    const rows = await db.all(
      `SELECT start_time_local::date AS date, SUM(activity_training_load) AS load
       FROM activities
       WHERE activity_training_load IS NOT NULL
         AND start_time_local::date >= $1 AND start_time_local::date <= $2
       GROUP BY start_time_local::date ORDER BY date`, [from, today]);
    res.json({ days, method: 'derived from Garmin training load', series: buildFitnessSeries(rows, today, days) });
  }));

  router.get('/race-predictions/history', handler(async (req, res) => {
    const days = clampDays(req.query.days, 180);
    const today = localDate();
    const from = shiftDate(today, -(days - 1));
    const rows = await db.all(
      `SELECT calendar_date, time_5k_s, time_10k_s, time_half_s, time_marathon_s
       FROM race_predictions WHERE calendar_date >= $1 AND calendar_date <= $2
       ORDER BY calendar_date`, [from, today]);
    res.json({ days, series: buildPredictionHistory(rows, days) });
  }));

  router.get('/race-countdown', handler(async (req, res) => {
    const today = localDate();
    const profile = await db.get('SELECT races_json FROM profile WHERE id = 1');
    const records = await db.all('SELECT label, value, value_kind FROM personal_records');
    const predictions = await db.all(
      `SELECT calendar_date, time_5k_s, time_10k_s, time_half_s, time_marathon_s
       FROM race_predictions ORDER BY calendar_date DESC LIMIT 1`);
    res.json(nextRace(Array.isArray(profile?.races_json) ? profile.races_json : [], records, predictions, today));
  }));
  return router;
}

module.exports.createFitnessRouter = createFitnessRouter;
module.exports.clampDays = clampDays;
