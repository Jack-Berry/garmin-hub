// Planned-workout shaping shared by the /api/planned endpoint and the coach
// context engine. Its job: collapse the duplicate race entries that pile up on
// a single date — Runna's own race, my manual race-override of it, and the Engo
// pacer workout pushed for it — into one display row, so the dashboard (and the
// coach) see the race once instead of three times.

// Engo pacers are pushed by pacer_cli.py titled "… Pacer".
const isPacer = (r) => /pacer/i.test(r.title || '');

// Effective race status: a forced override wins, else Runna's auto flag.
const isRaceFlagged = (r) =>
  r.is_race_override === 1 || (r.is_race_override == null && r.is_race_auto === 1);

// Which entry survives a collapsed group (lower wins): a manual race-override is
// my explicit intent, then Runna's auto-detected race, then the pacer, then any
// other straggler that shared the date+distance.
const survivorRank = (r) =>
  r.is_race_override === 1 ? 0 : r.is_race_auto === 1 ? 1 : isPacer(r) ? 2 : 3;

// Collapse same-date + same-distance groups that contain a race into one row.
// Conservative: only groups of 2+ that share an exact date AND rounded distance
// AND have at least one race-flagged member collapse — distinct workouts that
// merely share a date are left alone. The survivor keeps all its own fields and
// gains `pacer_available: true` when a pacer was among the entries it absorbed,
// so the "pacer ready" signal isn't silently dropped. Input order is preserved.
function collapseRaceDuplicates(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (r.estimated_distance_m == null) continue; // no distance → never grouped
    const key = `${r.calendar_date}|${Math.round(r.estimated_distance_m)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const drop = new Set();
  const pacerSurvivors = new Set();
  for (const g of groups.values()) {
    if (g.length < 2 || !g.some(isRaceFlagged)) continue;
    const survivor = g.slice().sort((a, b) => survivorRank(a) - survivorRank(b))[0];
    for (const r of g) if (r !== survivor) drop.add(r);
    if (g.some(isPacer)) pacerSurvivors.add(survivor);
  }

  return rows
    .filter((r) => !drop.has(r))
    .map((r) => (pacerSurvivors.has(r) ? { ...r, pacer_available: true } : r));
}

// Local wall-clock YYYY-MM-DD (same semantics as context.js localDate).
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// App-plan precedence (Stage 9a, tightened in 9d-2): when the app owns a
// session on a date, the app plan is the source of truth for that WHOLE date —
// upcoming garmin/runna_ical rows on it are dropped (by date, not
// per-workout-type, so an app plan supersedes overlapping Runna dates
// outright). Past dates are never touched: history stays whatever was actually
// prescribed.
//
// "Owns" is gated on plan status (9d-2): only rows that are actually live on
// the calendar suppress — the ACTIVE plan's sessions, and one-off pushes
// (plan_id NULL, which only exist after a Garmin push). A draft is dormant and
// suppresses nothing (Runna stays the real plan until activation); completed/
// archived plans are history, not a claim on future dates. Rows must carry
// `source`, `calendar_date` ('YYYY-MM-DD' strings via the db.js parsers, so
// plain string comparison orders correctly) and `plan_status` (plans.status
// via LEFT JOIN; NULL for one-off pushes — a row missing the field entirely
// degrades to the pre-9d-2 always-suppress behaviour).
const appRowLive = (r) =>
  r.source === 'app' && (r.plan_status == null || r.plan_status === 'active');

function applyAppPlanPrecedence(rows, today = localToday()) {
  const appDates = new Set(rows.filter(appRowLive).map((r) => r.calendar_date));
  if (!appDates.size) return rows;
  return rows.filter((r) =>
    r.source === 'app' || r.calendar_date < today || !appDates.has(r.calendar_date));
}

module.exports = { collapseRaceDuplicates, applyAppPlanPrecedence };
