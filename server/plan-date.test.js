const assert = require('node:assert/strict');
const test = require('node:test');
const { exactDate, planFinished } = require('./plan-date');

test('malformed goal-race dates fall back without throwing', () => {
  for (const value of ['race 2026-02-30', '2026-13-45', '9999-99-99']) {
    assert.doesNotThrow(() => planFinished(value, '2026-10-20', '2026-10-21'));
    assert.equal(planFinished(value, '2026-10-20', '2026-10-21'), true);
  }
  assert.equal(exactDate('2026-02-30'), null);
  assert.equal(planFinished('race 2026-11-01', '2026-10-20', '2026-10-21'), false);
});
