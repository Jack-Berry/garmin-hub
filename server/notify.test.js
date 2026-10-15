const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { createJwt, londonHour, createNotifyService } = require('./notify');

const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const config = { enabled: true, key: keys.privateKey, keyId: 'KEY123', teamId: 'TEAM123',
  topic: 'com.beriscope.garminhub', host: 'example.test' };

function memoryDb() {
  const devices = new Map();
  const outbox = [];
  const writeDb = { run: async (sql, params = []) => {
    if (sql.includes('INSERT INTO notification_devices')) {
      const old = devices.get(params[0]);
      devices.set(params[0], old || { token: params[0], platform: params[1], preferences: {} });
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('UPDATE notification_devices SET preferences')) {
      const row = devices.get(params[0]);
      if (!row) return { rowCount: 0 };
      row.preferences = JSON.parse(params[1]); return { rowCount: 1 };
    }
    if (sql.includes('DELETE FROM notification_devices')) {
      return { rowCount: devices.delete(params[0]) ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO notification_outbox')) {
      const carried = sql.includes('present previous day');
      const dedupe = params[carried ? 0 : 1];
      if (outbox.some((row) => row.dedupe_key === dedupe)) return { rowCount: 0, rows: [] };
      const row = carried
        ? { id: outbox.length + 1, type: 'risk', dedupe_key: params[0], title: 'Training risk', body: params[1], payload: JSON.parse(params[2]), sent_at: 'now', error: 'present previous day' }
        : { id: outbox.length + 1, type: params[0], dedupe_key: params[1], title: params[2], body: params[3], payload: JSON.parse(params[4]), sent_at: null };
      outbox.push(row); return { rowCount: 1, rows: [{ id: row.id }] };
    }
    if (sql.includes("error = 'expired during quiet hours'")) {
      let count = 0;
      outbox.filter((row) => !row.sent_at && row.old).forEach((row) => {
        row.sent_at = 'now'; row.error = 'expired during quiet hours'; count++;
      });
      return { rowCount: count };
    }
    if (sql.includes('UPDATE notification_outbox SET sent_at')) {
      const row = outbox.find((item) => item.id === params[0]);
      row.sent_at = 'now'; row.error = params[1]; return { rowCount: 1 };
    }
    throw new Error(`Unhandled write: ${sql}`);
  } };
  const db = {
    get: async (sql, params = []) => {
      if (sql.includes('notification_devices')) return devices.get(params[0]);
      throw new Error(`Unhandled get: ${sql}`);
    },
    all: async (sql, params = []) => {
      if (sql.includes("payload ->> 'warning'")) {
        const prefix = params[0].replace('%', '');
        return outbox.filter((row) => row.dedupe_key.startsWith(prefix)).map((row) => ({ warning: row.payload.warning }));
      }
      if (sql.includes('FROM notification_outbox')) return outbox.filter((row) => !row.sent_at);
      if (sql.includes('FROM notification_devices')) return [...devices.values()].filter((row) => row.preferences[params[0]] !== false);
      throw new Error(`Unhandled all: ${sql}`);
    },
  };
  return { db, writeDb, devices, outbox };
}

test('ES256 JWT has the APNs shape and verifies', () => {
  const now = () => Date.parse('2026-10-15T12:00:00Z');
  const { token } = createJwt({ key: keys.privateKey, keyId: 'KID', teamId: 'TEAM', now });
  const [header, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'KID' });
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { iss: 'TEAM', iat: 1792065600 });
  assert.equal(crypto.verify('sha256', Buffer.from(`${header}.${claims}`),
    { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
});

test('JWT is cached then refreshed before one hour and APNs payload is shaped', async () => {
  const store = memoryDb(); let clock = Date.parse('2026-10-15T12:00:00Z'); const calls = [];
  const service = createNotifyService({ ...store, config, now: () => clock,
    transport: async (request) => { calls.push(request); return { status: 200 }; } });
  const token = 'a'.repeat(64); await service.register(token);
  await service.test(token); clock += 10 * 60 * 1000; await service.test(token);
  assert.equal(calls[0].token, calls[1].token);
  clock += 41 * 60 * 1000; await service.test(token);
  assert.notEqual(calls[1].token, calls[2].token);
  assert.deepEqual(calls[0].payload.aps.alert, { title: 'Garmin Hub', body: 'Notifications are working.' });
});

test('dedupe, preferences, quiet-hour hold, and later flush', async () => {
  const store = memoryDb(); let clock = Date.parse('2026-10-15T21:30:00Z'); const calls = [];
  assert.equal(londonHour(clock), 22);
  const service = createNotifyService({ ...store, config, now: () => clock,
    transport: async (request) => { calls.push(request); return { status: 200 }; } });
  const token = 'b'.repeat(64); await service.register(token);
  await service.enqueue({ type: 'debrief', dedupeKey: 'debrief:1', title: 'Ready', body: 'Run', payload: { type: 'debrief' } });
  await service.enqueue({ type: 'debrief', dedupeKey: 'debrief:1', title: 'Ready', body: 'Run' });
  assert.equal(store.outbox.length, 1); assert.equal(calls.length, 0);
  clock = Date.parse('2026-10-16T06:05:00Z'); await service.flush();
  assert.equal(calls.length, 1);
  await service.preferences(token, { debrief: false });
  await service.enqueue({ type: 'debrief', dedupeKey: 'debrief:2', title: 'Ready', body: 'Run' });
  assert.equal(calls.length, 1);
});

test('missing config logs events without sending or throwing', async () => {
  const store = memoryDb();
  const service = createNotifyService({ ...store, config: { enabled: false },
    now: () => Date.parse('2026-10-15T12:00:00Z'), transport: async () => { throw new Error('called'); } });
  assert.deepEqual(service.status(), { enabled: false, reason: 'APNs is not configured' });
  await service.enqueue({ type: 'weekly', dedupeKey: 'weekly:1', title: 'Review', body: 'Ready' });
  assert.equal(store.outbox.length, 1); assert.equal(store.outbox[0].sent_at, null);
});

test('held notifications older than 24 hours are dropped on a daytime flush', async () => {
  const store = memoryDb(); let clock = Date.parse('2026-10-15T22:30:00Z'); let calls = 0;
  const service = createNotifyService({ ...store, config, now: () => clock,
    transport: async () => { calls++; return { status: 200 }; } });
  await service.register('d'.repeat(64));
  await service.enqueue({ type: 'weekly', dedupeKey: 'old', title: 'Old', body: 'Old' });
  store.outbox[0].old = true;
  clock = Date.parse('2026-10-17T08:00:00Z');
  await service.flush();
  assert.equal(calls, 0);
  assert.equal(store.outbox[0].error, 'expired during quiet hours');
});

test('APNs invalid-token responses remove the device without exposing it', async () => {
  const store = memoryDb(); const token = 'c'.repeat(64);
  const service = createNotifyService({ ...store, config,
    now: () => Date.parse('2026-10-15T12:00:00Z'),
    transport: async () => ({ status: 410, reason: 'Unregistered' }) });
  await service.register(token);
  await assert.rejects(service.test(token), /no longer registered/);
  assert.equal(store.devices.has(token), false);
});

test('risk trigger alerts only warnings absent from the previous day', async () => {
  const store = memoryDb();
  const service = createNotifyService({ ...store, config: { enabled: false },
    now: () => Date.parse('2026-10-15T12:00:00Z') });
  await service.risks(['High load'], '2026-10-14');
  const result = await service.risks(['High load', 'Low HRV'], '2026-10-15');
  assert.equal(result.created, 1);
  assert.equal(store.outbox.filter((row) => row.body === 'High load').length, 2);
  assert.equal(store.outbox.find((row) => row.dedupe_key.startsWith('risk:2026-10-15') && row.body === 'High load').error, 'present previous day');
});
