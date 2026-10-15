import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionRefreshReason, compactMessages, restoredMode, restoreMessages,
} from './chatPersistence.js';

test('compacts plan preview segments while preserving review summaries and action state', () => {
  const messages = [
    { role: 'assistant', content: 'old', plan: { sessions: [{ preview: { total_distance_m: 5000, segments: [1] } }] } },
    { role: 'assistant', content: 'new', plan: { sessions: [{ preview: { total_distance_m: 8000, segments: [1, 2] } }] } },
    { role: 'assistant', content: 'pushed', preview: { total_distance_m: 5000, segments: [1] }, pushed: { id: 1 } },
  ];
  const compact = compactMessages(messages);
  assert.equal(compact[0].plan, undefined);
  assert.equal(compact[1].plan.sessions[0].preview.total_distance_m, 8000);
  assert.deepEqual(compact[1].plan.sessions[0].preview.segments, []);
  assert.deepEqual(compact[2].preview.segments, []);
  assert.deepEqual(compact[2].pushed, { id: 1 });
});

test('action refresh rejects stale revisions and every durable action flag', () => {
  const thread = { revision: 4, messages: [{ role: 'assistant', content: 'spec' }] };
  assert.equal(actionRefreshReason(thread, 0, 3), 'changed');
  assert.equal(actionRefreshReason(thread, 0, 4), null);
  for (const flag of ['pushed', 'applied', 'pushPending', 'actionPending', 'restoreBlocked']) {
    assert.equal(actionRefreshReason({ ...thread, messages: [{ ...thread.messages[0], [flag]: true }] }, 0, 4),
      'already handled', flag);
  }
});

test('restore converts transient action markers into a durable block', () => {
  const restored = restoreMessages([{ role: 'assistant', content: 'spec', pushPending: true }]);
  assert.equal(restored.interrupted, true);
  assert.equal(restored.messages[0].pushPending, undefined);
  assert.equal(restored.messages[0].restoreBlocked, true);
});

test('finished planning restores as chat without changing spec action state', () => {
  const messages = [
    { role: 'assistant', content: 'Session', spec: { name: 'Tempo' } },
    { role: 'user', content: '[complete]', system: true, planningEnded: true },
  ];
  assert.equal(restoredMode('planning', messages), 'chat');
  assert.equal(messages[0].pushed, undefined);
});
