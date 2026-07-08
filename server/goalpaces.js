// Goal / target paces — where the athlete is trying to get TO.
//
// Companion to server/zones.js. zones.js gives current-fitness zones from LT;
// this gives goal paces from the profile's upcoming-races list, so the coach can
// push beyond current fitness on sharp sessions (e.g. 4:00/km for a Sub-20 5k).
// The two stay separate and pure: LT zones know nothing about goals; this knows
// nothing about LT. Everything is m/s internally (pacer/Garmin convention);
// pace/time strings are display-only.
//
// Reads two profile sources (passed in — DB access lives only in the harness):
//   races_json        [{name, date, goal_time}]  — the upcoming races
//   personal_records  rows with {label, value, value_kind} — Garmin PBs
//
// Preview the live table:  node server/goalpaces.js

// ===========================================================================
// CONSTANTS — the only numbers/patterns to tune. Logic below derives from these.
// ===========================================================================

// Distance definitions, ORDERED most-specific first (half before marathon, so
// "half marathon" resolves to half). Each: a boundary-aware regex that
// identifies it in a lowercased race name, its length in metres, and the
// personal_records.label to use when the goal is "PB". parkrun folds into 5k.
// The digit lookbehinds stop "15k" matching 5k, "21k" matching 1k, and
// "10 mile" matching the mile.
const DISTANCES = [
  { key: 'half',     metres: 21097.5, pbLabel: 'Half Marathon', re: /half/ },
  { key: 'marathon', metres: 42195,   pbLabel: 'Marathon',      re: /marathon/ },
  { key: '10k',      metres: 10000,   pbLabel: '10K',           re: /(?<![\d.])10\s?km?\b/ },
  { key: '5k',       metres: 5000,    pbLabel: '5K',            re: /(?<![\d.])5\s?km?\b|parkrun/ },
  { key: 'mile',     metres: 1609.34, pbLabel: '1 mile',        re: /(?<!\d[\s-])(?<!\d)mile/ },
  { key: '1k',       metres: 1000,    pbLabel: '1 km',          re: /(?<![\d.])1\s?km?\b/ },
];

// Goal-parsing vocabulary. Prefix words that mean "this time or faster" are
// stripped before we look for the time token. PB_TOKEN means "match/beat my
// current PB". BLANK_GOALS (plus empty/missing) mean no real target — skip.
const GOAL_KEYWORDS = ['sub', 'under', 'below', 'beat'];
const PB_TOKEN = 'pb';
const BLANK_GOALS = ['', 'just running it', 'just running', 'fun', 'fun run', 'n/a', 'none'];

// A bare number in a goal ("Sub 20") means whole MINUTES, not seconds.
const BARE_NUMBER_UNIT_S = 60;

// ===========================================================================
// Derived logic — no magic numbers below this line.
// ===========================================================================

const paceStr = (secPerKm) => {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
};

const timeStr = (sec) => {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

// A time token ("45:00", "1:23:45", "20") -> seconds. Bare number = minutes.
const parseTime = (tok) => {
  if (tok.includes(':')) {
    const p = tok.split(':').map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  }
  return Number(tok) * BARE_NUMBER_UNIT_S;
};

// Two-part times and bare numbers are ambiguous: "3:30" means 3h30 for a
// marathon but 3m30 for a 1k, and "sub 3" means 3 hours, not 3 minutes.
// parseTime parses small-first; once the distance is known, rescale ×60 (at
// most twice) while the implied pace is faster than any plausible human pace
// (the pacer guard's floor).
const MIN_PLAUSIBLE_PACE_S = require('../ingest/guard_bounds.json').pace_floor_s;
const rescaleTime = (sec, metres) => {
  for (let i = 0; i < 2 && sec / (metres / 1000) < MIN_PLAUSIBLE_PACE_S; i++) sec *= 60;
  return sec;
};

// Free-ish goal text -> {kind, timeSec?, reason?}. kind: explicit | pb | none.
function parseGoal(raw) {
  const g = (raw || '').trim().toLowerCase();
  if (!g || BLANK_GOALS.includes(g)) return { kind: 'none', reason: 'no goal set' };
  if (g === PB_TOKEN) return { kind: 'pb' };
  let body = g;
  for (const kw of GOAL_KEYWORDS) body = body.split(kw).join(' ');
  const m = body.match(/\d+:\d{2}(?::\d{2})?|\d+/);
  if (!m) return { kind: 'none', reason: `unrecognised goal "${raw}"` };
  return { kind: 'explicit', timeSec: parseTime(m[0]) };
}

// Race name -> its distance definition, or null if none can be inferred.
const inferDistance = (name) => {
  const n = (name || '').toLowerCase();
  return DISTANCES.find((d) => d.re.test(n)) || null;
};

// personal_records rows -> { label: seconds } for the time-valued PBs.
const pbMap = (records) => {
  const map = {};
  for (const r of records || []) if (r.value_kind === 'time') map[r.label] = r.value;
  return map;
};

function resolveRace(race, pbs) {
  const goal = parseGoal(race.goal_time);
  const dist = inferDistance(race.name);
  const out = {
    name: race.name,
    date: race.date || null,
    distance: dist ? { key: dist.key, metres: dist.metres } : null,
    goalTimeSec: null,
    goalPace: null,
    source: goal.kind, // 'explicit' | 'pb' | 'none' — how firm the target is
    note: '',
  };

  if (goal.kind === 'none') {
    out.note = goal.reason;
    return out;
  }
  if (!dist) {
    // Explicit time is still known even if we can't turn it into a pace.
    if (goal.kind === 'explicit') out.goalTimeSec = goal.timeSec;
    out.note = "couldn't infer distance from name";
    return out;
  }

  if (goal.kind === 'explicit') {
    // Distance is known here, so ambiguous "3:30" / "sub 3" can be rescaled
    // to hours if the minutes reading implies an impossible pace.
    out.goalTimeSec = rescaleTime(goal.timeSec, dist.metres);
    out.note = 'explicit target';
  } else {
    const pb = pbs[dist.pbLabel];
    if (pb == null) {
      out.note = `no PB on record for ${dist.pbLabel}`;
      return out;
    }
    out.goalTimeSec = pb;
    out.note = `current ${dist.pbLabel} PB`;
  }

  const mps = dist.metres / out.goalTimeSec;
  out.goalPace = { mps, pace: paceStr(1000 / mps) };
  return out;
}

// races_json array + personal_records rows -> resolved goal per race.
const resolveGoalPaces = (races, records) => {
  const pbs = pbMap(records);
  return (races || []).map((r) => resolveRace(r, pbs));
};

// Scoped accessor: resolve just the goal for a named distance ("5k", "marathon"),
// via the SAME resolveRace path as the bulk resolver. Returns the per-race shape.
// No matching race -> a clean no-goal result (source none); no pace invented and
// no zone fallback — that decision is the coach's, not this module's.
const goalForDistance = (races, records, distanceKey) => {
  const race = (races || []).find((r) => {
    const d = inferDistance(r.name);
    return d && d.key === distanceKey;
  });
  if (race) return resolveRace(race, pbMap(records));

  const dist = DISTANCES.find((d) => d.key === distanceKey);
  return {
    name: null,
    date: null,
    distance: dist ? { key: dist.key, metres: dist.metres } : null,
    goalTimeSec: null,
    goalPace: null,
    source: 'none',
    note: `no goal on record for ${distanceKey}`,
  };
};

module.exports = { resolveGoalPaces, goalForDistance, DISTANCES };

// ===========================================================================
// Test harness — `node server/goalpaces.js` prints every profile race with its
// resolved goal. Preview only; nothing consumes this module yet.
// ===========================================================================
if (require.main === module) {
  (async () => {
  const { db } = require('./db');
  const prof = await db.get('SELECT races_json FROM profile WHERE id = 1');
  const races = Array.isArray(prof?.races_json) ? prof.races_json : [];
  const records = await db.all('SELECT label, value, value_kind FROM personal_records');

  const resolved = resolveGoalPaces(races, records);
  const pad = (s, n) => String(s).padEnd(n);
  console.log('');
  console.log('BULK — resolveGoalPaces (all profile races)');
  console.log(pad('RACE', 18) + pad('DATE', 12) + pad('DIST', 6) +
    pad('GOAL', 9) + pad('PACE', 10) + 'SOURCE / NOTE');
  console.log('-'.repeat(80));
  for (const r of resolved) {
    console.log(
      pad(r.name, 18) +
      pad(r.date || '—', 12) +
      pad(r.distance ? r.distance.key : '?', 6) +
      pad(r.goalTimeSec != null ? timeStr(r.goalTimeSec) : '—', 9) +
      pad(r.goalPace ? `${r.goalPace.pace}/km` : '—', 10) +
      `${r.source} — ${r.note}`,
    );
  }

  console.log('\nSCOPED — goalForDistance (one distance on demand)');
  for (const key of ['5k', 'marathon']) {
    const g = goalForDistance(races, records, key);
    console.log(
      pad(`${key}:`, 10) +
      pad(g.goalTimeSec != null ? timeStr(g.goalTimeSec) : '—', 9) +
      pad(g.goalPace ? `${g.goalPace.pace}/km` : '—', 10) +
      `${g.source} — ${g.note}`,
    );
  }
  console.log('');
  await db.end();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
