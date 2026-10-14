const exactDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value : null;
};

const planFinished = (goalRace, dateTo, today) => {
  const match = String(goalRace || '').match(/\d{4}-\d{2}-\d{2}/);
  return (exactDate(match?.[0]) || dateTo) < today;
};

module.exports = { exactDate, planFinished };
