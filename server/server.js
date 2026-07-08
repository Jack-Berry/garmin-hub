// Garmin Hub — Express API over the garminhub Postgres database.
const path = require('path');
const crypto = require('crypto');
// Load server/.env (ANTHROPIC_API_KEY, optional DATABASE_URL_RO/RW) before
// requiring the db pools and coach client.
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { spawn } = require('child_process');
const express = require('express');
const { db, writeDb } = require('./db');
const { buildContext, renderContextDump } = require('./context');
const { collapseRaceDuplicates, applyAppPlanPrecedence } = require('./planned');
const { generateBrief, generateDetailedReport, generateDayInsight, chatReply, planReply } = require('./coach');
const { pacerChat } = require('./pacer');

const app = express();
const PORT = process.env.PORT || 3001;

// Shared-secret auth: single-user app, so no login/sessions — every /api
// request must carry the secret in an X-Api-Key header (the frontend bakes it
// in at build time via VITE_API_SECRET). Fail fast if unconfigured: an
// unauthenticated API should never come up by accident.
const API_SECRET = process.env.API_SECRET;
if (!API_SECRET) {
  console.error('API_SECRET is not set (server/.env) — refusing to start unauthenticated.');
  process.exit(1);
}

// JSON body parsing + CORS pinned to the known frontend origins (no wildcard).
// The custom auth header makes browsers preflight every request, so OPTIONS is
// answered here, BEFORE the auth gate (preflights never carry custom headers).
const ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:4173,http://localhost:5173')
  .split(',').map((s) => s.trim());
app.use(express.json());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) res.header('Access-Control-Allow-Origin', origin);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// The one auth gate for every /api route. Kept as a single middleware so it's
// trivially replaceable if hosting brings its own auth (e.g. Cloudflare Access).
app.use('/api', (req, res, next) => {
  if (req.get('X-Api-Key') !== API_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// Curated column lists, derived once from the schema (everything but raw_json).
// Async, so they're awaited in start() below — routes never see them empty.
const cols = async (table) =>
  (await db.all(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`, [table]))
    .map((c) => c.column_name)
    .filter((n) => n !== 'raw_json');

let ACTIVITY_COLS = [];
let LAP_COLS = [];

// Wrap a handler so any thrown/rejected error becomes a 500 with a message.
const handler = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

app.get('/api/health', (req, res) => res.json({ ok: true }));

// List activities, most recent first. ?limit (default 30), ?from, ?to on date.
app.get('/api/activities', handler(async (req, res) => {
  const limit = Number(req.query.limit) || 30;
  const where = [];
  const params = [];
  if (req.query.from) { params.push(req.query.from); where.push(`start_time_local >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); where.push(`start_time_local <= $${params.length}`); }
  if (req.query.group) { params.push(req.query.group); where.push(`activity_group = $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);
  const rows = await db.all(
    `SELECT ${ACTIVITY_COLS.join(', ')} FROM activities
     ${clause} ORDER BY start_time_local DESC LIMIT $${params.length}`, params);
  res.json(rows);
}));

// Single activity with its laps. ?raw=1 includes raw_json.
app.get('/api/activities/:id', handler(async (req, res) => {
  const id = Number(req.params.id);
  const includeRaw = req.query.raw === '1';
  const select = includeRaw ? '*' : ACTIVITY_COLS.join(', ');
  const activity = await db.get(
    `SELECT ${select} FROM activities WHERE activity_id = $1`, [id]);
  if (!activity) return res.status(404).json({ error: 'activity not found' });
  const lapSelect = includeRaw ? '*' : LAP_COLS.join(', ');
  const laps = await db.all(
    `SELECT ${lapSelect} FROM laps WHERE activity_id = $1 ORDER BY lap_index`, [id]);
  res.json({ ...activity, laps });
}));

// Planned workouts ordered by date, with derived is_race and parsed steps.
app.get('/api/planned', handler(async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.from) { params.push(req.query.from); where.push(`calendar_date >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); where.push(`calendar_date <= $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await db.all(
    `SELECT schedule_id, workout_id, calendar_date, title, sport_type, source,
            is_race_auto, is_race_override,
            COALESCE(is_race_override, is_race_auto) AS is_race,
            estimated_distance_m, estimated_duration_s, steps_json
     FROM planned_workouts ${clause} ORDER BY calendar_date`, params);
  // App-plan precedence first (an app row owns its date — upcoming Runna/
  // Garmin rows on it are dropped), then collapse same-day race triplicates
  // (Runna race + manual override + pacer) into one row before shaping; the
  // survivor carries a pacer_available flag.
  // steps_json is jsonb — pg hands back the parsed array (or null) directly.
  const out = collapseRaceDuplicates(applyAppPlanPrecedence(rows)).map((r) => {
    const { steps_json, ...rest } = r;
    return { ...rest, steps: steps_json ?? null };
  });
  res.json(out);
}));

// Recovery rows, newest first. ?limit (default 30), ?from, ?to on date.
app.get('/api/recovery', handler(async (req, res) => {
  const limit = Number(req.query.limit) || 30;
  const where = [];
  const params = [];
  if (req.query.from) { params.push(req.query.from); where.push(`calendar_date >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); where.push(`calendar_date <= $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);
  const rows = await db.all(
    `SELECT * FROM recovery ${clause} ORDER BY calendar_date DESC LIMIT $${params.length}`,
    params);
  res.json(rows.map(({ raw_json, ...rest }) => rest));
}));

// Training Balance snapshot — parsed from the latest recovery.raw_json's
// `training_status` block (Garmin Load Focus + training status + ACWR/load
// ratio). This is a current snapshot (~last 4 weeks of load), so it's a
// separate route from the recovery time-series rather than a per-day column.
// The frontend never sees raw_json. The deviceId is a dynamic map key, so we
// grab the first/only entry rather than hardcoding it.
app.get('/api/training-balance', handler(async (req, res) => {
  const row = await db.get(
    `SELECT calendar_date, raw_json FROM recovery
     WHERE raw_json IS NOT NULL ORDER BY calendar_date DESC LIMIT 1`);
  const ts = row && row.raw_json.training_status; // raw_json is jsonb: already an object
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
app.get('/api/summary/weekly', handler(async (req, res) => {
  // Runs only by default so mileage/pace aren't polluted by walks/football.
  // ?group= overrides the bucket (e.g. walk); defaults to 'run'.
  const group = req.query.group || 'run';
  // date_trunc('week') is ISO Monday-start, matching the old SQLite expression.
  const rows = await db.all(
    `SELECT to_char(date_trunc('week', start_time_local), 'YYYY-MM-DD') AS week_start,
            COUNT(*)::int AS run_count,
            SUM(distance_m) AS total_distance_m,
            SUM(duration_s) AS total_duration_s,
            SUM(duration_s) / (SUM(distance_m) / 1000.0) AS avg_pace_s_per_km
     FROM activities
     WHERE start_time_local IS NOT NULL AND distance_m > 0 AND activity_group = $1
     GROUP BY week_start
     ORDER BY week_start DESC
     LIMIT 12`, [group]);
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
app.get('/api/personal-records', handler(async (req, res) => {
  const rows = await db.all(
    `SELECT type_id, label, value, value_kind, activity_id, record_date
     FROM personal_records ORDER BY type_id`);
  res.json(rows.map((r) => ({
    ...r,
    value_display: r.value_kind === 'distance'
      ? `${(r.value / 1000).toFixed(2)} km`
      : fmtDuration(r.value),
  })));
}));

// Current (most recent) Garmin race predictions, times formatted.
app.get('/api/race-predictions', handler(async (req, res) => {
  const row = await db.get(
    `SELECT calendar_date, time_5k_s, time_10k_s, time_half_s, time_marathon_s, fetched_at
     FROM race_predictions ORDER BY calendar_date DESC LIMIT 1`);
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
app.post('/api/planned/:schedule_id/race-override', handler(async (req, res) => {
  const scheduleId = Number(req.params.schedule_id);
  const { override } = req.body || {};
  if (![0, 1, null].includes(override)) {
    return res.status(400).json({ error: 'override must be 0, 1, or null' });
  }
  const result = await writeDb.run(
    'UPDATE planned_workouts SET is_race_override = $1 WHERE schedule_id = $2',
    [override, scheduleId]);
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'planned workout not found' });
  }
  res.json({ schedule_id: scheduleId, is_race_override: override });
}));

// Coaching profile (single row). Shoes/races/injuries are growable lists
// stored as jsonb; general_notes is plain text. GET returns the arrays as-is;
// POST stores them via the writable pool (same pattern as race-override).
// jsonb columns arrive parsed — normalise SQL NULL / non-array junk to [].
const parseList = (v) => (Array.isArray(v) ? v : []);

const readProfile = async () => {
  const row = await db.get(
    'SELECT shoes_json, races_json, injuries_json, routines_json, general_notes, runna_ical_url, updated_at FROM profile WHERE id = 1'
  ) || {};
  return {
    shoes: parseList(row.shoes_json),
    races: parseList(row.races_json),
    injuries: parseList(row.injuries_json),
    routines: parseList(row.routines_json),
    general_notes: row.general_notes || '',
    runna_ical_url: row.runna_ical_url || '',
    updated_at: row.updated_at || null,
  };
};

app.get('/api/profile', handler(async (req, res) => {
  res.json(await readProfile());
}));

app.post('/api/profile', handler(async (req, res) => {
  const b = req.body || {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  await writeDb.run(
    `UPDATE profile SET shoes_json = $1, races_json = $2,
       injuries_json = $3, routines_json = $4,
       general_notes = $5, runna_ical_url = $6,
       updated_at = $7
     WHERE id = 1`,
    [
      JSON.stringify(arr(b.shoes)),
      JSON.stringify(arr(b.races)),
      JSON.stringify(arr(b.injuries)),
      JSON.stringify(arr(b.routines)),
      b.general_notes || '',
      (b.runna_ical_url || '').trim(),
      new Date().toISOString(),
    ]);
  res.json(await readProfile());
}));

// Assembled coaching context — the compact structured summary the AI coach
// will consume. Inspect this to gauge shape/token-weight before wiring a model.
app.get('/api/coach/context', handler(async (req, res) => {
  res.json(await buildContext(db));
}));

// Copy-context dump — the full coaching context rendered as a readable text
// block with a priming prompt on top, ready to paste into an external LLM chat
// for a longer conversation than the in-app widget is meant for. Read-only.
app.get('/api/coach/context-dump', handler(async (req, res) => {
  res.json({ dump: await renderContextDump(db) });
}));

// Generate a fresh daily glance brief (Sonnet, cheap), store it in coach_notes
// as a 'daily' note, and return it. Write — uses the writable pool. The
// dashboard's brief carousel reads these; the deeper report is on-demand below.
app.post('/api/coach/daily', handler(async (req, res) => {
  const { text, context, model } = await generateBrief(db);
  const createdAt = new Date().toISOString();
  const end = createdAt.slice(0, 10);
  const start = new Date(Date.now() - context.window_days * 86400000)
    .toISOString().slice(0, 10);
  const result = await writeDb.run(
    `INSERT INTO coach_notes
       (created_at, note_type, content, model, date_range_start, date_range_end)
     VALUES ($1, 'daily', $2, $3, $4, $5)
     RETURNING id`,
    [createdAt, text, model, start, end]);
  res.json({
    id: result.rows[0].id,
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
app.post('/api/coach/report', handler(async (req, res) => {
  const { text, model } = await generateDetailedReport(db);
  res.json({ content: text, model });
}));

// On-demand per-day insight (Sonnet) for a clicked week-strip cell. Branches on
// the date's state: completed run -> how it went, planned-only -> execution
// tips, rest -> a static line (no model call). Stateless. Returns
// { content, kind, model }.
app.post('/api/coach/day/:date', handler(async (req, res) => {
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
app.post('/api/coach/chat', handler(async (req, res) => {
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
// Sessions pushed to Garmin this server session, newest last. The DB only
// learns about pushes on the next ingest, so the planning coach reads this
// in-memory list (planning.pushed_recently) to avoid double-booking a session
// it (or a previous thread) just pushed. Capped; resets on restart — after
// which the next ingest has usually backfilled the calendar anyway.
const recentPushes = [];
const RECENT_PUSHES_MAX = 20;

app.post('/api/coach/plan', handler(async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }
  const { reply, spec, done, specError } = await planReply(db, messages, recentPushes);
  res.json({ reply, spec, done, specError });
}));

// Recent coach notes, newest first. ?limit (default 10), ?note_type filters
// to one kind (e.g. 'daily' for the dashboard hero carousel).
app.get('/api/coach/notes', handler(async (req, res) => {
  const limit = Number(req.query.limit) || 10;
  const { note_type } = req.query;
  const rows = await db.all(
    `SELECT id, created_at, note_type, content, model, date_range_start, date_range_end
     FROM coach_notes
     WHERE ($1::text IS NULL OR note_type = $1::text)
     ORDER BY id DESC LIMIT $2`,
    [note_type || null, limit]);
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
app.post('/api/pacer/chat', handler(async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const { reply, params } = await pacerChat(messages, today);
  res.json({ reply, params });
}));

// Build (no network) and return a readable preview of the pacer. Body: params.
app.post('/api/pacer/preview', handler(async (req, res) => {
  res.json(await runPacer('preview', req.body || {}, 20000));
}));

// App-row schedule id: the ical negative-hash convention (ingest.py
// _ical_schedule_id — sha1, first 15 hex digits = 60 bits, negated) so it can
// never collide with Garmin's positive calendar-item ids. Computed as BigInt
// and bound as a string: the value exceeds 2^53, so a JS Number would round
// BEFORE it ever reached Postgres (the db.js int8 read-back TODO still rounds
// it on the way out, same as ical rows).
const appScheduleId = (uid) =>
  (-BigInt('0x' + crypto.createHash('sha1').update(uid).digest('hex').slice(0, 15))).toString();

// Build AND push to Garmin (upload + schedule). The ONLY endpoint that writes
// to Garmin — called only after the user approves the preview. Body: params
// (+ optional plan_id / rationale, Stage 9 — NULL for one-off single pushes).
// Successful pushes are recorded for the planning coach (see recentPushes)
// AND persisted as a source='app' planned_workouts row (Stage 9a): durable,
// ingest-immune, and what the read-path app-plan precedence keys on. The
// Garmin push is the point of no return — a failed insert afterwards must not
// look like a failed push (a retry would double-book Garmin), so it degrades
// to persisted:false in the response instead of a 500.
app.post('/api/pacer/push', handler(async (req, res) => {
  const spec = req.body || {};
  const result = await runPacer('push', spec, 120000);
  recentPushes.push({
    name: result.name,
    date: result.date,
    workout_id: result.workout_id,
    pushed_at: new Date().toISOString(),
  });
  if (recentPushes.length > RECENT_PUSHES_MAX) recentPushes.shift();

  let persisted = true;
  try {
    // steps_json holds the pushed spec verbatim (deterministic rebuild input).
    // node-pg serialises the object for the jsonb column — no JSON.stringify.
    await writeDb.run(
      `INSERT INTO planned_workouts
         (schedule_id, workout_id, calendar_date, title, sport_type,
          estimated_distance_m, estimated_duration_s, steps_json,
          source, plan_id, rationale)
       VALUES ($1, $2, $3, $4, 'running', $5, $6, $7, 'app', $8, $9)
       ON CONFLICT (schedule_id) DO NOTHING`,
      [appScheduleId(`app:${result.schedule_id}`), result.workout_id,
       result.date, result.name,
       result.total_distance_m ?? null, result.est_duration_s ?? null,
       spec, spec.plan_id || null, spec.rationale || null]);
  } catch (err) {
    persisted = false;
    console.error('pacer push succeeded on Garmin but planned_workouts insert failed:', err.message);
  }
  res.json({ ...result, persisted });
}));

// Async init: the column lists must exist before any route can run, so they
// are awaited BEFORE the server starts listening (no startup race).
async function start() {
  ACTIVITY_COLS = await cols('activities');
  LAP_COLS = await cols('laps');
  // Loopback only — nothing on the LAN should reach the API directly.
  app.listen(PORT, '127.0.0.1', () => console.log(`Garmin Hub API listening on 127.0.0.1:${PORT}`));
}

start().catch((err) => {
  console.error('Failed to start API:', err.message);
  process.exit(1);
});
