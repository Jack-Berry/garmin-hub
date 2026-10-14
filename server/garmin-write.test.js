const assert = require('node:assert/strict');
const test = require('node:test');
const { pacerInput, createWriteGate } = require('./garmin-write');

test('push and reconcile identities are stable across object key order', () => {
  const a = pacerInput('push', { date: '2026-10-20', name: 'Tempo', blocks: [{ target: '4:00', length_m: 1000 }] });
  const b = pacerInput('push', { blocks: [{ length_m: 1000, target: '4:00' }], name: 'Tempo', date: '2026-10-20' });
  assert.equal(a._idempotency_key, b._idempotency_key);
  assert.equal(pacerInput('preview', a), a);
  assert.notEqual(
    pacerInput('reconcile', { op: 'move', workout_id: 1, to_date: '2026-10-21' })._idempotency_key,
    pacerInput('reconcile', { op: 'move', workout_id: 1, to_date: '2026-10-22' })._idempotency_key,
  );
});

test('one shared gate rejects a concurrent push-next or reconcile', async () => {
  const gate = createWriteGate();
  assert.equal(gate.enter(), true);
  assert.equal(gate.enter(), false);
  gate.leave();
  assert.equal(gate.enter(), true);
  gate.leave();
});
