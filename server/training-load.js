const DAY_MS = 86400000;
const shiftDate = (value, days) => {
  const date = new Date(`${value}T00:00:00Z`);
  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10);
};

function computeTrainingLoad(rows, today, days = 120, options = {}) {
  const byDate = new Map();
  for (const row of rows) {
    if (!row.date || row.load == null || !Number.isFinite(Number(row.load))) continue;
    byDate.set(row.date, (byDate.get(row.date) || 0) + Number(row.load));
  }
  const alphaCtl = 1 / 42;
  const alphaAtl = 1 / 7;
  let ctl = 0;
  let atl = 0;
  const warmupDays = Number(options.warmupDays) || 0;
  const firstDate = shiftDate(today, -(days + warmupDays - 1));
  const daily = [];
  for (let date = firstDate; date <= today; date = shiftDate(date, 1)) {
    const load = byDate.get(date) || 0;
    ctl += alphaCtl * (load - ctl);
    atl += alphaAtl * (load - atl);
    daily.push({ date, ctl, atl, tsb: ctl - atl });
  }
  const point = (row) => ({
    date: row.date,
    ctl: +row.ctl.toFixed(1),
    atl: +row.atl.toFixed(1),
    tsb: +row.tsb.toFixed(1),
  });
  const visible = daily.slice(warmupDays);
  const byDay = new Map(visible.map((row) => [row.date, row]));
  const result = {
    method: 'Derived from daily summed Garmin activity training load using 42 day CTL and 7 day ATL EWMAs with 1/42 and 1/7 daily weighting; TSB = CTL - ATL.',
    today: point(visible.at(-1)),
    trend_8w: Array.from({ length: 8 }, (_, index) =>
      byDay.get(shiftDate(today, -7 * (7 - index))) || null)
      .filter(Boolean).map(point),
  };
  if (options.includeSeries) result.series = visible.map(point);
  return result;
}

module.exports = { computeTrainingLoad };
