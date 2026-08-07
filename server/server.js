// Garmin Hub — Express API over the garminhub Postgres database.
const path = require('path');
const crypto = require('crypto');
// Load server/.env (ANTHROPIC_API_KEY, optional DATABASE_URL_RO/RW) before
// requiring the db pools and coach client.
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const { spawn } = require('child_process');
const express = require('express');
const { db, writeDb } = require('./db');
const { buildContext, renderContextDump, localDate } = require('./context');
const { collapseRaceDuplicates, applyAppPlanPrecedence } = require('./planned');
const { generateBrief, generateDetailedReport, generateDayInsight, chatReply, planReply, composeReply } = require('./coach');
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
  // removed_at: Stage 9d soft-deleted sessions are history, never display rows.
  // Draft gate (9d-2): a saved-but-unactivated plan is dormant — its sessions
  // never surface on default read paths (nor suppress Runna; see planned.js).
  const where = ["p.removed_at IS NULL", "pl.status IS DISTINCT FROM 'draft'"];
  const params = [];
  if (req.query.from) { params.push(req.query.from); where.push(`p.calendar_date >= $${params.length}`); }
  if (req.query.to) { params.push(req.query.to); where.push(`p.calendar_date <= $${params.length}`); }
  const rows = await db.all(
    `SELECT p.schedule_id, p.workout_id, p.calendar_date, p.title, p.sport_type, p.source,
            p.is_race_auto, p.is_race_override,
            COALESCE(p.is_race_override, p.is_race_auto) AS is_race,
            p.estimated_distance_m, p.estimated_duration_s, p.steps_json,
            pl.status AS plan_status
     FROM planned_workouts p LEFT JOIN plans pl ON pl.plan_id = p.plan_id
     WHERE ${where.join(' AND ')} ORDER BY p.calendar_date`, params);
  // App-plan precedence first (a LIVE app row — active plan or one-off push —
  // owns its date: upcoming Runna/Garmin rows on it are dropped), then
  // collapse same-day race triplicates (Runna race + manual override + pacer)
  // into one row before shaping; the survivor carries a pacer_available flag.
  // steps_json is jsonb — pg hands back the parsed array (or null) directly.
  const out = collapseRaceDuplicates(applyAppPlanPrecedence(rows)).map((r) => {
    const { steps_json, plan_status, ...rest } = r;
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
  const createdAt = new Date().toISOString();  // timestamptz — UTC is correct here
  // The note's date range is a CALENDAR range and must match the context the
  // brief was written from: local today (context.today), back window_days. The
  // old UTC slice could label the brief with yesterday's date under BST.
  const end = context.today;
  const start = localDate(-context.window_days);
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
// conversation so far. Returns { reply, spec, edit } — spec is the extracted
// session spec object when the coach presents one; edit is a Stage 9d edit
// directive (move/delete/replace on an active-plan session). This endpoint
// COMPOSES only; preview/push go through /api/pacer/preview and
// /api/pacer/push, edits through /api/plan/session/... after the athlete
// confirms. Stateless: nothing persisted.
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
  const { reply, spec, edit, done, specError } = await planReply(db, messages, recentPushes);
  res.json({ reply, spec, edit, done, specError });
}));

// Coach memory — the durable facts the conversational coach has silently
// remembered (note_type='memory' coach_notes rows; see the memory tools in
// coach.js). GET feeds the Settings list; forget is the athlete's manual
// prune (the coach's own deletions go through its forget_fact tool).
app.get('/api/coach/memory', handler(async (req, res) => {
  res.json(await db.all(
    `SELECT id, created_at, content FROM coach_notes
     WHERE note_type = 'memory' ORDER BY id DESC`));
}));

app.post('/api/coach/memory/:id/forget', handler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const result = await writeDb.run(
    `DELETE FROM coach_notes WHERE id = $1 AND note_type = 'memory'`, [id]);
  if (!result.rowCount) return res.status(404).json({ error: 'memory fact not found' });
  res.json({ forgotten: id });
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
  // Local, not UTC: the athlete says "Saturday" in their own timezone, and the
  // date this resolves to is what gets scheduled on the watch.
  const { reply, params } = await pacerChat(messages, localDate());
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

// --- Adapted-plan composer (Stage 9b) ------------------------------------------
// Composer-mode coach turn (Opus). Body: { messages }. Returns { reply, plan,
// planError } — plan is the extracted multi-week plan when the coach presents
// one. Generation-time validation: every session's spec runs through the SAME
// deterministic Python guard the push path uses (one spawn for the whole
// plan), so the review never shows a plan that couldn't later push. Invalid
// sessions are FLAGGED on the plan, never silently dropped. Stateless; writes
// nothing — persistence is /api/plan/save below, Garmin push is Stage 9c.
app.post('/api/coach/compose', handler(async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }
  const { reply, plan, planError } = await composeReply(db, messages, recentPushes);
  if (plan) {
    const v = await runPacer('validate', { sessions: plan.sessions }, 30000);
    plan.sessions = plan.sessions.map((s, i) => {
      const r = v.sessions[i];
      return r?.ok
        ? { ...s, valid: true,
            preview: { name: r.name, total_distance_m: r.total_distance_m,
                       est_duration_s: r.est_duration_s, segments: r.segments } }
        : { ...s, valid: false, error: r ? r.error : 'no validation result' };
    });
  }
  res.json({ reply, plan, planError });
}));

// Persist a reviewed plan — a plans parent row + planned_workouts source='app'
// session rows sharing one plan_id. A DB write ONLY (no Garmin; pushing is the
// activation step below). Body: { plan: { name?, goal_race?, summary?, weeks?,
// sessions: [...] } } — sessions in the composer's spec shape. The guard
// re-runs on the exact specs being persisted (the write trusts nothing it
// didn't check itself) and also supplies the built distance/duration
// estimates. Everything runs as ONE atomic statement, so a partial plan can
// never persist. Draft hygiene (Stage 9d): saving a new draft supersedes ALL
// prior unactivated drafts — their session rows are deleted and their parents
// flip to 'discarded' (retained as history, never deleted). One plan pipeline
// at a time is the app's model (/api/plan/current surfaces exactly one plan),
// so any older draft would otherwise pile up invisibly. One-off pushed
// sessions (plan_id NULL) are already on Garmin and always survive.
// A date span that already holds PUSHED plan sessions is refused: silently
// replacing them would orphan live on-device workouts — replacing a live plan
// is re-adaptation (Stage 9e), which owns unscheduling.
app.post('/api/plan/save', handler(async (req, res) => {
  const plan = (req.body || {}).plan || {};
  const sessions = Array.isArray(plan.sessions) ? plan.sessions : [];
  if (!sessions.length) {
    return res.status(400).json({ error: 'plan.sessions must be a non-empty array' });
  }
  const today = localDate();
  if (sessions.some((s) => !s || typeof s.date !== 'string' || s.date < today)) {
    return res.status(400).json({ error: `every session needs a date on or after today (${today})` });
  }

  const v = await runPacer('validate', { sessions }, 30000);
  const bad = v.sessions.map((r, i) => ({ ...r, i })).filter((r) => !r.ok);
  if (bad.length) {
    return res.status(400).json({
      error: `plan failed validation: ${bad
        .map((r) => `"${sessions[r.i].name || sessions[r.i].date}": ${r.error}`)
        .join('; ')}`,
    });
  }

  const dates = sessions.map((s) => s.date).sort();
  const [from, to] = [dates[0], dates[dates.length - 1]];
  const planId = `plan-${today}-${crypto.randomBytes(3).toString('hex')}`;

  // removed_at IS NULL: a soft-deleted session's Garmin workout is gone, so it
  // must not block a new plan over its date.
  const pushed = await db.get(
    `SELECT count(*)::int AS n FROM planned_workouts
     WHERE source = 'app' AND plan_id IS NOT NULL AND workout_id IS NOT NULL
       AND removed_at IS NULL AND calendar_date BETWEEN $1 AND $2`, [from, to]);
  if (pushed.n > 0) {
    return res.status(409).json({
      error: `the current plan already has ${pushed.n} session(s) pushed to Garmin on this date span — replacing a live plan (re-adaptation) isn't supported yet`,
    });
  }

  const params = [from, to, planId, plan.name || 'Adapted plan',
                  plan.goal_race || null, plan.summary || null,
                  Array.isArray(plan.weeks) ? JSON.stringify(plan.weeks) : null,
                  new Date().toISOString()];
  const values = sessions.map((s, i) => {
    // steps_json stores the buildable spec verbatim (what push consumes) —
    // review-only fields (valid/preview/error) are stripped; rationale gets
    // its own column.
    const spec = { name: s.name, date: s.date, warmup_m: s.warmup_m || 0,
                   cooldown_m: s.cooldown_m || 0, blocks: s.blocks, type: s.type || null };
    params.push(appScheduleId(`plan:${planId}:${i}`), s.date,
                s.name || 'Planned session', v.sessions[i].total_distance_m,
                v.sessions[i].est_duration_s, spec, planId, s.rationale || null);
    const b = params.length - 8;
    return `($${b + 1}, NULL, $${b + 2}, $${b + 3}, 'running', $${b + 4}, $${b + 5}, $${b + 6}, 'app', $${b + 7}, $${b + 8})`;
  });
  // Draft hygiene, one atomic statement: every existing draft is superseded by
  // this save — its session rows are deleted (they were never on Garmin; the
  // 409 above blocks any span holding pushed rows, and non-draft plans' rows
  // are all pushed or past) and its parent flips to 'discarded' (kept as
  // history — the lifecycle never deletes a plan). Both DML CTEs read the
  // statement snapshot, so the new parent inserted below is untouched by them.
  await writeDb.run(
    `WITH superseded AS (
       DELETE FROM planned_workouts
       WHERE source = 'app'
         AND plan_id IN (SELECT plan_id FROM plans WHERE status = 'draft')
     ), discarded AS (
       UPDATE plans SET status = 'discarded' WHERE status = 'draft'
     ), parent AS (
       INSERT INTO plans (plan_id, name, goal_race, summary, weeks_json,
                          date_from, date_to, status, created_at)
       VALUES ($3, $4, $5, $6, $7, $1, $2, 'draft', $8)
     )
     INSERT INTO planned_workouts
       (schedule_id, workout_id, calendar_date, title, sport_type,
        estimated_distance_m, estimated_duration_s, steps_json,
        source, plan_id, rationale)
     VALUES ${values.join(', ')}`,
    params);
  res.json({ plan_id: planId, sessions: sessions.length, from, to });
}));

// A plan's "finished" line: the goal-race date when one is parseable from the
// free-text goal_race ("Telford 10K on 2026-09-13"), else the last session
// date. SQL fragment used by the auto-complete check and activation retirement.
const PLAN_FINISHED_SQL =
  `COALESCE(substring(goal_race from '\\d{4}-\\d{2}-\\d{2}')::date, date_to) < $1::date`;

// Current plan + its push state — drives the dashboard activation card.
// Sessions carry schedule_id as TEXT (the negative 60-bit hashes round past
// 2^53 as JS Numbers — the documented db.js int8 TODO; string ids stay exact
// so push-next can key on them). Push state per session is workout_id:
// NULL = not yet pushed. Counts split pending (future, pushable) from expired
// (date passed unpushed — never pushed, not blocking completion).
// runna_remaining (9d-3, span-scoped): future garmin/runna_ical rows INSIDE
// the plan's own date span that are NOT ghosts of our own pushes (ingest
// re-ingests a pushed workout's calendar entry as a garmin row with the same
// workout_id). This is both the cancel-Runna gate and the "does this plan
// supersede Runna at all?" test: a bridge/gap plan whose span holds no Runna
// rows skips the cancel choreography entirely, and calendar items OUTSIDE the
// span (a race today, an unrelated future workout) can never wedge the gate —
// the pre-9d-3 global count did exactly that. runna_cleared mirrors the manual
// override stamp (see /runna-cleared below); the gate is satisfied by either.
const planPayload = async (plan, today) => {
  const sessions = await db.all(
    `SELECT schedule_id::text AS schedule_id, calendar_date, title,
            estimated_distance_m, workout_id
     FROM planned_workouts
     WHERE source = 'app' AND plan_id = $1 AND removed_at IS NULL
     ORDER BY calendar_date`, [plan.plan_id]);
  const pending = sessions.filter((s) => s.workout_id == null && s.calendar_date >= today).length;
  const expired = sessions.filter((s) => s.workout_id == null && s.calendar_date < today).length;
  const from = plan.date_from > today ? plan.date_from : today;
  const runna = await db.get(
    `SELECT count(*)::int AS n FROM planned_workouts p
     WHERE p.source IN ('garmin', 'runna_ical')
       AND p.calendar_date >= $1 AND p.calendar_date <= $2
       AND NOT EXISTS (SELECT 1 FROM planned_workouts a
                       WHERE a.source = 'app' AND a.workout_id = p.workout_id)`,
    [from, plan.date_to]);
  const { weeks_json, runna_cleared_at, ...rest } = plan;
  return {
    ...rest,
    weeks: weeks_json ?? null,
    sessions,
    counts: { total: sessions.length, pushed: sessions.length - pending - expired, pending, expired },
    runna_remaining: runna.n,
    runna_cleared: runna_cleared_at != null,
  };
};

// Lifecycle (Stage 9d): the auto-complete check runs here — this is the read
// every dashboard load makes, so it's the leanest place (no scheduler). The
// UPDATE is idempotent and forward-only (active -> completed when the block's
// race/last session has passed); nothing is deleted. Selection prefers the
// live pipeline: active plan, else newest draft, else the newest completed
// (so the dashboard can note the block finished) — EXCEPT (9d-3) that a
// QUIESCENT active plan (nothing left to push, Runna gate satisfied) yields to
// a newer draft: its activation card is done, and letting it keep the slot was
// exactly how a stale cancel step blocked the next plan from ever activating.
// The draft payload carries supersedes_active so the card can warn that
// activating it archives the still-live plan (one active plan at a time —
// queued auto-activation stays a non-goal). Archived/discarded plans are
// history and never surface here.
const PLAN_SELECT =
  `SELECT plan_id, name, goal_race, summary, weeks_json, date_from, date_to,
          status, created_at, runna_cleared_at FROM plans`;

app.get('/api/plan/current', handler(async (req, res) => {
  const today = localDate();
  await writeDb.run(
    `UPDATE plans SET status = 'completed'
     WHERE status = 'active' AND ${PLAN_FINISHED_SQL}`, [today]);
  const plan = await db.get(
    `${PLAN_SELECT} WHERE status IN ('active', 'draft', 'completed')
     ORDER BY (status = 'active') DESC, (status = 'draft') DESC, created_at DESC
     LIMIT 1`);
  if (!plan) return res.json(null);
  let payload = await planPayload(plan, today);
  if (plan.status === 'active' && payload.counts.pending === 0
      && (payload.runna_remaining === 0 || payload.runna_cleared)) {
    const draft = await db.get(
      `${PLAN_SELECT} WHERE status = 'draft' ORDER BY created_at DESC LIMIT 1`);
    if (draft) {
      payload = {
        ...(await planPayload(draft, today)),
        supersedes_active: plan.name || plan.plan_id,
      };
    }
  }
  res.json(payload);
}));

// Manual cancel-gate override (9d-3): the athlete asserts Runna is cancelled
// (or was never involved) — "Runna's already gone, skip this check". The hub
// can see its own DB, not Runna's backend, so the athlete's word is the final
// authority here: stamp the plan, and drop future runna_ical rows on that
// assertion (they are pure feed mirror — if the feed is actually alive they
// reappear on the next ingest, cosmetically, with the gate already satisfied;
// if the feed died with the cancellation, ingest's deliberately conservative
// stale cleanup would otherwise never clear them). garmin rows are left to
// ingest's own calendar-driven cleanup — they may be real workouts.
app.post('/api/plan/:plan_id/runna-cleared', handler(async (req, res) => {
  const plan = await db.get(
    'SELECT plan_id, status FROM plans WHERE plan_id = $1', [req.params.plan_id]);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  if (!['draft', 'active'].includes(plan.status)) {
    return res.status(409).json({ error: `plan is ${plan.status} — nothing to clear` });
  }
  await writeDb.run(
    'UPDATE plans SET runna_cleared_at = $2 WHERE plan_id = $1',
    [plan.plan_id, new Date().toISOString()]);
  const dropped = await writeDb.run(
    `DELETE FROM planned_workouts WHERE source = 'runna_ical' AND calendar_date >= $1`,
    [localDate()]);
  res.json({ cleared: plan.plan_id, runna_ical_dropped: dropped.rowCount });
}));

// Push the plan's next pending session to Garmin — the activation core. The
// client loops this until { done } (sequential by construction: one spawn, one
// Garmin write per call, same path/pace as a single pacer push). Each call:
// oldest future session with workout_id NULL → its steps_json spec re-runs the
// FULL guard inside pacer_cli push (a saved spec is trusted no more than a
// fresh one) → upload + schedule → workout_id recorded on the row. A failure
// leaves workout_id NULL, so re-running resumes exactly there — pushed rows
// are never re-selected, nothing double-books. When nothing is pending the
// plan flips to 'active' (the signal the cancel-Runna step gates on).
// Mirror of the 9a push hazard: if Garmin succeeded but the row update failed,
// respond recorded:false rather than 500 — a blind retry WOULD double-book.
// In-process lock (ingestRunning pattern): a Garmin plan write takes ~30s of
// I/O, so overlapping calls could select the same pending session (push-next)
// or reconcile the same row twice (Stage 9d edits) and double-book. One
// Garmin-writing plan operation at a time, enforced server-side — shared by
// push-next and the move/remove/replace edits below.
let planPushRunning = false;

const withGarminLock = (fn) => handler(async (req, res) => {
  if (planPushRunning) {
    return res.status(409).json({ error: 'another Garmin plan write is already in flight' });
  }
  planPushRunning = true;
  try {
    await fn(req, res);
  } finally {
    planPushRunning = false;
  }
});

app.post('/api/plan/:plan_id/push-next', withGarminLock(pushNextSession));

async function pushNextSession(req, res) {
  const planId = req.params.plan_id;
  const plan = await db.get('SELECT plan_id, status FROM plans WHERE plan_id = $1', [planId]);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  const today = localDate();
  const next = await db.get(
    `SELECT schedule_id::text AS schedule_id, calendar_date, steps_json
     FROM planned_workouts
     WHERE source = 'app' AND plan_id = $1 AND workout_id IS NULL
       AND removed_at IS NULL AND calendar_date >= $2
     ORDER BY calendar_date LIMIT 1`, [planId, today]);

  if (!next) {
    if (plan.status !== 'active') {
      // One active plan, enforced HERE (activation), not by sweep: before this
      // plan goes active, retire any other active plan — 'completed' if its
      // block already finished (race/last session passed), else 'archived'
      // (superseded while still live — the 9e re-adaptation case). Retire
      // first, then flip, so a crash between the two can never leave two
      // actives. Both moves are forward-only; nothing is deleted.
      await writeDb.run(
        `UPDATE plans
         SET status = CASE WHEN ${PLAN_FINISHED_SQL} THEN 'completed' ELSE 'archived' END
         WHERE status = 'active' AND plan_id != $2`, [today, planId]);
      await writeDb.run(`UPDATE plans SET status = 'active' WHERE plan_id = $1`, [planId]);
    }
    return res.json({ done: true, status: 'active' });
  }

  const result = await runPacer('push', next.steps_json, 120000);
  recentPushes.push({
    name: result.name,
    date: result.date,
    workout_id: result.workout_id,
    pushed_at: new Date().toISOString(),
  });
  if (recentPushes.length > RECENT_PUSHES_MAX) recentPushes.shift();

  let recorded = true;
  try {
    await writeDb.run(
      'UPDATE planned_workouts SET workout_id = $1 WHERE schedule_id = $2::bigint',
      [result.workout_id, next.schedule_id]);
  } catch (err) {
    recorded = false;
    console.error('plan push succeeded on Garmin but workout_id update failed:', err.message);
  }
  const remaining = await db.get(
    `SELECT count(*)::int AS n FROM planned_workouts
     WHERE source = 'app' AND plan_id = $1 AND workout_id IS NULL
       AND removed_at IS NULL AND calendar_date >= $2`, [planId, today]);
  res.json({
    pushed: { schedule_id: next.schedule_id, name: result.name, date: result.date,
              workout_id: result.workout_id },
    recorded,
    remaining: remaining.n,
  });
}

// Discard a DRAFT (9d-2): hard-delete the plans row and its session rows.
// Hard delete is correct ONLY for drafts — nothing was ever pushed or run, so
// there is no history to preserve. The gate is double-checked: status must be
// 'draft' AND no session may carry a workout_id (a mid-activation plan is
// still 'draft' while push-next stamps ids — deleting those rows would orphan
// live Garmin workouts). Every other status is refused: active/completed/
// archived plans have real training history and are never deleted (the
// general "clear finished plans" button remains a TODO). One atomic statement
// via writeDb, gate re-checked inside it; shares the plan-write lock so a
// discard can't race an in-flight push-next.
app.post('/api/plan/:plan_id/discard', withGarminLock(async (req, res) => {
  const planId = req.params.plan_id;
  const plan = await db.get(
    `SELECT pl.status, pl.name,
            count(p.workout_id)::int AS pushed
     FROM plans pl
     LEFT JOIN planned_workouts p ON p.plan_id = pl.plan_id AND p.source = 'app'
     WHERE pl.plan_id = $1 GROUP BY pl.plan_id`, [planId]);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  if (plan.status !== 'draft') {
    return res.status(409).json({
      error: `only a draft can be discarded — this plan is ${plan.status} and is kept as history`,
    });
  }
  if (plan.pushed > 0) {
    return res.status(409).json({
      error: `this draft already has ${plan.pushed} session(s) on Garmin (activation started) — finish or resume the push instead`,
    });
  }
  const result = await writeDb.run(
    `WITH gone AS (
       DELETE FROM plans WHERE plan_id = $1 AND status = 'draft'
         AND NOT EXISTS (SELECT 1 FROM planned_workouts
                         WHERE plan_id = $1 AND source = 'app' AND workout_id IS NOT NULL)
       RETURNING plan_id
     ), sess AS (
       DELETE FROM planned_workouts
       WHERE source = 'app' AND plan_id IN (SELECT plan_id FROM gone)
       RETURNING schedule_id
     )
     SELECT (SELECT count(*) FROM gone)::int AS plans,
            (SELECT count(*) FROM sess)::int AS sessions`, [planId]);
  const row = result.rows[0];
  if (!row.plans) return res.status(409).json({ error: 'plan is no longer a discardable draft' });
  res.json({ discarded: planId, name: plan.name, sessions: row.sessions });
}));

// --- Single-session plan edits (Stage 9d) ---------------------------------
// Move / delete / nudge — chat-invoked via planning mode, athlete-confirmed in
// the UI before anything runs here. All three funnel through the same Garmin
// reconcile primitive (pacer_cli.py `reconcile`: the NEW state lands on Garmin
// before the OLD one is removed, so a mid-op failure double-lists rather than
// vanishes a session) and the same row bookkeeping below. Scope: the ACTIVE
// plan's sessions, today onward — past sessions are frozen history.

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dowOf = (date) => DOW[new Date(`${date}T00:00:00`).getDay()];

// Ghost cleanup: ingest re-ingests a pushed app workout's calendar entry as a
// source='garmin' row keyed by the same workout_id (the 9c discovery). After a
// reconcile has moved or deleted that workout, the ghost describes a calendar
// entry that no longer exists — drop it now instead of waiting for the next
// ingest's stale cleanup. Future rows only; past rows are history.
const clearGhosts = (workoutId) => writeDb.run(
  `DELETE FROM planned_workouts
   WHERE source = 'garmin' AND workout_id = $1 AND calendar_date >= $2`,
  [workoutId, localDate()]);

// Load + gate an editable session by schedule_id (text — exact past 2^53).
// Responds with the right error itself and returns null when not editable.
async function editableSession(req, res) {
  const id = req.params.schedule_id;
  if (!/^-?\d+$/.test(id)) {
    res.status(400).json({ error: 'bad schedule_id' });
    return null;
  }
  const row = await db.get(
    `SELECT p.schedule_id::text AS schedule_id, p.workout_id, p.calendar_date,
            p.title, p.steps_json, p.plan_id, p.removed_at, pl.status
     FROM planned_workouts p LEFT JOIN plans pl ON pl.plan_id = p.plan_id
     WHERE p.schedule_id = $1::bigint AND p.source = 'app'`, [id]);
  if (!row || row.removed_at) {
    res.status(404).json({ error: 'session not found' });
    return null;
  }
  if (!row.plan_id || row.status !== 'active') {
    res.status(409).json({ error: 'only sessions of the active plan can be edited' });
    return null;
  }
  if (row.calendar_date < localDate()) {
    res.status(409).json({ error: 'past sessions are frozen history' });
    return null;
  }
  return row;
}

// Move — change a session's DATE, nothing else. A collision on the target date
// (another workout, or a routine day like football) is flagged back for
// confirmation, never silently stacked or refused: the first call returns
// { collision } and does nothing; the retry with force:true proceeds. The
// stored spec is re-validated on principle (content unchanged — trust nothing
// unchecked). Garmin reconcile reschedules the SAME workout template (no
// re-upload), new date first, so the session never vanishes mid-move.
app.post('/api/plan/session/:schedule_id/move', withGarminLock(async (req, res) => {
  const row = await editableSession(req, res);
  if (!row) return;
  const { to_date, force } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to_date || '')) {
    return res.status(400).json({ error: 'to_date must be YYYY-MM-DD' });
  }
  if (to_date < localDate()) {
    return res.status(400).json({ error: 'target date is in the past' });
  }
  if (to_date === row.calendar_date) {
    return res.status(400).json({ error: 'session is already on that date' });
  }

  const v = await runPacer('validate', { sessions: [{ ...row.steps_json, date: to_date }] }, 30000);
  if (!v.sessions[0]?.ok) {
    return res.status(400).json({ error: `stored spec failed validation: ${v.sessions[0]?.error}` });
  }

  if (!force) {
    const reasons = [];
    const others = await db.all(
      `SELECT title, source, workout_id FROM planned_workouts
       WHERE calendar_date = $1 AND removed_at IS NULL AND schedule_id != $2::bigint`,
      [to_date, row.schedule_id]);
    // Ghost garmin rows of app pushes would double-report their app row.
    const appWids = new Set(others
      .filter((o) => o.source === 'app' && o.workout_id != null)
      .map((o) => o.workout_id));
    if (row.workout_id != null) appWids.add(row.workout_id);
    for (const o of others) {
      if (o.source === 'garmin' && appWids.has(o.workout_id)) continue;
      reasons.push(`already has "${o.title || 'a workout'}"`);
    }
    const prof = await db.get('SELECT routines_json FROM profile WHERE id = 1') || {};
    for (const r of (Array.isArray(prof.routines_json) ? prof.routines_json : [])) {
      if (r && r.activity && r.day === dowOf(to_date)) {
        reasons.push(`is your ${r.activity} day`);
      }
    }
    if (reasons.length) {
      return res.json({ collision: { date: to_date, reasons: [...new Set(reasons)] } });
    }
  }

  let warning = null;
  if (row.workout_id != null) {
    const result = await runPacer('reconcile',
      { op: 'move', workout_id: row.workout_id, from_date: row.calendar_date, to_date }, 120000);
    warning = result.warning || null;
    recentPushes.push({ name: row.title, date: to_date, workout_id: row.workout_id,
                        pushed_at: new Date().toISOString() });
    if (recentPushes.length > RECENT_PUSHES_MAX) recentPushes.shift();
  }
  // Mirror of the 9a/9c push hazard: Garmin is already reconciled, so a row
  // failure degrades to recorded:false rather than a 500 (a blind retry would
  // reschedule a second calendar entry).
  let recorded = true;
  try {
    await writeDb.run(
      'UPDATE planned_workouts SET calendar_date = $1 WHERE schedule_id = $2::bigint',
      [to_date, row.schedule_id]);
    if (row.workout_id != null) await clearGhosts(row.workout_id);
  } catch (err) {
    recorded = false;
    console.error('move reconciled on Garmin but the row update failed:', err.message);
  }
  res.json({
    moved: { schedule_id: row.schedule_id, title: row.title,
             from: row.calendar_date, to: to_date },
    recorded, warning,
  });
}));

// Delete — drop a whole session. Soft-delete (removed_at stamps the skip so
// history and 9e's load-awareness can see it — the row is never hard-deleted)
// plus Garmin delete by workout_id (removes the template and its calendar
// entry, the 9c-established behaviour). No collision check, no push.
app.post('/api/plan/session/:schedule_id/remove', withGarminLock(async (req, res) => {
  const row = await editableSession(req, res);
  if (!row) return;
  if (row.workout_id != null) {
    await runPacer('reconcile', { op: 'remove', workout_id: row.workout_id }, 120000);
  }
  let recorded = true;
  try {
    await writeDb.run(
      'UPDATE planned_workouts SET removed_at = $1 WHERE schedule_id = $2::bigint',
      [new Date().toISOString(), row.schedule_id]);
    if (row.workout_id != null) await clearGhosts(row.workout_id);
  } catch (err) {
    recorded = false;
    console.error('remove succeeded on Garmin but the soft-delete failed:', err.message);
  }
  res.json({
    removed: { schedule_id: row.schedule_id, title: row.title, date: row.calendar_date },
    recorded,
  });
}));

// Nudge — replace this ONE session's content in place (same date; a date
// change is a move). Body: { spec } — the corrected full session spec the
// athlete confirmed against the coach's preview. The guard runs inside the
// reconcile build, so nothing reaches Garmin unvalidated; the new workout
// lands BEFORE the old one is deleted. Strictly no ripple: only this row
// changes — cross-session rebalancing is re-adaptation (9e), not a nudge.
app.post('/api/plan/session/:schedule_id/replace', withGarminLock(async (req, res) => {
  const row = await editableSession(req, res);
  if (!row) return;
  const s = (req.body || {}).spec;
  if (!s || !Array.isArray(s.blocks) || !s.blocks.length) {
    return res.status(400).json({ error: 'spec with a non-empty blocks array required' });
  }
  if (s.date !== row.calendar_date) {
    return res.status(400).json({
      error: `a nudge is in-place — the spec date must stay ${row.calendar_date} (move the session separately)`,
    });
  }
  // Same field whitelist as plan save: only the buildable spec persists.
  const spec = { name: s.name, date: s.date, warmup_m: s.warmup_m || 0,
                 cooldown_m: s.cooldown_m || 0, blocks: s.blocks,
                 type: s.type ?? row.steps_json?.type ?? null };
  const result = row.workout_id != null
    ? await runPacer('reconcile', { op: 'replace', replace_workout_id: row.workout_id, ...spec }, 120000)
    : await runPacer('push', spec, 120000);
  recentPushes.push({ name: result.name, date: result.date,
                      workout_id: result.workout_id, pushed_at: new Date().toISOString() });
  if (recentPushes.length > RECENT_PUSHES_MAX) recentPushes.shift();

  let recorded = true;
  try {
    await writeDb.run(
      `UPDATE planned_workouts
       SET workout_id = $1, title = $2, estimated_distance_m = $3,
           estimated_duration_s = $4, steps_json = $5
       WHERE schedule_id = $6::bigint`,
      [result.workout_id, result.name, result.total_distance_m ?? null,
       result.est_duration_s ?? null, spec, row.schedule_id]);
    if (row.workout_id != null) await clearGhosts(row.workout_id);
  } catch (err) {
    recorded = false;
    console.error('replace succeeded on Garmin but the row update failed:', err.message);
  }
  res.json({
    updated: { schedule_id: row.schedule_id, name: result.name,
               date: result.date, workout_id: result.workout_id },
    recorded, warning: result.warning || null,
  });
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
