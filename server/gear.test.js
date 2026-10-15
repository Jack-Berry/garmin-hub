const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { heatAdjustment, createGearRouter } = require('./gear');

test('heat adjustment follows the published temperature plus dew point bands', () => {
  assert.equal(heatAdjustment(300, 10, 5).slowdown_pct, 0);
  const hot = heatAdjustment(300, 25, 20);
  assert.equal(hot.temperature_dew_point_sum_f, 145);
  assert.equal(hot.slowdown_pct, 4.5);
  assert.equal(hot.cool_equivalent_pace_s_per_km, 287);
  assert.equal(heatAdjustment(300, null, 20), null);
});

test('gear endpoint uses Garmin mileage and exact normalised profile name matching', async (t) => {
  const db = {
    all: async () => [{
      gear_uuid: 'shoe-1', display_name: 'ASICS Superblast 3', retired: false,
      garmin_total_distance_m: 650000, summed_run_distance_m: 642000, runs: 82,
      first_used: '2026-01-02', last_used: '2026-10-12',
    }],
    get: async () => ({
      shoes_json: [{ name: 'asics superblast 3', purpose: 'Daily', mileage_alert_km: 600 }],
    }),
  };
  const app = express();
  app.use('/api/gear', createGearRouter({ db }));
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/gear`);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.items[0].mileage_alert, true);
  assert.equal(result.items[0].profile_shoe_name, 'asics superblast 3');
  assert.match(result.match_method, /Garmin gear remains/);
});
