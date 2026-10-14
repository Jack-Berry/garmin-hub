const assert = require('node:assert/strict');
const test = require('node:test');
const { scheduleId } = require('./schedule-id');

test('schedule ids above 2^53 remain exact strings', () => {
  const id = '-1152921504606846975';
  assert.equal(scheduleId(id), id);
  assert.equal(typeof scheduleId(id), 'string');
  assert.equal(scheduleId('1.5'), null);
});
