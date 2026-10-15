const DAY_MS = 86400000;
const ACWR_LIMIT = 1.3;
const TSB_LIMIT = -20;
const RACE_WINDOW_DAYS = 7;
const HRV_STREAK_DAYS = 3;

const daysBetween = (from, to) =>
  Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / DAY_MS);

const datedIssue = (item) => {
  const text = typeof item === 'string' ? item : JSON.stringify(item || {});
  const date = (typeof item === 'object' && item?.date) || text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  const lower = text.toLowerCase();
  if (!/(injur|niggle|pain|sore|ache|strain)/.test(lower) || !date) return null;
  const body = lower.match(/\b(knee|calf|shin|ankle|foot|heel|hamstring|quad|hip|back|achilles|groin)\b/)?.[1];
  return body ? { key: body, date } : null;
};

function deriveRiskWarnings({ today, recovery = {}, training_load = {}, upcoming = [], profile = {}, coach_memory = [] }) {
  const warnings = [];
  const ratio = Number(recovery.latest?.acwr?.ratio);
  if (Number.isFinite(ratio) && ratio > ACWR_LIMIT) {
    warnings.push({ code: 'acwr', title: 'Load spike', detail: `ACWR is ${ratio.toFixed(2)}, above ${ACWR_LIMIT}.` });
  }

  const recent = (recovery.last_7_days || []).filter((row) => row?.date && row.hrv != null);
  const baselineLow = Number(recovery.latest?.hrv_baseline?.[0]);
  const below = Number.isFinite(baselineLow) && recent.slice(0, HRV_STREAK_DAYS).length === HRV_STREAK_DAYS
    && recent.slice(0, HRV_STREAK_DAYS).every((row) => Number(row.hrv) < baselineLow);
  const chronological = recent.slice(0, HRV_STREAK_DAYS).reverse();
  const falling = chronological.length === HRV_STREAK_DAYS
    && chronological.every((row, index) => index === 0 || Number(row.hrv) < Number(chronological[index - 1].hrv));
  if (below || falling) {
    warnings.push({
      code: 'hrv_streak', title: 'HRV trend',
      detail: below
        ? `HRV has been below the ${baselineLow} ms baseline floor for ${HRV_STREAK_DAYS} consecutive recorded days.`
        : `HRV has fallen for ${HRV_STREAK_DAYS} consecutive recorded days.`,
    });
  }

  const tsb = Number(training_load.today?.tsb);
  const race = upcoming.find((item) => item?.is_race && daysBetween(today, item.date) >= 0
    && daysBetween(today, item.date) <= RACE_WINDOW_DAYS);
  if (race && Number.isFinite(tsb) && tsb < TSB_LIMIT) {
    warnings.push({ code: 'race_fatigue', title: 'Fatigue before race', detail: `TSB is ${tsb.toFixed(1)} with ${race.title || 'a race'} on ${race.date}.` });
  }

  const mentions = [...(profile.injuries || []), ...(coach_memory || [])]
    .map(datedIssue).filter(Boolean);
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

module.exports = { deriveRiskWarnings, ACWR_LIMIT, TSB_LIMIT, RACE_WINDOW_DAYS, HRV_STREAK_DAYS };
