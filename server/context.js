// Coaching context engine — assembles a compact, structured training summary
// from the DB for the AI coach. Summarises (never dumps) recent runs, recovery,
// upcoming planned workouts, the profile, and a few code-derived signals.
// Read-only: takes the shared read-only db connection.

// Profile lists are stored as JSON text; parse defensively.
const parseList = (s) => { try { return s ? JSON.parse(s) : []; } catch { return []; } };

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

const parseSteps = (stepsJson) => {
  if (!stepsJson) return null;
  try {
    const segments = JSON.parse(stepsJson);
    const steps = segments.flatMap((s) => s.workoutSteps || []).map(stepStr);
    return steps.length ? steps : null;
  } catch {
    return null;
  }
};

function buildContext(db) {
  const profileRow = db.prepare(
    'SELECT shoes_json, races_json, injuries_json, general_notes FROM profile WHERE id = 1'
  ).get() || {};
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
    notes: profileRow.general_notes || null,
    // The user no longer specifies paces; the coach derives them from runs.
    pace_guidance: 'Paces are not user-provided — infer easy/threshold/5k/long-run paces from recent_runs.',
  };

  // --- Recent runs (last 14 days, runs only) ---
  const runRows = db.prepare(
    `SELECT activity_id, date(start_time_local) AS date, distance_m, duration_s, avg_hr,
            hr_zone1_s, hr_zone2_s, hr_zone3_s, hr_zone4_s, hr_zone5_s,
            activity_training_load, training_effect_label, aerobic_training_effect,
            elevation_gain_m
     FROM activities
     WHERE activity_group = 'run' AND distance_m > 0
       AND start_time_local >= date('now', '-14 days')
     ORDER BY start_time_local DESC`
  ).all();

  const lapStmt = db.prepare(
    'SELECT distance_m, duration_s, intensity_type FROM laps WHERE activity_id = ? ORDER BY lap_index'
  );

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
    const wi = workIntervalSummary(lapStmt.all(r.activity_id));
    if (wi) run.work_intervals = wi;
    return run;
  });

  // --- Recovery (last 14 days): latest snapshot + 14d trend averages ---
  const recRows = db.prepare(
    `SELECT calendar_date, hrv_last_night, hrv_status,
            hrv_baseline_balanced_low, hrv_baseline_balanced_upper,
            resting_hr, sleep_score, readiness_score, readiness_level
     FROM recovery
     WHERE calendar_date >= date('now', '-14 days')
     ORDER BY calendar_date DESC`
  ).all();

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
  const planRows = db.prepare(
    `SELECT calendar_date, title, estimated_distance_m,
            COALESCE(is_race_override, is_race_auto) AS is_race, steps_json
     FROM planned_workouts
     WHERE calendar_date >= date('now') AND calendar_date <= date('now', '+14 days')
     ORDER BY calendar_date`
  ).all();

  const upcoming = planRows.map((p) => ({
    date: p.calendar_date,
    title: p.title,
    km: p.estimated_distance_m ? +(p.estimated_distance_m / 1000).toFixed(2) : null,
    is_race: !!p.is_race,
    steps: parseSteps(p.steps_json),
  }));

  // --- Weekly mileage (runs only), newest first ---
  const weekStart =
    "date(start_time_local, '-' || ((strftime('%w', start_time_local) + 6) % 7) || ' days')";
  const weekRows = db.prepare(
    `SELECT ${weekStart} AS week_start, SUM(distance_m) AS m
     FROM activities
     WHERE activity_group = 'run' AND distance_m > 0 AND start_time_local IS NOT NULL
     GROUP BY week_start ORDER BY week_start DESC LIMIT 5`
  ).all();
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
  const prRows = db.prepare(
    'SELECT label, value, value_kind FROM personal_records ORDER BY type_id'
  ).all();
  const personal_records = prRows.map((r) =>
    r.value_kind === 'distance'
      ? `${r.label} ${+(r.value / 1000).toFixed(2)}km`
      : `${r.label} ${hms(r.value)}`
  );

  const predRow = db.prepare(
    `SELECT calendar_date, time_5k_s, time_10k_s, time_half_s, time_marathon_s
     FROM race_predictions ORDER BY calendar_date DESC LIMIT 1`
  ).get();
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
    generated_at: new Date().toISOString(),
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
function renderContextDump(db) {
  const c = buildContext(db);
  const out = [DUMP_PREAMBLE, ''];
  const section = (title) => out.push('', `=== ${title} ===`);

  // --- Profile ---
  section('PROFILE');
  out.push(`Shoes: ${c.profile.shoes.length ? c.profile.shoes.join('; ') : '—'}`);
  out.push(`Races: ${c.profile.races.length ? c.profile.races.join(' | ') : '—'}`);
  out.push(`Injuries/constraints: ${c.profile.injuries.length ? c.profile.injuries.join('; ') : '—'}`);
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
    out.push(`${p.date} — ${p.title || 'workout'}${km}${p.is_race ? '  [RACE]' : ''}`);
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

  out.push('', `(Context generated ${c.generated_at}.)`);
  return out.join('\n');
}

module.exports = { buildContext, renderContextDump };
