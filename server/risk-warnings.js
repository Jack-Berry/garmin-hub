const DAY_MS = 86400000;
const ACWR_LIMIT = 1.3;
const TSB_LIMIT = -20;
const RACE_WINDOW_DAYS = 7;
const HRV_STREAK_DAYS = 3;
const NIGGLE_WINDOW_DAYS = 21;

const daysBetween = (from, to) =>
  Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY_MS);

const datedIssue = (item, today) => {
  const text = typeof item === 'string' ? item : JSON.stringify(item || {});
  const date = (typeof item === 'object' && item?.date) || text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  const lower = text.toLowerCase();
  const age = date ? daysBetween(date, today) : null;
  if (!date || age < 0 || age > NIGGLE_WINDOW_DAYS
      || /\b(resolved|no longer|fully recovered)\b/.test(lower)
      || !/\b(injur\w*|niggl\w*|pain(?:ful)?|sore(?:ness)?|aches?|achy|strain(?:ed)?|tight\w*)\b/.test(lower)) {
    return null;
  }
  const body = lower.match(/\b(knee|calf|shin|ankle|foot|heel|hamstring|quad|hip|achilles|groin|lower back)\b/)?.[1]
    || (/(?:\bback\s+(?:pain|spasm|ache|injur|niggl|sore|strain|tight))/.test(lower) ? 'back' : null);
  return body ? { key: body, date } : null;
};

function deriveRiskWarnings({ today, recovery = {}, training_load = {}, upcoming = [], profile = {}, coach_memory = [] }) {
  const warnings = [];
  const ratio = Number(recovery.latest?.acwr?.ratio);
  if (Number.isFinite(ratio) && ratio > ACWR_LIMIT) {
    warnings.push({ code: 'acwr', title: 'Load spike', detail: `ACWR is ${ratio.toFixed(2)}, above ${ACWR_LIMIT}.` });
  }

  const recent = (recovery.last_7_days || []).filter((row) => row?.date && row.hrv != null);
  const baselineValue = recovery.latest?.hrv_baseline?.[0];
  const baselineLow = baselineValue == null ? null : Number(baselineValue);
  const below = baselineLow != null && Number.isFinite(baselineLow)
    && recent.slice(0, HRV_STREAK_DAYS).length === HRV_STREAK_DAYS
    && recent.slice(0, HRV_STREAK_DAYS).every((row) => Number(row.hrv) < baselineLow);
  const chronological = recent.slice(0, HRV_STREAK_DAYS).reverse();
  const falling = chronological.length === HRV_STREAK_DAYS
    && chronological.every((row, index) => index === 0 || Number(row.hrv) < Number(chronological[index - 1].hrv));
  const oldest = Number(chronological[0]?.hrv);
  const newest = Number(chronological.at(-1)?.hrv);
  const materialFall = falling && oldest > 0 && ((oldest - newest) / oldest >= 0.1
    || (baselineLow != null && newest < baselineLow));
  if (below || materialFall) {
    warnings.push({
      code: 'hrv_streak', title: 'HRV trend',
      detail: below
        ? `HRV has been below the ${baselineLow} ms baseline floor for ${HRV_STREAK_DAYS} consecutive recorded days.`
        : `HRV has fallen for ${HRV_STREAK_DAYS} consecutive recorded days.`,
    });
  }

  const tsb = Number(training_load.today?.tsb);
  const plannedRaces = upcoming.filter((item) => item?.is_race
    && (!/\bpractice\b/i.test(item.title || '') || Number(item.is_race_override) === 1));
  const profileRaces = (profile.races || []).map((item) => {
    const text = typeof item === 'string' ? item : JSON.stringify(item || {});
    return { date: text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0], title: text, is_race: true };
  }).filter((item) => item.date && !/\bpractice\b/i.test(item.title));
  const race = [...plannedRaces, ...profileRaces].filter((item) => daysBetween(today, item.date) >= 0
    && daysBetween(today, item.date) <= RACE_WINDOW_DAYS)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (race && Number.isFinite(tsb) && tsb < TSB_LIMIT) {
    warnings.push({ code: 'race_fatigue', title: 'Fatigue before race', detail: `TSB is ${tsb.toFixed(1)} with ${race.title || 'a race'} on ${race.date}.` });
  }

  const mentions = [...(profile.injuries || []), ...(coach_memory || [])]
    .map((item) => datedIssue(item, today)).filter(Boolean);
  const datesByIssue = new Map();
  for (const mention of mentions) {
    if (!datesByIssue.has(mention.key)) datesByIssue.set(mention.key, new Set());
    datesByIssue.get(mention.key).add(mention.date);
  }
  for (const [issue, dates] of datesByIssue) {
    if (dates.size >= 2) warnings.push({
      code: 'repeated_niggle', title: 'Repeated niggle',
      detail: `${issue[0].toUpperCase()}${issue.slice(1)} symptoms were mentioned on ${dates.size} distinct days.`,
    });
  }
  return warnings;
}

module.exports = {
  deriveRiskWarnings, ACWR_LIMIT, TSB_LIMIT, RACE_WINDOW_DAYS, HRV_STREAK_DAYS,
  NIGGLE_WINDOW_DAYS,
};
