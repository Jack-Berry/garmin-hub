// LT-anchored training zones.
//
// Knows ONLY lactate-threshold speed — nothing about race goals or PBs (that's a
// separate goal-pace module). Give it LT speed in m/s, get back the eight zones,
// each with a point pace and a derived band. Everything is in m/s internally
// (matches the pacer/Garmin convention); pace strings are for display only.
//
// The whole table derives from the CONSTANTS block below. Change a constant and
// everything re-derives — no paces or band offsets are hardcoded in the logic.
//
// Preview the live table:  node server/zones.js

// ===========================================================================
// CONSTANTS — the only numbers to tune. Logic below is fully derived from these.
// ===========================================================================

// Per-zone multiplier on LT speed (Daniels-ish, LT-anchored so threshold = 1.00).
// Ordered SLOW -> FAST; that order also defines each zone's neighbours, which set
// the band widths below.
const RATIOS = [
  { name: 'very_easy', ratio: 0.68 },
  { name: 'easy',      ratio: 0.74 },
  { name: 'steady',    ratio: 0.82 },
  { name: 'marathon',  ratio: 0.88 },
  { name: 'threshold', ratio: 1.00 },
  { name: 'tenk',      ratio: 1.03 },
  { name: 'fivek',     ratio: 1.07 },
  { name: 'rep',       ratio: 1.15 },
];

// Band edges as a fraction of the pace gap to the neighbouring zone. Asymmetric
// on purpose — tighter on the fast side: drifting slow just eases the rep,
// drifting fast blows the energy system.
const BAND_SLOW_FRAC = 0.35; // slow edge = this x gap to the next-SLOWER zone
const BAND_FAST_FRAC = 0.18; // fast edge = this x gap to the next-FASTER zone

// Clamps (seconds/km) so uneven zone spacing can't emit a silly-wide window
// (e.g. threshold's big gap down to marathon must not yield a +12s slow edge).
const BAND_SLOW_MAX_S = 8; // max slow-edge offset, s/km
const BAND_FAST_MAX_S = 6; // max fast-edge offset, s/km (also rep's fast fallback)

// ===========================================================================
// Derived logic — no magic numbers below this line.
// ===========================================================================

const mpsToPace = (mps) => 1000 / mps;           // m/s -> s/km
const paceToMps = (secPerKm) => 1000 / secPerKm; // s/km -> m/s
const clamp = (v, max) => Math.min(v, max);

const paceStr = (secPerKm) => {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
};

// A {mps, pace} readout from a speed in m/s.
const readout = (mps) => ({ mps, pace: paceStr(mpsToPace(mps)) });

// LT speed (m/s) -> array of eight zones, slow -> fast.
function computeZones(ltMps) {
  // Point speeds first (pure ratio x LT) so the band pass can see neighbours.
  const pts = RATIOS.map((z) => {
    const mps = ltMps * z.ratio;
    return { ...z, mps, paceS: mpsToPace(mps) };
  });

  return pts.map((z, i) => {
    const slower = pts[i - 1]; // next-slower zone (undefined for very_easy)
    const faster = pts[i + 1]; // next-faster zone (undefined for rep)

    // The slowest zone (very_easy, the recovery/shakeout target) is
    // ceiling-only: its point IS the "no faster than" limit, no slow edge.
    if (i === 0) {
      return {
        name: z.name,
        ratio: z.ratio,
        point: readout(z.mps),
        range: { slow: null, fast: readout(z.mps) },
        ceilingOnly: true,
      };
    }

    // Slow edge: fraction of the gap DOWN to the slower neighbour, clamped.
    const slowOff = clamp(BAND_SLOW_FRAC * (slower.paceS - z.paceS), BAND_SLOW_MAX_S);
    const slowPace = z.paceS + slowOff;

    // Fast edge: fraction of the gap UP to the faster neighbour, clamped.
    // Rep has no faster neighbour -> fall back to the fast clamp directly.
    const fastOff = faster
      ? clamp(BAND_FAST_FRAC * (z.paceS - faster.paceS), BAND_FAST_MAX_S)
      : BAND_FAST_MAX_S;
    const fastPace = z.paceS - fastOff;

    return {
      name: z.name,
      ratio: z.ratio,
      point: readout(z.mps),
      range: { slow: readout(paceToMps(slowPace)), fast: readout(paceToMps(fastPace)) },
      ceilingOnly: false,
    };
  });
}

module.exports = { computeZones, RATIOS };

// ===========================================================================
// Test harness — `node server/zones.js` prints the live table from the DB's
// current lt_speed_mps. Preview only; nothing consumes this module yet.
// ===========================================================================
if (require.main === module) {
  (async () => {
  const { db } = require('./db');
  const row = await db.get('SELECT lt_speed_mps FROM profile WHERE id = 1');
  const lt = row && row.lt_speed_mps;
  if (!lt) {
    console.error('No lt_speed_mps on profile — run ingest first.');
    process.exit(1);
  }

  const zones = computeZones(lt);
  console.log(`\nLT speed = ${lt.toFixed(3)} m/s  (${paceStr(mpsToPace(lt))}/km)\n`);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('ZONE', 11) + pad('ratio', 7) + pad('point', 9) + 'range (fast — slow)');
  console.log('-'.repeat(52));
  for (const z of zones) {
    const range = z.ceilingOnly
      ? `≤ ${z.range.fast.pace} (ceiling)`
      : `${z.range.fast.pace} — ${z.range.slow.pace}`;
    console.log(
      pad(z.name, 11) + pad(z.ratio.toFixed(2), 7) + pad(`${z.point.pace}/km`, 9) + range,
    );
  }
  console.log('');
  await db.end();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
