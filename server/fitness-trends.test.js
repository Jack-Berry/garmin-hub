const assert = require('node:assert/strict');
const test = require('node:test');
const { buildFitnessSeries, nextRace } = require('./fitness-trends');
const { sectionTrainingLoad } = require('./context');

const shift = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

test('fitness series warms from prior year and treats missing days as zero load', () => {
  const today = '2026-10-15';
  const rows = Array.from({ length: 366 }, (_, i) => ({ date: shift(today, i - 365), load: 100 }));
  rows.push({ date: shift(today, -2), load: 100 });
  const result = buildFitnessSeries(rows, today, 3);
  assert.equal(result.length, 3);
  assert.ok(result[0].ctl > 90);
  assert.ok(result[1].atl < result[0].atl);
  assert.equal(result[2].date, today);
});

test('fitness output is byte stable for the same input', () => {
  const rows = [{ date: '2026-10-14', load: 42 }];
  assert.equal(JSON.stringify(buildFitnessSeries(rows, '2026-10-15', 30)), JSON.stringify(buildFitnessSeries(rows, '2026-10-15', 30)));
  assert.deepEqual(buildFitnessSeries([], '2026-10-15', 30), []);
});

test('coach training-load context keeps its compact legacy shape', async () => {
  const db = { all: async () => [{ date: '2026-10-15', load: 100 }] };
  const first = await sectionTrainingLoad(db, '2026-10-15');
  const second = await sectionTrainingLoad(db, '2026-10-15');
  assert.deepEqual(Object.keys(first), ['method', 'today', 'trend_8w']);
  assert.equal(JSON.stringify(first).length, JSON.stringify(second).length);
  assert.equal(JSON.stringify(first).length, 610);
  assert.equal('series' in first, false);
});

test('countdown chooses the next valid future race and resolves goal and prediction', () => {
  const result = nextRace(
    [
      { name: 'Past 5K', date: '2026-10-01', goal_time: 'Sub 20' },
      { name: 'Autumn Half', date: '2026-11-15', goal_time: 'Sub 90' },
      { name: 'Bad date', date: '2026-99-99', goal_time: 'Sub 20' },
    ],
    [],
    [{ calendar_date: '2026-10-14', time_half_s: 5580 }],
    '2026-10-15',
  );
  assert.equal(result.name, 'Autumn Half');
  assert.equal(result.days_to_go, 31);
  assert.equal(result.goal.display, '1:30:00');
  assert.equal(result.prediction.display, '1:33:00');
});
