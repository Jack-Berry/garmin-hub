// Garmin Hub — read-only Express API over data/garmin.db.
const path = require('path');
// Load server/.env (holds ANTHROPIC_API_KEY) before requiring the coach client.
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { spawn } = require('child_process');
const express = require('express');
const Database = require('better-sqlite3');
const db = require('./db');
const { buildContext, renderContextDump } = require('./context');
const { collapseRaceDuplicates } = require('./planned');
const { generateBrief, generateDetailedReport, generateDayInsight, chatReply, planReply } = require('./coach');
const { pacerChat } = require('./pacer');

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

// Async variant for handlers that await (e.g. the Claude call).
const asyncHandler = (fn) => async (req, res) => {
  try {
    await fn(req, res);
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
  // Collapse same-day race triplicates (Runna race + manual override + pacer)
  // into one row before shaping; the survivor carries a pacer_available flag.
  const out = collapseRaceDuplicates(rows).map((r) => {
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

// Training Balance snapshot — parsed from the latest recovery.raw_json's
// `training_status` block (Garmin Load Focus + training status + ACWR/load
// ratio). This is a current snapshot (~last 4 weeks of load), so it's a
// separate route from the recovery time-series rather than a per-day column.
// The frontend never sees raw_json. The deviceId is a dynamic map key, so we
// grab the first/only entry rather than hardcoding it.
app.get('/api/training-balance', handler((req, res) => {
  const row = db.prepare(
    `SELECT calendar_date, raw_json FROM recovery
     WHERE raw_json IS NOT NULL ORDER BY calendar_date DESC LIMIT 1`
  ).get();
  const ts = row && JSON.parse(row.raw_json).training_status;
  const first = (m) => (m ? Object.values(m)[0] : null);

  const lb = first(ts?.mostRecentTrainingLoadBalance?.metricsTrainingLoadBalanceDTOMap);
  const st = first(ts?.mostRecentTrainingStatus?.latestTrainingStatusData);
  if (!lb && !st) return res.json(null);

  const bar = (key, label, value, min, max) => ({
    key,
    label,
    value: value != null ? Math.round(value) : null,
    target_min: min ?? null,
    target_max: max ?? null,
  });
  const acwr = st?.acuteTrainingLoadDTO;

  res.json({
    date: row.calendar_date,
    load_focus: lb ? {
      feedback: lb.trainingBalanceFeedbackPhrase || null,
      bars: [
        bar('low_aerobic', 'Low Aerobic', lb.monthlyLoadAerobicLow, lb.monthlyLoadAerobicLowTargetMin, lb.monthlyLoadAerobicLowTargetMax),
        bar('high_aerobic', 'High Aerobic', lb.monthlyLoadAerobicHigh, lb.monthlyLoadAerobicHighTargetMin, lb.monthlyLoadAerobicHighTargetMax),
        bar('anaerobic', 'Anaerobic', lb.monthlyLoadAnaerobic, lb.monthlyLoadAnaerobicTargetMin, lb.monthlyLoadAnaerobicTargetMax),
      ],
    } : null,
    training_status: st ? { phrase: st.trainingStatusFeedbackPhrase || null, code: st.trainingStatus ?? null } : null,
    acwr: acwr ? { ratio: acwr.dailyAcuteChronicWorkloadRatio ?? null, status: acwr.acwrStatus || null } : null,
  });
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

// seconds -> "M:SS" or "H:MM:SS" (for PR / prediction times).
const fmtDuration = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
};

// Garmin-sourced personal records (read-only), one per record type, with a
// display string (time formatted, or distance in km) for the frontend.
app.get('/api/personal-records', handler((req, res) => {
  const rows = db.prepare(
    `SELECT type_id, label, value, value_kind, activity_id, record_date
     FROM personal_records ORDER BY type_id`
  ).all();
  res.json(rows.map((r) => ({
    ...r,
    value_display: r.value_kind === 'distance'
      ? `${(r.value / 1000).toFixed(2)} km`
      : fmtDuration(r.value),
  })));
}));

// Current (most recent) Garmin race predictions, times formatted.
app.get('/api/race-predictions', handler((req, res) => {
  const row = db.prepare(
    `SELECT calendar_date, time_5k_s, time_10k_s, time_half_s, time_marathon_s, fetched_at
     FROM race_predictions ORDER BY calendar_date DESC LIMIT 1`
  ).get();
  if (!row) return res.json(null);
  const pred = (label, seconds) => ({ label, seconds, display: fmtDuration(seconds) });
  res.json({
    calendar_date: row.calendar_date,
    fetched_at: row.fetched_at,
    predictions: [
      pred('5K', row.time_5k_s),
      pred('10K', row.time_10k_s),
      pred('Half Marathon', row.time_half_s),
      pred('Marathon', row.time_marathon_s),
    ],
  });
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

// Coaching profile (single row). Shoes/races/injuries are growable lists
// stored as JSON; general_notes is plain text. GET returns parsed arrays;
// POST stores them via the writable connection (same pattern as race-override).
const parseList = (s) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };

const readProfile = () => {
  const row = db.prepare(
    'SELECT shoes_json, races_json, injuries_json, routines_json, general_notes, updated_at FROM profile WHERE id = 1'
  ).get() || {};
  return {
    shoes: parseList(row.shoes_json),
    races: parseList(row.races_json),
    injuries: parseList(row.injuries_json),
    routines: parseList(row.routines_json),
    general_notes: row.general_notes || '',
    updated_at: row.updated_at || null,
  };
};

app.get('/api/profile', handler((req, res) => {
  res.json(readProfile());
}));

app.post('/api/profile', handler((req, res) => {
  const b = req.body || {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  writeDb.prepare(
    `UPDATE profile SET shoes_json = :shoes, races_json = :races,
       injuries_json = :injuries, routines_json = :routines,
       general_notes = :notes, updated_at = :updated_at
     WHERE id = 1`
  ).run({
    shoes: JSON.stringify(arr(b.shoes)),
    races: JSON.stringify(arr(b.races)),
    injuries: JSON.stringify(arr(b.injuries)),
    routines: JSON.stringify(arr(b.routines)),
    notes: b.general_notes || '',
    updated_at: new Date().toISOString(),
  });
  res.json(readProfile());
}));

// Assembled coaching context — the compact structured summary the AI coach
// will consume. Inspect this to gauge shape/token-weight before wiring a model.
app.get('/api/coach/context', handler((req, res) => {
  res.json(buildContext(db));
}));

// Copy-context dump — the full coaching context rendered as a readable text
// block with a priming prompt on top, ready to paste into an external LLM chat
// for a longer conversation than the in-app widget is meant for. Read-only.
app.get('/api/coach/context-dump', handler((req, res) => {
  res.json({ dump: renderContextDump(db) });
}));

// Generate a fresh daily glance brief (Sonnet, cheap), store it in coach_notes
// as a 'daily' note, and return it. Write — uses the writable connection. The
// dashboard's brief carousel reads these; the deeper report is on-demand below.
app.post('/api/coach/daily', asyncHandler(async (req, res) => {
  const { text, context, model } = await generateBrief(db);
  const createdAt = new Date().toISOString();
  const end = createdAt.slice(0, 10);
  const start = new Date(Date.now() - context.window_days * 86400000)
    .toISOString().slice(0, 10);
  const result = writeDb.prepare(
    `INSERT INTO coach_notes
       (created_at, note_type, content, model, date_range_start, date_range_end)
     VALUES (?, 'daily', ?, ?, ?, ?)`
  ).run(createdAt, text, model, start, end);
  res.json({
    id: result.lastInsertRowid,
    created_at: createdAt,
    note_type: 'daily',
    content: text,
    model,
    date_range_start: start,
    date_range_end: end,
  });
}));

// On-demand detailed report (Opus). The depth tier behind the daily brief,
// generated ONLY when the user clicks "Detailed report". Stateless — not
// persisted. Returns { content, model }.
app.post('/api/coach/report', asyncHandler(async (req, res) => {
  const { text, model } = await generateDetailedReport(db);
  res.json({ content: text, model });
}));

// On-demand per-day insight (Sonnet) for a clicked week-strip cell. Branches on
// the date's state: completed run -> how it went, planned-only -> execution
// tips, rest -> a static line (no model call). Stateless. Returns
// { content, kind, model }.
app.post('/api/coach/day/:date', asyncHandler(async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  const { text, kind, model } = await generateDayInsight(db, date);
  res.json({ content: text, kind, model });
}));

// Interactive chat with the coach (spends Sonnet credit). Body: { messages }
// — the full conversation so far ([{role, content}, ...]). Stateless: nothing
// is persisted. Returns { reply } with the assistant's text.
app.post('/api/coach/chat', asyncHandler(async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }
  const reply = await chatReply(db, messages);
  res.json({ reply });
}));

// Planning-mode coach turn (Opus, Stage 8). Body: { messages } — the full
// conversation so far. Returns { reply, spec } — spec is the extracted session
// spec object when the coach presents one, else null. This endpoint COMPOSES
// only; preview/push go through /api/pacer/preview and /api/pacer/push (which
// take the spec object as-is and run the guard). Stateless: nothing persisted.
app.post('/api/coach/plan', asyncHandler(async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }
  const { reply, spec, done } = await planReply(db, messages);
  res.json({ reply, spec, done });
}));

// Recent coach notes, newest first. ?limit (default 10), ?note_type filters
// to one kind (e.g. 'daily' for the dashboard hero carousel).
app.get('/api/coach/notes', handler((req, res) => {
  const limit = Number(req.query.limit) || 10;
  const { note_type } = req.query;
  const rows = db.prepare(
    `SELECT id, created_at, note_type, content, model, date_range_start, date_range_end
     FROM coach_notes
     WHERE (:note_type IS NULL OR note_type = :note_type)
     ORDER BY id DESC LIMIT :limit`
  ).all({ limit, note_type: note_type || null });
  res.json(rows);
}));

// Manually trigger the Python ingest (e.g. right after a run) instead of
// waiting for the daily cron. Spawns ingest.py and waits for it to finish.
// Interpreter is configurable via INGEST_PYTHON (the Pi differs from this Mac);
// the script path is resolved relative to the repo root.
const INGEST_PYTHON = process.env.INGEST_PYTHON || '/usr/local/bin/python3.13';
const INGEST_SCRIPT = path.resolve(__dirname, '..', 'ingest', 'ingest.py');
const INGEST_TIMEOUT_MS = 120000;
// In-process lock: single-user app, so a boolean is enough to stop a second
// ingest spawning while one is in flight (manual click or a future cron tick).
let ingestRunning = false;

app.post('/api/ingest/refresh', (req, res) => {
  if (ingestRunning) {
    return res.status(409).json({ error: 'ingest already running' });
  }
  ingestRunning = true;

  const child = spawn(INGEST_PYTHON, [INGEST_SCRIPT], {
    cwd: path.resolve(__dirname, '..'),
  });

  let out = '';
  let settled = false;
  // Release the lock and respond exactly once, on whichever path fires first.
  const finish = (send) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ingestRunning = false;
    send();
  };

  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  // Guard against a hang — most likely the garth token expired and ingest is
  // blocked on an MFA prompt that can't be answered headless. Kill and hint.
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish(() => res.status(504).json({
      error: 'Ingest timed out — the Garmin token may have expired. Run the ingest manually in a terminal once to re-authenticate (MFA).',
    }));
  }, INGEST_TIMEOUT_MS);

  child.on('error', (err) => {
    finish(() => res.status(500).json({ error: `Failed to start ingest: ${err.message}` }));
  });

  child.on('close', (code) => {
    const tail = out.trim().split('\n').slice(-8).join('\n');
    if (code === 0) {
      finish(() => res.json({ ok: true, summary: tail }));
    } else {
      finish(() => res.status(500).json({
        error: `Ingest failed (exit ${code}). If it stalled on login, the Garmin token may have expired — run it manually in a terminal to re-authenticate (MFA).`,
        summary: tail,
      }));
    }
  });
});

// --- Pacer builder (Stage 5c) -------------------------------------------------
// Conversational param-gathering + deterministic build/push of Engo pacers.
// The AI (pacer.js) ONLY gathers params; the build + Garmin upload happen in
// pacer_cli.py, and ONLY /api/pacer/push writes to Garmin (after explicit
// preview approval in the UI). Reuses the ingest Python-spawn pattern.
const PACER_SCRIPT = path.resolve(__dirname, '..', 'ingest', 'pacer_cli.py');

// Run pacer_cli.py in the given mode, feeding params as JSON on stdin and
// resolving its parsed JSON stdout. Rejects with stderr on non-zero exit.
const runPacer = (mode, params, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(INGEST_PYTHON, [PACER_SCRIPT, mode], {
      cwd: path.resolve(__dirname, '..'),
    });
    let out = '';
    let err = '';
    child.stdin.write(JSON.stringify(params));
    child.stdin.end();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Pacer timed out — the Garmin token may have expired; re-authenticate in a terminal (MFA).'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Failed to start pacer: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error((err.trim().split('\n').pop() || `pacer exited ${code}`)));
      }
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error(`pacer returned unparseable output: ${out.slice(0, 200)}`)); }
    });
  });

// Conversational Q&A to gather pacer params (Sonnet). Body: { messages }.
// Returns { reply, params } — params is non-null once the Q&A is complete and
// the UI should move to a preview. Never pushes to Garmin.
app.post('/api/pacer/chat', asyncHandler(async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const { reply, params } = await pacerChat(messages, today);
  res.json({ reply, params });
}));

// Build (no network) and return a readable preview of the pacer. Body: params.
app.post('/api/pacer/preview', asyncHandler(async (req, res) => {
  res.json(await runPacer('preview', req.body || {}, 20000));
}));

// Build AND push to Garmin (upload + schedule). The ONLY endpoint that writes
// to Garmin — called only after the user approves the preview. Body: params.
app.post('/api/pacer/push', asyncHandler(async (req, res) => {
  res.json(await runPacer('push', req.body || {}, 120000));
}));

app.listen(PORT, () => console.log(`Garmin Hub API listening on port ${PORT}`));
