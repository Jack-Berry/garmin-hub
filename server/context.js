// Coaching context engine — assembles a compact, structured training summary
// from the DB for the AI coach. Summarises (never dumps) recent runs, recovery,
// upcoming planned workouts, the profile, and a few code-derived signals.
// Read-only: takes the shared read-only db connection.
const { collapseRaceDuplicates, applyAppPlanPrecedence } = require('./planned');
const { computeZones } = require('./zones');
const { resolveGoalPaces } = require('./goalpaces');
// Guard bounds — the SAME file the enforcer (ingest/pacer_cli.py) and the
// builder's negative-split shape load, so the advisory copy can't drift.
const GUARD_BOUNDS = require('../ingest/guard_bounds.json');

// Profile lists are jsonb — pg hands back parsed arrays; normalise SQL NULL /
// non-array junk to [].
const parseList = (v) => (Array.isArray(v) ? v : []);

// YYYY-MM-DD strings computed in JS and passed as query params — replaces
// SQLite's date('now', ...) calls and keeps their exact semantics:
// utcDate mirrors date('now') (UTC); localDate mirrors date('now','localtime').
const utcDate = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
const localDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Weekday label (matches the profile routine `day` values) for a YYYY-MM-DD.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dowOf = (date) => DOW[new Date(`${date}T00:00:00`).getDay()];

// Coarse activity_group for a free-text routine name, mirroring ingest's
// derivation so a logged Garmin activity can match a recurring profile one.
const routineGroup = (name) => {
  const s = (name || '').toLowerCase();
  if (/football|soccer/.test(s)) return 'football';
  if (/walk/.test(s)) return 'walk';
  if (/run/.test(s)) return 'run';
  return 'other';
};

// seconds-per-km -> "M:SS"
const pace = (sPerKm) => {
  const s = Math.round(sPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// absolute seconds -> "M:SS" or "H:MM:SS" (for PR / prediction times, which can
// exceed an hour — unlike per-km pace, which never does).
const hms = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
};

// Lap intensity types that represent work (vs warmup/cooldown/rest recovery).
const WORK_TYPES = new Set(['ACTIVE', 'INTERVAL']);

// Summarise a structured session's work reps as one compact line — count, rep
// distance (single "~Dm" or "Dmin–Dmaxm" range), and the pace range across the
// reps (fastest–slowest). Warmup/cooldown/rest laps are excluded: those are
// what skew the whole-run average and make hard reps look slow. Returns null
// for steady runs (the existing whole-run average is fine for those).
const workIntervalSummary = (laps) => {
  // Structured = a mix of intensity types (work + warmup/cooldown/rest present).
  // Auto-lapped steady runs carry a single uniform type, so they're skipped —
  // even progression/long runs whose pace drifts within one intensity label.
  const types = new Set(laps.map((l) => l.intensity_type).filter(Boolean));
  if (types.size < 2) return null;

  const work = laps.filter(
    (l) => WORK_TYPES.has(l.intensity_type) && l.distance_m > 0 && l.duration_s > 0
  );
  if (work.length < 2) return null;

  const dists = work.map((l) => Math.round(l.distance_m / 50) * 50);
  const dMin = Math.min(...dists), dMax = Math.max(...dists);
  const distLabel = dMin === dMax ? `~${dMin}m` : `${dMin}m–${dMax}m`;

  const secs = work.map((l) => l.duration_s / (l.distance_m / 1000));
  const pMin = pace(Math.min(...secs)), pMax = pace(Math.max(...secs));
  const paceLabel = pMin === pMax ? `${pMin}/km` : `${pMin}–${pMax}/km`;

  return `${work.length} × ${distLabel} work reps, pace ${paceLabel}`;
};

// pace.zone speed bounds (m/s) -> "M:SS-M:SS/km" (faster bound = higher m/s).
const paceTarget = (fast, slow) => {
  if (!fast) return null;
  const a = pace(1000 / fast);
  const b = slow ? pace(1000 / slow) : null;
  return b && b !== a ? `${a}-${b}/km` : `${a}/km`;
};

// Compact end-condition label, e.g. "400m", "3.0km", "60s", "lap".
const endLabel = (step) => {
  const k = step.endCondition?.conditionTypeKey;
  const v = step.endConditionValue;
  if (k === 'distance') return v >= 1000 ? `${+(v / 1000).toFixed(2)}km` : `${v}m`;
  if (k === 'time') return `${v}s`;
  if (k === 'lap.button') return 'lap';
  return k || '';
};

// One step -> compact string. Repeats become "Nx [child, child]".
const stepStr = (step) => {
  if (step.type === 'RepeatGroupDTO') {
    const inner = (step.workoutSteps || []).map(stepStr).join(', ');
    return `${step.numberOfIterations}x [${inner}]`;
  }
  const type = step.stepType?.stepTypeKey || 'step';
  const parts = [type, endLabel(step)].filter(Boolean);
  const tgt = step.targetType?.workoutTargetTypeKey === 'pace.zone'
    ? paceTarget(step.targetValueOne, step.targetValueTwo)
    : null;
  if (tgt) parts.push(`@ ${tgt}`);
  // Fall back to Runna's own description only when no parsed pace target.
  else if (step.description) parts.push(`(${step.description})`);
  return parts.join(' ');
};

// steps_json is jsonb — `segments` arrives as a parsed array (or null).
const parseSteps = (segments) => {
  if (!Array.isArray(segments)) return null;
  try {
    // Runna-ical rows store steps as plain description lines (an array of
    // strings) rather than Garmin's segment structure — pass those through.
    if (segments.every((s) => typeof s === 'string')) {
      return segments.length ? segments : null;
    }
    const steps = segments.flatMap((s) => s.workoutSteps || []).map(stepStr);
    return steps.length ? steps : null;
  } catch {
    return null; // unexpected segment shape must not take the caller down
  }
};

async function buildContext(db) {
  const profileRow = await db.get(
    'SELECT shoes_json, races_json, injuries_json, routines_json, general_notes FROM profile WHERE id = 1'
  ) || {};
  const profile = {
    shoes: parseList(profileRow.shoes_json)
      .filter((s) => s && s.name)
      .map((s) => (s.purpose ? `${s.name} (${s.purpose})` : s.name)),
    races: parseList(profileRow.races_json)
      .filter((r) => r && (r.name || r.date))
      .map((r) => {
        const parts = [r.name || 'race'];
        if (r.date) parts.push(`on ${r.date}`);
        parts.push(r.goal_time ? `goal ${r.goal_time}` : 'no goal time (just running it)');
        return parts.join(' — ');
      }),
    injuries: parseList(profileRow.injuries_json).filter(Boolean),
    // Recurring non-Garmin-planned sessions (football, gym…). Cross-training
    // the coach should weigh against running load and recovery.
    routines: parseList(profileRow.routines_json)
      .filter((r) => r && r.activity)
      .map((r) => {
        let s = r.activity;
        if (r.day) s += ` every ${r.day}`;
        if (r.intensity != null) s += ` (intensity ${r.intensity}/10)`;
        return s;
      }),
    notes: profileRow.general_notes || null,
    // The user no longer specifies paces; the coach derives them from runs.
    pace_guidance: 'Paces are not user-provided — infer easy/threshold/5k/long-run paces from recent_runs.',
  };

  // --- Recent runs (last 14 days, runs only) ---
  const runRows = await db.all(
    `SELECT activity_id, start_time_local::date AS date, distance_m, duration_s, avg_hr,
            hr_zone1_s, hr_zone2_s, hr_zone3_s, hr_zone4_s, hr_zone5_s,
            activity_training_load, training_effect_label, aerobic_training_effect,
            elevation_gain_m
     FROM activities
     WHERE activity_group = 'run' AND distance_m > 0
       AND start_time_local >= $1
     ORDER BY start_time_local DESC`, [utcDate(-14)]);

  // All laps for the whole run set in ONE query (the old per-run lookup was a
  // fine prepared-statement loop under SQLite but an N+1 of awaits under pg).
  const lapRows = runRows.length ? await db.all(
    `SELECT activity_id, distance_m, duration_s, intensity_type
     FROM laps WHERE activity_id = ANY($1::bigint[])
     ORDER BY activity_id, lap_index`,
    [runRows.map((r) => r.activity_id)]) : [];
  const lapsByActivity = new Map();
  for (const l of lapRows) {
    if (!lapsByActivity.has(l.activity_id)) lapsByActivity.set(l.activity_id, []);
    lapsByActivity.get(l.activity_id).push(l);
  }

  const recent_runs = runRows.map((r) => {
    const km = +(r.distance_m / 1000).toFixed(2);
    const zoneMin = [r.hr_zone1_s, r.hr_zone2_s, r.hr_zone3_s, r.hr_zone4_s, r.hr_zone5_s]
      .map((s) => Math.round((s || 0) / 60));
    const run = {
      date: r.date,
      km,
      pace: pace(r.duration_s / km),
      avg_hr: r.avg_hr,
      hr_min_by_zone: zoneMin,
      load: r.activity_training_load != null ? Math.round(r.activity_training_load) : null,
      effect: r.training_effect_label,
      elev_m: r.elevation_gain_m != null ? Math.round(r.elevation_gain_m) : null,
    };
    if (km >= 10) run.note = 'long run';
    const wi = workIntervalSummary(lapsByActivity.get(r.activity_id) || []);
    if (wi) run.work_intervals = wi;
    return run;
  });

  // --- Recovery (last 14 days): latest snapshot + 14d trend averages ---
  const recRows = await db.all(
    `SELECT calendar_date, hrv_last_night, hrv_status,
            hrv_baseline_balanced_low, hrv_baseline_balanced_upper,
            resting_hr, sleep_score, readiness_score, readiness_level
     FROM recovery
     WHERE calendar_date >= $1
     ORDER BY calendar_date DESC`, [utcDate(-14)]);

  const avg = (key) => {
    const vals = recRows.map((r) => r[key]).filter((v) => v != null);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };

  const latest = recRows[0] || {};
  const recovery = {
    latest: {
      date: latest.calendar_date,
      hrv: latest.hrv_last_night,
      hrv_status: latest.hrv_status,
      hrv_baseline: [latest.hrv_baseline_balanced_low, latest.hrv_baseline_balanced_upper],
      resting_hr: latest.resting_hr,
      sleep_score: latest.sleep_score,
      readiness_score: latest.readiness_score,
      readiness_level: latest.readiness_level,
    },
    avg_14d: {
      hrv: avg('hrv_last_night'),
      resting_hr: avg('resting_hr'),
      sleep_score: avg('sleep_score'),
      readiness_score: avg('readiness_score'),
    },
  };

  // --- Upcoming planned workouts (next 14 days) ---
  // is_race_auto / is_race_override come along raw so collapseRaceDuplicates can
  // fold the same-day race triplicate (Runna race + manual override + pacer)
  // into one entry — otherwise the coach sees and counts the race three times.
  const planRows = await db.all(
    `SELECT calendar_date, title, estimated_distance_m, source,
            is_race_auto, is_race_override,
            COALESCE(is_race_override, is_race_auto) AS is_race, steps_json
     FROM planned_workouts
     WHERE calendar_date >= $1 AND calendar_date <= $2
     ORDER BY calendar_date`, [utcDate(0), utcDate(14)]);

  // App-plan precedence (an app row owns its date) before the race collapse.
  const upcoming = collapseRaceDuplicates(applyAppPlanPrecedence(planRows)).map((p) => ({
    date: p.calendar_date,
    title: p.title,
    km: p.estimated_distance_m ? +(p.estimated_distance_m / 1000).toFixed(2) : null,
    is_race: !!p.is_race,
    pacer_ready: !!p.pacer_available,
    steps: parseSteps(p.steps_json),
  }));

  // --- Weekly mileage (runs only), newest first ---
  // date_trunc('week') is ISO Monday-start, matching the old SQLite expression.
  const weekRows = await db.all(
    `SELECT to_char(date_trunc('week', start_time_local), 'YYYY-MM-DD') AS week_start,
            SUM(distance_m) AS m
     FROM activities
     WHERE activity_group = 'run' AND distance_m > 0 AND start_time_local IS NOT NULL
     GROUP BY week_start ORDER BY week_start DESC LIMIT 5`);
  const weekly_km = weekRows.map((w) => +(w.m / 1000).toFixed(1));

  // --- Derived signals + flags (computed here, not left to the model) ---
  const priorWeeks = weekly_km.slice(1);
  const priorAvg = priorWeeks.length
    ? +(priorWeeks.reduce((a, b) => a + b, 0) / priorWeeks.length).toFixed(1)
    : null;

  const flags = [];
  if (latest.hrv_last_night != null && latest.hrv_baseline_balanced_low != null &&
      latest.hrv_last_night < latest.hrv_baseline_balanced_low) {
    flags.push('HRV below baseline');
  }
  if (latest.hrv_status && latest.hrv_status !== 'BALANCED') {
    flags.push(`HRV status ${latest.hrv_status}`);
  }
  if (['LOW', 'POOR'].includes(latest.readiness_level)) {
    flags.push(`readiness ${latest.readiness_level}`);
  }
  if (recovery.avg_14d.readiness_score != null && latest.readiness_score != null &&
      latest.readiness_score < recovery.avg_14d.readiness_score - 10) {
    flags.push('readiness below 14d average');
  }
  if (priorAvg != null && weekly_km[0] > priorAvg * 1.3) {
    flags.push('weekly mileage spike vs prior weeks');
  }

  const signals = {
    current_week_km: weekly_km[0] ?? null,
    prior_weeks_km: priorWeeks,
    prior_weeks_avg_km: priorAvg,
    flags,
  };

  // --- Personal records (Garmin bests) + current race predictions ---
  // Compact strings so "goal: PB" is meaningful and the coach knows current
  // fitness. Time PRs as M:SS / H:MM:SS; Longest Run as km.
  const prRows = await db.all(
    'SELECT label, value, value_kind FROM personal_records ORDER BY type_id');
  const personal_records = prRows.map((r) =>
    r.value_kind === 'distance'
      ? `${r.label} ${+(r.value / 1000).toFixed(2)}km`
      : `${r.label} ${hms(r.value)}`
  );

  const predRow = await db.get(
    `SELECT calendar_date, time_5k_s, time_10k_s, time_half_s, time_marathon_s
     FROM race_predictions ORDER BY calendar_date DESC LIMIT 1`);
  const race_predictions = predRow
    ? {
        as_of: predRow.calendar_date,
        times: [
          `5K ${hms(predRow.time_5k_s)}`,
          `10K ${hms(predRow.time_10k_s)}`,
          `HM ${hms(predRow.time_half_s)}`,
          `Marathon ${hms(predRow.time_marathon_s)}`,
        ],
      }
    : null;

  return {
    // Day-granular on purpose: this object is injected as a cache_control'd
    // prompt block, so it must be byte-stable across calls — a per-call
    // timestamp here busts the prompt cache every request. The coach still
    // needs "today" to resolve relative dates ("Saturday").
    today: localDate(),
    window_days: 14,
    profile,
    recent_runs,
    recovery,
    upcoming,
    signals,
    personal_records,
    race_predictions,
  };
}

// Per-day focus for the on-demand day insight (Stage 6b). Returns the completed
// run and/or planned workout on `date` with a `kind`: 'completed' (a run was
// logged that day), 'planned' (only a plan, nothing run yet), or 'rest'. Reuses
// the same lap/step helpers as buildContext so the detail stays consistent.
async function buildDayFocus(db, date) {
  const actRow = await db.get(
    `SELECT activity_id, name, start_time_local::date AS date, distance_m, duration_s,
            avg_hr, max_hr, hr_zone1_s, hr_zone2_s, hr_zone3_s, hr_zone4_s, hr_zone5_s,
            avg_cadence_spm, avg_power, aerobic_training_effect, anaerobic_training_effect,
            training_effect_label, activity_training_load, elevation_gain_m
     FROM activities
     WHERE activity_group = 'run' AND distance_m > 0 AND start_time_local::date = $1
     ORDER BY start_time_local DESC LIMIT 1`, [date]);

  const planRow = await db.get(
    `SELECT title, estimated_distance_m,
            COALESCE(is_race_override, is_race_auto) AS is_race, steps_json
     FROM planned_workouts WHERE calendar_date = $1
     ORDER BY (source = 'app') DESC NULLS LAST LIMIT 1`, [date]);

  const planned = planRow ? {
    title: planRow.title,
    km: planRow.estimated_distance_m ? +(planRow.estimated_distance_m / 1000).toFixed(2) : null,
    is_race: !!planRow.is_race,
    steps: parseSteps(planRow.steps_json),
  } : null;

  // Recurring profile activity scheduled for this weekday, with its render-time
  // state resolved the same way the WeekStrip does: done if a matching
  // activity_group was logged, else missed (past) / expected (today or future).
  const profRow = await db.get('SELECT routines_json FROM profile WHERE id = 1') || {};
  const routineRow = parseList(profRow.routines_json)
    .find((r) => r && r.activity && r.day === dowOf(date));
  let routine = null;
  if (routineRow) {
    const group = routineGroup(routineRow.activity);
    const logged = await db.get(
      `SELECT name, distance_m, duration_s, avg_hr FROM activities
       WHERE activity_group = $1 AND start_time_local::date = $2
       ORDER BY start_time_local DESC LIMIT 1`, [group, date]);
    const today = localDate();
    routine = {
      activity: routineRow.activity,
      intensity: routineRow.intensity ?? null,
      group,
      state: logged ? 'done' : date < today ? 'missed' : 'expected',
      logged: logged
        ? { name: logged.name, km: logged.distance_m ? +(logged.distance_m / 1000).toFixed(2) : null,
            duration_s: logged.duration_s, avg_hr: logged.avg_hr }
        : null,
    };
  }

  if (actRow) {
    const km = +(actRow.distance_m / 1000).toFixed(2);
    const zoneMin = [actRow.hr_zone1_s, actRow.hr_zone2_s, actRow.hr_zone3_s, actRow.hr_zone4_s, actRow.hr_zone5_s]
      .map((s) => Math.round((s || 0) / 60));
    const laps = await db.all(
      'SELECT distance_m, duration_s, intensity_type FROM laps WHERE activity_id = $1 ORDER BY lap_index',
      [actRow.activity_id]);
    const run = {
      date: actRow.date,
      name: actRow.name,
      km,
      pace: pace(actRow.duration_s / km),
      avg_hr: actRow.avg_hr,
      max_hr: actRow.max_hr,
      hr_min_by_zone: zoneMin,
      avg_cadence_spm: actRow.avg_cadence_spm != null ? Math.round(actRow.avg_cadence_spm) : null,
      avg_power: actRow.avg_power != null ? Math.round(actRow.avg_power) : null,
      load: actRow.activity_training_load != null ? Math.round(actRow.activity_training_load) : null,
      effect: actRow.training_effect_label,
      aerobic_te: actRow.aerobic_training_effect,
      anaerobic_te: actRow.anaerobic_training_effect,
      elev_m: actRow.elevation_gain_m != null ? Math.round(actRow.elevation_gain_m) : null,
    };
    const wi = workIntervalSummary(laps);
    if (wi) run.work_intervals = wi;
    return { kind: 'completed', date, run, planned, routine };
  }

  if (planned) return { kind: 'planned', date, planned, routine };
  if (routine) return { kind: 'routine', date, routine };
  return { kind: 'rest', date };
}

// Priming prompt that tops the copy-context dump — frames the role for whichever
// external LLM the athlete pastes into (Claude, ChatGPT, etc.).
const DUMP_PREAMBLE =
  'You are my running coach and data analyst. Below is my current training data ' +
  'from Garmin — recent runs (with interval splits), recovery metrics, upcoming ' +
  'planned workouts, personal records, current race predictions, and my profile. ' +
  'Use it to answer my questions specifically, referencing real numbers. You ' +
  "don't prescribe full training plans (I use Runna for that), but you advise on " +
  "everything else. Here's my data:";

// Render the assembled context as a human/LLM-friendly text block (not JSON) for
// pasting into an external chat. Same content the coach gets, lightly prettified.
async function renderContextDump(db) {
  const c = await buildContext(db);
  const out = [DUMP_PREAMBLE, ''];
  const section = (title) => out.push('', `=== ${title} ===`);

  // --- Profile ---
  section('PROFILE');
  out.push(`Shoes: ${c.profile.shoes.length ? c.profile.shoes.join('; ') : '—'}`);
  out.push(`Races: ${c.profile.races.length ? c.profile.races.join(' | ') : '—'}`);
  out.push(`Injuries/constraints: ${c.profile.injuries.length ? c.profile.injuries.join('; ') : '—'}`);
  out.push(`Other regular activities: ${c.profile.routines.length ? c.profile.routines.join('; ') : '—'}`);
  if (c.profile.notes) out.push(`Notes: ${c.profile.notes}`);
  out.push(`Pace guidance: ${c.profile.pace_guidance}`);

  // --- Recent runs ---
  section(`RECENT RUNS (last ${c.window_days} days, runs only)`);
  if (!c.recent_runs.length) out.push('No runs in window.');
  c.recent_runs.forEach((r) => {
    const bits = [`${r.km}km @ ${r.pace}/km`];
    if (r.avg_hr != null) bits.push(`HR ${r.avg_hr}`);
    if (r.load != null) bits.push(`load ${r.load}`);
    if (r.effect) bits.push(r.effect);
    if (r.elev_m != null) bits.push(`+${r.elev_m}m`);
    if (r.note) bits.push(r.note);
    out.push(`${r.date} — ${bits.join(', ')}`);
    if (r.work_intervals) out.push(`    intervals: ${r.work_intervals}`);
  });

  // --- Recovery ---
  section('RECOVERY');
  const L = c.recovery.latest, A = c.recovery.avg_14d;
  const baseline = L.hrv_baseline && L.hrv_baseline[0] != null
    ? `, baseline ${L.hrv_baseline[0]}–${L.hrv_baseline[1]}` : '';
  out.push(
    `Latest (${L.date || '—'}): HRV ${L.hrv ?? '—'} (${L.hrv_status || '—'}${baseline}), ` +
    `resting HR ${L.resting_hr ?? '—'}, sleep ${L.sleep_score ?? '—'}, ` +
    `readiness ${L.readiness_score ?? '—'} (${L.readiness_level || '—'})`
  );
  out.push(
    `14-day avg: HRV ${A.hrv ?? '—'}, resting HR ${A.resting_hr ?? '—'}, ` +
    `sleep ${A.sleep_score ?? '—'}, readiness ${A.readiness_score ?? '—'}`
  );

  // --- Upcoming planned workouts ---
  section(`UPCOMING PLANNED WORKOUTS (next ${c.window_days} days)`);
  if (!c.upcoming.length) out.push('Nothing scheduled.');
  c.upcoming.forEach((p) => {
    const km = p.km != null ? ` — ${p.km}km` : '';
    const tags = `${p.is_race ? '  [RACE]' : ''}${p.pacer_ready ? '  [pacer ready]' : ''}`;
    out.push(`${p.date} — ${p.title || 'workout'}${km}${tags}`);
    if (p.steps && p.steps.length) out.push(`    steps: ${p.steps.join(' | ')}`);
  });

  // --- Signals ---
  section('SIGNALS');
  out.push(`Current week: ${c.signals.current_week_km ?? '—'}km`);
  if (c.signals.prior_weeks_km.length) out.push(`Prior weeks: ${c.signals.prior_weeks_km.join(', ')}km`);
  if (c.signals.prior_weeks_avg_km != null) out.push(`Prior weeks avg: ${c.signals.prior_weeks_avg_km}km`);
  out.push(`Flags: ${c.signals.flags.length ? c.signals.flags.join('; ') : 'none'}`);

  // --- Personal records ---
  section('PERSONAL RECORDS');
  out.push(c.personal_records.length ? c.personal_records.map((r) => `- ${r}`).join('\n') : '—');

  // --- Race predictions ---
  section('RACE PREDICTIONS');
  out.push(c.race_predictions
    ? `As of ${c.race_predictions.as_of}: ${c.race_predictions.times.join(', ')}`
    : '—');

  // Full timestamp is fine here — the dump is copy-paste text, never cached.
  out.push('', `(Context generated ${new Date().toISOString()}.)`);
  return out.join('\n');
}

// Planning-mode context (Stage 8). Wraps buildContext and augments it with the
// authoritative pace sources the composer needs: the LT-derived zone table
// (zones.js) and resolved goal paces (goalpaces.js), plus the guard bounds so
// the coach never emits a spec it knows will be rejected. Overrides the base
// pace_guidance (which says "infer paces from runs" — wrong in planning mode).
// `recentPushes` is the server's in-memory list of sessions pushed to Garmin
// this server session — they won't appear in `upcoming` until the next ingest,
// so they're surfaced separately to stop the coach double-booking them.
async function buildPlanningContext(db, recentPushes = []) {
  const context = await buildContext(db);

  const row = await db.get('SELECT lt_speed_mps, races_json FROM profile WHERE id = 1') || {};
  const records = await db.all('SELECT label, value, value_kind FROM personal_records');
  const races = parseList(row.races_json);
  const lt = row.lt_speed_mps;
  const lt_ready = !!lt;

  const zones = lt_ready ? computeZones(lt).map((z) => ({
    name: z.name,
    point: z.point.pace,                        // "M:SS" per km
    point_mps: +z.point.mps.toFixed(3),
    range: z.ceilingOnly
      ? { ceiling: z.range.fast.pace }          // easy: ceiling-only
      : { fast: z.range.fast.pace, slow: z.range.slow.pace },
  })) : null;

  const goal_paces = resolveGoalPaces(races, records).map((g) => ({
    name: g.name,
    date: g.date,
    distance: g.distance ? g.distance.key : null,
    goal_time: g.goalTimeSec != null ? hms(g.goalTimeSec) : null,
    goal_pace: g.goalPace ? g.goalPace.pace : null,
    source: g.source,                           // explicit | pb | none
    note: g.note,
  }));

  // OVERRIDE the base guidance: in planning the injected paces are authoritative.
  context.profile.pace_guidance = lt_ready
    ? 'Paces ARE provided in planning.zones and planning.goal_paces. Use those as the '
      + 'AUTHORITATIVE pace source when composing sessions. recent_runs is context for '
      + 'current fitness and fatigue only, NOT for deriving target paces.'
    : 'planning.lt_ready is false: no LT zone table is available. Fall back to inferring '
      + 'rough paces from recent_runs and race_predictions, tell the athlete the paces are '
      + 'estimated, and stay conservative.';

  context.planning = {
    lt_ready,
    lt_speed_mps: lt_ready ? +lt.toFixed(3) : null,
    lt_pace: lt_ready ? pace(1000 / lt) : null, // threshold point, "M:SS/km"
    zones,
    goal_paces,
    // Guard bounds surfaced so the coach never emits a spec it knows will be
    // rejected. Read from guard_bounds.json — the same file the enforcer
    // (ingest/pacer_cli.py) loads — and formatted for display here.
    guard: {
      pace_floor: `${pace(GUARD_BOUNDS.pace_floor_s)}/km`,
      pace_ceil: `${pace(GUARD_BOUNDS.pace_ceil_s)}/km`,
      total_dist_min_m: GUARD_BOUNDS.total_dist_min_m,
      total_dist_max_m: GUARD_BOUNDS.total_dist_max_m,
      warmcool_max_m: GUARD_BOUNDS.warmcool_max_m,
      rest_time_max_s: GUARD_BOUNDS.rest_time_max_s,
      rest_dist_max_m: GUARD_BOUNDS.rest_dist_max_m,
      segment_min_m: GUARD_BOUNDS.segment_min_m,
      max_steps: GUARD_BOUNDS.max_steps,
      // Negative-split shape: what strategy "negative" actually builds, so
      // the coach can pre-check the floor (tank segments run up to
      // tank_max_faster_s s/km faster than the block target).
      negative_split: {
        ramp_start_offset_s: GUARD_BOUNDS.negative_split.start_offset_s,
        tank_segments: GUARD_BOUNDS.negative_split.tank_segments,
        tank_max_faster_s:
          GUARD_BOUNDS.negative_split.tank_faster_step_s *
          GUARD_BOUNDS.negative_split.tank_segments,
        min_segments: GUARD_BOUNDS.negative_split.min_segments,
      },
    },
    // Sessions pushed to Garmin this server session — not yet in `upcoming`
    // (the DB only learns about them on the next ingest). Never double-book.
    pushed_recently: recentPushes,
  };
  return context;
}

// Compact scheduled-workout summary for a date range — powers the coach's
// on-demand get_scheduled_workouts tool (coach.js). Reads planned_workouts
// (the Runna calendar sync) and returns one line per workout plus its parsed
// steps, using the same step formatting as `upcoming`. Same-day race
// duplicates are collapsed so a race is listed once. Clearly labelled as
// upcoming/not-yet-completed so the model never mistakes it for history.
async function scheduledSummary(db, from, to) {
  const rows = await db.all(
    `SELECT calendar_date, title, estimated_distance_m, source,
            is_race_auto, is_race_override,
            COALESCE(is_race_override, is_race_auto) AS is_race, steps_json
     FROM planned_workouts
     WHERE calendar_date >= $1 AND calendar_date <= $2
     ORDER BY calendar_date`, [from, to]);
  const items = collapseRaceDuplicates(applyAppPlanPrecedence(rows));
  if (!items.length) return `No scheduled workouts between ${from} and ${to}.`;

  const lines = [`Scheduled workouts ${from} to ${to} (UPCOMING — not yet completed):`];
  for (const p of items) {
    const km = p.estimated_distance_m ? ` — ${+(p.estimated_distance_m / 1000).toFixed(2)}km` : '';
    const race = p.is_race ? '  [RACE]' : '';
    lines.push(`${p.calendar_date} — ${p.title || 'workout'}${km}${race}`);
    const steps = parseSteps(p.steps_json);
    if (steps && steps.length) lines.push(`    steps: ${steps.join(' | ')}`);
  }
  return lines.join('\n');
}

module.exports = { buildContext, buildPlanningContext, buildDayFocus, renderContextDump, scheduledSummary, localDate };
