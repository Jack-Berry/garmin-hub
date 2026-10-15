const { computeTrainingLoad } = require('./training-load');
const { resolveGoalPaces } = require('./goalpaces');

const DAY_MS = 86400000;
const shiftDate = (value, days) => {
  const date = new Date(`${value}T00:00:00Z`);
  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10);
};

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
  const calculated = computeTrainingLoad(loadRows, today, days, { warmupDays: 365 }).series;
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
