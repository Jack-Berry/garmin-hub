import assert from 'node:assert/strict';
import test from 'node:test';
import { isAppleActivity } from './activitySource.js';

test('Apple Watch label is limited to Apple Health activities', () => {
  assert.equal(isAppleActivity('apple_health'), true);
  assert.equal(isAppleActivity('garmin'), false);
  assert.equal(isAppleActivity(undefined), false);
});
