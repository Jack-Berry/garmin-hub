// Formatting helpers. Units: distance in km, pace as min:sec/km, duration h:m:s.

export const km = (m) => (m == null ? '—' : `${(m / 1000).toFixed(2)} km`);

export const kmNum = (m) => (m == null ? null : +(m / 1000).toFixed(2));

// Pace from seconds-per-km, e.g. 312 → "5:12/km".
export const paceFromSecPerKm = (s) => {
  if (s == null || !isFinite(s) || s <= 0) return '—';
  const mins = Math.floor(s / 60);
  const secs = Math.round(s % 60);
  return `${mins}:${String(secs).padStart(2, '0')}/km`;
};

// Pace from a distance (m) + duration (s) pair.
export const secPerKm = (distance_m, duration_s) =>
  distance_m > 0 ? duration_s / (distance_m / 1000) : null;

export const pace = (distance_m, duration_s) =>
  paceFromSecPerKm(secPerKm(distance_m, duration_s));

// Pace from speed in m/s (used for laps / activity avg_speed_mps).
export const paceFromMps = (mps) => (mps > 0 ? paceFromSecPerKm(1000 / mps) : '—');

export const duration = (s) => {
  if (s == null) return '—';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

// Accepts "2026-06-28 17:06:33" or "2026-06-30".
export const shortDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d.replace(' ', 'T'));
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

// Date portion (YYYY-MM-DD) for matching activities to planned workouts.
export const dateOnly = (d) => (d ? d.slice(0, 10) : null);

export const todayISO = () => new Date().toISOString().slice(0, 10);

// Local YYYY-MM-DD for a Date (avoids the UTC shift of toISOString in week math).
export const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Coarse activity_group for a free-text routine name, mirroring ingest's
// derivation so a logged Garmin activity can match a planned recurring one.
export const routineGroup = (name) => {
  const s = (name || '').toLowerCase();
  if (/football|soccer/.test(s)) return 'football';
  if (/walk/.test(s)) return 'walk';
  if (/run/.test(s)) return 'run';
  return 'other';
};
