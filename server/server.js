// Garmin Hub — read-only Express API over data/garmin.db.
const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

// Separate writable connection, used ONLY by the race-override endpoint below.
// The read-only db (db.js) cannot write; writes here are scoped to a single
// column (is_race_override) so they can never clobber ingest data.
const writeDb = new Database(path.resolve(__dirname, '..', 'data', 'garmin.db'));

// JSON body parsing + minimal CORS for the local dashboard (single-user app).
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Curated column lists, derived once from the schema (everything but raw_json).
const cols = (table) =>
  db.prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)
    .filter((n) => n !== 'raw_json');

const ACTIVITY_COLS = cols('activities');
const LAP_COLS = cols('laps');

// Wrap a handler so any thrown/SQLite error becomes a 500 with a message.
const handler = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.get('/api/health', (req, res) => res.json({ ok: true }));

// List activities, most recent first. ?limit (default 30), ?from, ?to on date.
app.get('/api/activities', handler((req, res) => {
  const limit = Number(req.query.limit) || 30;
  const where = [];
  const params = {};
  if (req.query.from) { where.push('start_time_local >= :from'); params.from = req.query.from; }
  if (req.query.to) { where.push('start_time_local <= :to'); params.to = req.query.to; }
  if (req.query.group) { where.push('activity_group = :group'); params.group = req.query.group; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT ${ACTIVITY_COLS.join(', ')} FROM activities
     ${clause} ORDER BY start_time_local DESC LIMIT :limit`
  ).all({ ...params, limit });
  res.json(rows);
}));

// Single activity with its laps. ?raw=1 includes raw_json.
app.get('/api/activities/:id', handler((req, res) => {
  const id = Number(req.params.id);
  const includeRaw = req.query.raw === '1';
  const select = includeRaw ? '*' : ACTIVITY_COLS.join(', ');
  const activity = db.prepare(
    `SELECT ${select} FROM activities WHERE activity_id = ?`
  ).get(id);
  if (!activity) return res.status(404).json({ error: 'activity not found' });
  const lapSelect = includeRaw ? '*' : LAP_COLS.join(', ');
  const laps = db.prepare(
    `SELECT ${lapSelect} FROM laps WHERE activity_id = ? ORDER BY lap_index`
  ).all(id);
  res.json({ ...activity, laps });
}));

// Planned workouts ordered by date, with derived is_race and parsed steps.
app.get('/api/planned', handler((req, res) => {
  const where = [];
  const params = {};
  if (req.query.from) { where.push('calendar_date >= :from'); params.from = req.query.from; }
  if (req.query.to) { where.push('calendar_date <= :to'); params.to = req.query.to; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT schedule_id, workout_id, calendar_date, title, sport_type,
            is_race_auto, is_race_override,
            COALESCE(is_race_override, is_race_auto) AS is_race,
            estimated_distance_m, estimated_duration_s, steps_json
     FROM planned_workouts ${clause} ORDER BY calendar_date`
  ).all(params);
  const out = rows.map((r) => {
    const { steps_json, ...rest } = r;
    return { ...rest, steps: steps_json ? JSON.parse(steps_json) : null };
  });
  res.json(out);
}));

// Recovery rows, newest first. ?limit (default 30), ?from, ?to on date.
app.get('/api/recovery', handler((req, res) => {
  const limit = Number(req.query.limit) || 30;
  const where = [];
  const params = {};
  if (req.query.from) { where.push('calendar_date >= :from'); params.from = req.query.from; }
  if (req.query.to) { where.push('calendar_date <= :to'); params.to = req.query.to; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT * FROM recovery ${clause} ORDER BY calendar_date DESC LIMIT :limit`
  ).all({ ...params, limit });
  res.json(rows.map(({ raw_json, ...rest }) => rest));
}));

// Weekly mileage aggregate: totals per ISO week (Monday start), last ~12 weeks.
app.get('/api/summary/weekly', handler((req, res) => {
  // Runs only by default so mileage/pace aren't polluted by walks/football.
  // ?group= overrides the bucket (e.g. walk); defaults to 'run'.
  const group = req.query.group || 'run';
  const weekStart =
    "date(start_time_local, '-' || ((strftime('%w', start_time_local) + 6) % 7) || ' days')";
  const rows = db.prepare(
    `SELECT ${weekStart} AS week_start,
            COUNT(*) AS run_count,
            SUM(distance_m) AS total_distance_m,
            SUM(duration_s) AS total_duration_s,
            SUM(duration_s) / (SUM(distance_m) / 1000.0) AS avg_pace_s_per_km
     FROM activities
     WHERE start_time_local IS NOT NULL AND distance_m > 0 AND activity_group = :group
     GROUP BY week_start
     ORDER BY week_start DESC
     LIMIT 12`
  ).all({ group });
  res.json(rows);
}));

// Set/clear the manual race override for a planned workout. Body: { override }
// where override is 1 (force race), 0 (force not-race), or null (revert to
// auto detection). Writes ONLY is_race_override — never any other column.
app.post('/api/planned/:schedule_id/race-override', handler((req, res) => {
  const scheduleId = Number(req.params.schedule_id);
  const { override } = req.body || {};
  if (![0, 1, null].includes(override)) {
    return res.status(400).json({ error: 'override must be 0, 1, or null' });
  }
  const result = writeDb
    .prepare('UPDATE planned_workouts SET is_race_override = ? WHERE schedule_id = ?')
    .run(override, scheduleId);
  if (result.changes === 0) {
    return res.status(404).json({ error: 'planned workout not found' });
  }
  res.json({ schedule_id: scheduleId, is_race_override: override });
}));

app.listen(PORT, () => console.log(`Garmin Hub API listening on port ${PORT}`));
