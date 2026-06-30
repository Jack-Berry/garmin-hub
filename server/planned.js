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

module.exports = { collapseRaceDuplicates };
