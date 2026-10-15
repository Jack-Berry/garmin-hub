const {
  collapseRaceDuplicates,
  applyAppPlanPrecedence,
  appGhostFilterSql,
  appGhostOverlaySql,
} = require('./planned');
const DAY_MS = 86400000;
const dateAt = (value) => new Date(`${value}T00:00:00Z`);
const isoDate = (date) => date.toISOString().slice(0, 10);
const shiftDate = (value, days) => isoDate(new Date(dateAt(value).getTime() + days * DAY_MS));
const dowOf = (date) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dateAt(date).getUTCDay()];
const mondayOf = (date) => shiftDate(date, -((dateAt(date).getUTCDay() + 6) % 7));
const pace = (seconds) => {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
};
const finite = (value) => value != null && Number.isFinite(Number(value));
const sum = (values) => values.reduce((total, value) => total + Number(value || 0), 0);
const word = (count, singular) => `${count} ${count === 1 ? singular : `${singular}s`}`;
const clampWeeks = (value, fallback, max) => {
  const number = Number(value);
  return Number.isInteger(number) ? Math.min(max, Math.max(1, number)) : fallback;
};
const PARTIAL_DISTANCE_RATIO = 0.7;
const HILLY_GAIN_PER_KM = 25;
const NON_STEADY_NAME = /race|parkrun|interval|tempo|threshold|fartlek|reps?|speed|track|progression/i;

const weekRows = (from, to) => {
  const first = mondayOf(from);
  const rows = [];
  for (let date = first; date <= to; date = shiftDate(date, 7)) rows.push(date);
  return rows;
};

const longRunDrift = (run, laps) => {
  const runKm = Number(run.distance_m || 0) / 1000;
  const zones = [run.hr_zone1_s, run.hr_zone2_s, run.hr_zone3_s, run.hr_zone4_s, run.hr_zone5_s];
  const recorded = sum(zones.filter(finite));
  const easyShare = recorded > 0 ? sum(zones.slice(0, 2)) / recorded : 0;
  const hilly = finite(run.elevation_gain_m) && runKm > 0
    && Number(run.elevation_gain_m) / runKm > HILLY_GAIN_PER_KM;
  const structured = new Set(laps.map((lap) => lap.intensity_type).filter(Boolean)).size > 1
    || laps.some((lap) => /interval|recovery|rest|warm|cool/i.test(lap.intensity_type || ''));
  if (runKm < 10 || easyShare < 0.7 || hilly || structured || NON_STEADY_NAME.test(run.name || '')) {
    return null;
  }
  const valid = laps.filter((lap) => finite(lap.distance_m) && Number(lap.distance_m) > 0
    && finite(lap.duration_s) && Number(lap.duration_s) > 0 && finite(lap.avg_hr) && Number(lap.avg_hr) > 0);
  const total = sum(valid.map((lap) => lap.distance_m));
  if (total < 10000) return null;
  const halves = [[], []];
  let covered = 0;
  for (const lap of valid) {
    halves[covered < total / 2 ? 0 : 1].push(lap);
    covered += Number(lap.distance_m);
  }
  const efficiency = (part) => {
    const seconds = sum(part.map((lap) => lap.duration_s));
    const speed = sum(part.map((lap) => {
      const lapSpeed = finite(lap.avg_grade_adjusted_speed_mps)
        ? Number(lap.avg_grade_adjusted_speed_mps)
        : Number(lap.distance_m) / Number(lap.duration_s);
      return lapSpeed * Number(lap.duration_s);
    })) / seconds;
    const hr = sum(part.map((lap) => Number(lap.avg_hr) * Number(lap.duration_s))) / seconds;
    return speed / hr;
  };
  if (!halves[0].length || !halves[1].length) return null;
  const first = efficiency(halves[0]);
  const second = efficiency(halves[1]);
  return first ? ((first - second) / first) * 100 : null;
};

async function trainingHistorySummary(db, input = {}, today) {
  const weeks = clampWeeks(input.weeks, 12, 52);
  const from = shiftDate(mondayOf(today), -(weeks - 1) * 7);
  const activities = await db.all(
    `SELECT activity_id, start_time_local::date AS date, name, distance_m, duration_s,
            avg_hr, avg_speed_mps, avg_grade_adjusted_speed_mps,
            hr_zone1_s, hr_zone2_s, hr_zone3_s, hr_zone4_s, hr_zone5_s,
            activity_training_load, elevation_gain_m
     FROM activities
     WHERE activity_group = 'run' AND start_time_local::date >= $1
       AND start_time_local::date <= $2
     ORDER BY start_time_local`, [from, today]);
  const laps = activities.length ? await db.all(
    `SELECT activity_id, lap_index, distance_m, duration_s, avg_hr,
            avg_grade_adjusted_speed_mps, intensity_type
     FROM laps WHERE activity_id = ANY($1::bigint[]) ORDER BY activity_id, lap_index`,
    [activities.map((row) => row.activity_id)]) : [];
  const races = await db.all(
    `SELECT p.calendar_date, COALESCE(gh.title, p.title) AS title,
            COALESCE(gh.estimated_distance_m, p.estimated_distance_m) AS estimated_distance_m,
            p.source, p.is_race_auto, p.is_race_override, pl.status AS plan_status
     FROM planned_workouts p LEFT JOIN plans pl ON pl.plan_id = p.plan_id
     ${appGhostOverlaySql(3)}
     WHERE p.calendar_date >= $1 AND p.calendar_date <= $2 AND p.removed_at IS NULL
       AND pl.status IS DISTINCT FROM 'draft'
       AND COALESCE(p.is_race_override, p.is_race_auto) = 1
       AND ${appGhostFilterSql(3)}
     ORDER BY p.calendar_date, p.schedule_id`, [from, today, today]);
  const lapsByActivity = new Map();
  for (const lap of laps) {
    if (!lapsByActivity.has(lap.activity_id)) lapsByActivity.set(lap.activity_id, []);
    lapsByActivity.get(lap.activity_id).push(lap);
  }

  const easyRuns = activities.filter((run) => {
    const zones = [run.hr_zone1_s, run.hr_zone2_s, run.hr_zone3_s, run.hr_zone4_s, run.hr_zone5_s];
    const recorded = sum(zones.filter(finite));
    return finite(run.avg_hr) && recorded > 0 && sum(zones.slice(0, 2)) / recorded >= 0.7;
  });
  const bandCounts = new Map();
  for (const run of easyRuns) {
    const band = Math.floor(Number(run.avg_hr) / 5) * 5;
    bandCounts.set(band, (bandCounts.get(band) || 0) + 1);
  }
  const comparisonBand = [...bandCounts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
  const grouped = new Map(weekRows(from, today).map((week) => [week, []]));
  for (const run of activities) {
    const week = mondayOf(run.date);
    if (!grouped.has(week)) grouped.set(week, []);
    grouped.get(week).push(run);
  }
  const raceByWeek = new Map();
  for (const race of collapseRaceDuplicates(applyAppPlanPrecedence(races, from))) {
    const week = mondayOf(race.calendar_date);
    if (!raceByWeek.has(week)) raceByWeek.set(week, []);
    raceByWeek.get(week).push(`${race.calendar_date} (${dowOf(race.calendar_date)}) ${race.title || 'race'}`);
  }

  const lines = [
    `Training history ${from} to ${today} (${weeks} weeks):`,
    'Intensity method: time in Garmin HR zones, easy = Z1+Z2, steady = Z3, hard = Z4+Z5; unknown zone time is omitted.',
    comparisonBand == null
      ? 'Aerobic efficiency method: unavailable because no run had at least 70% of recorded HR-zone time in Z1+Z2.'
      : `Aerobic efficiency method: average grade-adjusted pace for easy runs with average HR ${comparisonBand}-${comparisonBand + 4} bpm; ordinary average speed is the fallback when GAP is absent.`,
    'Approximate HR drift method: grade-adjusted speed-to-HR efficiency change from the first versus second distance half of lap data on steady easy or long runs of at least 10 km; races, structured sessions, and runs over 25 m climbing per km are excluded; positive means efficiency fell.',
  ];
  for (const [week, runs] of [...grouped].sort((a, b) => a[0].localeCompare(b[0]))) {
    const distance = sum(runs.map((run) => run.distance_m)) / 1000;
    const longest = runs.length ? Math.max(...runs.map((run) => Number(run.distance_m || 0))) / 1000 : 0;
    const zoneMinutes = (indexes) => {
      const values = runs.flatMap((run) => indexes
        .map((index) => run[`hr_zone${index}_s`]).filter(finite));
      return values.length ? Math.round(sum(values) / 60) : 'n/a';
    };
    const loadValues = runs.map((run) => run.activity_training_load).filter(finite);
    const comparable = comparisonBand == null ? [] : runs.filter((run) => {
      const band = Math.floor(Number(run.avg_hr) / 5) * 5;
      return easyRuns.includes(run) && band === comparisonBand;
    });
    const metres = sum(comparable.map((run) => run.distance_m));
    const gapSeconds = sum(comparable.map((run) => {
      const speed = Number(run.avg_grade_adjusted_speed_mps || run.avg_speed_mps || 0);
      return speed > 0 ? Number(run.distance_m) / speed : 0;
    }));
    const drifts = runs.map((run) => longRunDrift(run, lapsByActivity.get(run.activity_id) || [])).filter(finite);
    const efficiency = comparable.length < 2
      ? `insufficient (${word(comparable.length, 'qualifying run')})`
      : metres > 0 && gapSeconds > 0
        ? `${pace(gapSeconds / (metres / 1000))}/km (${word(comparable.length, 'run')})`
        : `n/a (${word(comparable.length, 'run')})`;
    const drift = drifts.length ? `${(sum(drifts) / drifts.length).toFixed(1)}%` : 'n/a';
    const load = loadValues.length ? Math.round(sum(loadValues)) : 'n/a';
    const raceText = raceByWeek.get(week)?.join('; ') || 'none';
    lines.push(`${week}: ${distance.toFixed(1)}km, ${word(runs.length, 'run')}, longest ${longest.toFixed(1)}km; HR-zone min easy/steady/hard ${zoneMinutes([1, 2])}/${zoneMinutes([3])}/${zoneMinutes([4, 5])}; load ${load}; aerobic efficiency ${efficiency}; long-run drift ${drift}; races ${raceText}.`);
  }
  return lines.join('\n');
}

async function planComplianceSummary(db, input = {}, today) {
  const weeks = clampWeeks(input.weeks, 4, 12);
  const currentMonday = mondayOf(today);
  const from = shiftDate(currentMonday, -7 * (weeks - (today === currentMonday ? 0 : 1)));
  const to = shiftDate(today, -1);
  const rows = await db.all(
    `SELECT p.calendar_date, COALESCE(gh.title, p.title) AS title,
            COALESCE(gh.estimated_distance_m, p.estimated_distance_m) AS estimated_distance_m,
            p.source,
            p.is_race_auto, p.is_race_override,
            COALESCE(p.is_race_override, p.is_race_auto) AS is_race,
            pl.status AS plan_status
     FROM planned_workouts p LEFT JOIN plans pl ON pl.plan_id = p.plan_id
     ${appGhostOverlaySql(3)}
     WHERE p.calendar_date >= $1 AND p.calendar_date <= $2 AND p.removed_at IS NULL
       AND pl.status IS DISTINCT FROM 'draft'
       AND ${appGhostFilterSql(3)}
     ORDER BY p.calendar_date, p.schedule_id`, [from, to, today]);
  const planned = collapseRaceDuplicates(applyAppPlanPrecedence(rows, from));
  const runs = await db.all(
    `SELECT activity_id, start_time_local::date AS date, name, distance_m
     FROM activities
     WHERE activity_group = 'run' AND start_time_local::date >= $1
       AND start_time_local::date <= $2
     ORDER BY start_time_local`, [from, to]);
  const byDate = new Map();
  for (const run of runs) {
    if (!byDate.has(run.date)) byDate.set(run.date, []);
    byDate.get(run.date).push(run);
  }

  // Matching is deliberately simple and auditable: same calendar day only,
  // then nearest planned distance, with each completed run used at most once.
  // The 70% partial threshold mirrors planDayStatus in the web week strip.
  const results = [];
  for (const session of planned) {
    const candidates = byDate.get(session.calendar_date) || [];
    let match = null;
    if (candidates.length) {
      match = candidates.slice().sort((a, b) => {
        if (!finite(session.estimated_distance_m)) return 0;
        return Math.abs(Number(a.distance_m) - Number(session.estimated_distance_m))
          - Math.abs(Number(b.distance_m) - Number(session.estimated_distance_m));
      })[0];
      byDate.set(session.calendar_date, candidates.filter((run) => run !== match));
    }
    const plannedKm = finite(session.estimated_distance_m) ? Number(session.estimated_distance_m) / 1000 : null;
    const doneKm = match && finite(match.distance_m) ? Number(match.distance_m) / 1000 : null;
    const status = !match ? 'missed'
      : plannedKm != null && doneKm < plannedKm * PARTIAL_DISTANCE_RATIO ? 'partial'
        : 'completed';
    results.push({
      date: session.calendar_date, title: session.title || 'workout', source: session.source,
      plannedKm, doneKm, status,
    });
  }
  for (const [date, extras] of byDate) {
    for (const run of extras) results.push({
      date, title: run.name || 'run', plannedKm: null,
      doneKm: finite(run.distance_m) ? Number(run.distance_m) / 1000 : null, status: 'extra',
    });
  }
  results.sort((a, b) => a.date.localeCompare(b.date) || a.status.localeCompare(b.status));
  const weekly = new Map();
  for (const row of results) {
    const week = mondayOf(row.date);
    if (!weekly.has(week)) weekly.set(week, { planned: 0, completed: 0 });
    if (row.status !== 'extra') weekly.get(week).planned++;
    if (row.status === 'completed') weekly.get(week).completed++;
  }
  const lines = [
    `Plan compliance ${from} to ${to} (${word(weeks, 'week')}; today is excluded until complete):`,
    'Match method: same calendar day, nearest planned distance, one completed run per planned session; under 70% of planned distance is partial.',
  ];
  for (const row of results) {
    const plannedDistance = row.plannedKm == null ? 'unknown' : `${row.plannedKm.toFixed(1)}km`;
    const doneDistance = row.doneKm == null ? 'unknown' : `${row.doneKm.toFixed(1)}km`;
    const source = row.status === 'extra' ? '' : ` [${row.source}]`;
    lines.push(`${row.date} (${dowOf(row.date)}): ${row.status} - ${row.title}${source}; planned ${plannedDistance}, done ${doneDistance}.`);
  }
  for (const [week, counts] of [...weekly].sort((a, b) => a[0].localeCompare(b[0]))) {
    const pct = counts.planned ? Math.round(100 * counts.completed / counts.planned) : null;
    lines.push(`${week} week: completion ${pct == null ? 'n/a' : `${pct}%`} (${counts.completed}/${counts.planned}).`);
  }
  return lines.join('\n');
}

module.exports = {
  longRunDrift,
  trainingHistorySummary,
  planComplianceSummary,
};
