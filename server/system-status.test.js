const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { createHealthHandler, createStatusHandler } = require('./system-status');

const fixture = async (handler, route = '/api/status') => {
  const app = express();
  app.get(route, handler);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}${route}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const statusFixture = ({ now, ingest, brief, files = {}, dumpTime }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-status-'));
  const statusDir = path.join(root, 'status');
  const backupDir = path.join(root, 'backups');
  fs.mkdirSync(statusDir);
  fs.mkdirSync(backupDir);
  for (const [job, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(statusDir, `${job}.json`), JSON.stringify({ job, ...value }));
  }
  if (dumpTime) {
    const dump = path.join(backupDir, 'garminhub-test.dump');
    fs.writeFileSync(dump, 'dump');
    fs.utimesSync(dump, new Date(dumpTime), new Date(dumpTime));
  }
  const db = {
    get: async (sql) => sql.includes('ingest_state') ? ingest : brief,
  };
  return { db, statusDir, backupDir, now };
};

test('health reports database success and failure without details', async () => {
  for (const [database, expected] of [
    [{ get: async () => ({ ok: 1 }) }, 200],
    [{ get: async () => { throw new Error('secret database detail'); } }, 503],
  ]) {
    const app = await fixture(createHealthHandler(database, 20), '/api/health');
    try {
      const response = await fetch(app.url);
      assert.equal(response.status, expected);
      assert.deepEqual(await response.json(), { ok: expected === 200 });
    } finally { await app.close(); }
  }
});

test('status returns unknown checks when host files and dump are absent', async () => {
  const now = Date.parse('2026-07-01T08:00:00Z');
  const app = await fixture(createStatusHandler(statusFixture({ now, ingest: null, brief: null })));
  try {
    const body = await (await fetch(app.url)).json();
    assert.deepEqual(body.checks.map((check) => [check.name, check.state]), [
      ['ingest', 'unknown'], ['debrief', 'unknown'], ['brief', 'ok'], ['weekly', 'unknown'],
      ['backup', 'unknown'], ['offsite', 'unknown'],
    ]);
    assert.deepEqual(body.notifications, { enabled: false, reason: 'APNs is not configured' });
  } finally { await app.close(); }
});

test('status enforces failure and age thresholds', async () => {
  const now = Date.parse('2026-07-01T12:00:00Z');
  const fresh = new Date(now - 60 * 60 * 1000).toISOString();
  const app = await fixture(createStatusHandler(statusFixture({
    now,
    ingest: { last_run_at: new Date(now - 7 * 60 * 60 * 1000).toISOString(), ok: true, summary: 'ok' },
    brief: { created_at: fresh },
    dumpTime: now - 27 * 60 * 60 * 1000,
    files: {
      ingest: { ok: true, finished_at: fresh, message: 'exit 0' },
      backup: { ok: true, finished_at: fresh, message: 'exit 0' },
      offsite: { ok: false, finished_at: fresh, message: 'rsync failed' },
    },
  })));
  try {
    const checks = Object.fromEntries((await (await fetch(app.url)).json()).checks.map((check) => [check.name, check]));
    assert.match(checks.ingest.reason, /6 hours/);
    assert.match(checks.backup.reason, /26 hours/);
    assert.equal(checks.offsite.reason, 'rsync failed');
    assert.equal(checks.brief.state, 'ok');
  } finally { await app.close(); }
});

test('brief cutoff follows London daylight saving time', async () => {
  for (const [at, expected] of [
    ['2026-07-01T09:29:00Z', 'ok'],
    ['2026-07-01T09:30:00Z', 'warn'],
    ['2026-12-01T10:29:00Z', 'ok'],
    ['2026-12-01T10:30:00Z', 'warn'],
  ]) {
    const options = statusFixture({ now: Date.parse(at), ingest: null, brief: null });
    const app = await fixture(createStatusHandler(options));
    try {
      const body = await (await fetch(app.url)).json();
      assert.equal(body.checks.find((check) => check.name === 'brief').state, expected, at);
    } finally { await app.close(); }
  }
});
