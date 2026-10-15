const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createJwt, londonHour, londonDate, loadConfig, createHttp2Transport, createNotifyService } = require('./notify');
const { deriveRiskWarnings } = require('./risk-warnings');

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
    if (sql.includes('UPDATE notification_outbox SET error')) {
      const row = outbox.find((item) => item.id === params[0]);
      row.error = params[1]; return { rowCount: 1 };
    }
    throw new Error(`Unhandled write: ${sql}`);
  } };
  const db = {
    get: async (sql, params = []) => {
      if (sql.includes('notification_devices')) return devices.get(params[0]);
      throw new Error(`Unhandled get: ${sql}`);
    },
    all: async (sql, params = []) => {
      if (sql.includes("payload -> 'warning'")) {
        const prefix = params[0].replace('%', '');
        return outbox.filter((row) => row.dedupe_key.startsWith(prefix)).map((row) => ({ code: row.payload.warning.code }));
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

test('notification dates use Europe London rather than UTC', () => {
  assert.equal(londonDate(Date.parse('2026-07-31T23:30:00Z')), '2026-08-01');
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
  await service.flush();
  assert.equal(store.outbox.length, 1); assert.equal(calls.length, 0);
  clock = Date.parse('2026-10-16T06:05:00Z'); await service.flush();
  assert.equal(calls.length, 1);
  await service.preferences(token, { debrief: false });
  await service.enqueue({ type: 'debrief', dedupeKey: 'debrief:2', title: 'Ready', body: 'Run' });
  await service.flush();
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

test('missing APNs configuration logs one reason without secret material', () => {
  const messages = [];
  assert.equal(loadConfig({}, { warn: (message) => messages.push(message) }).enabled, false);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /missing APNS_KEY_PATH/);
  assert.doesNotMatch(messages[0], /BEGIN PRIVATE KEY/);
});

test('held notifications older than 24 hours are dropped on a daytime flush', async () => {
  const store = memoryDb(); let clock = Date.parse('2026-10-15T22:30:00Z'); let calls = 0;
  const service = createNotifyService({ ...store, config, now: () => clock,
    transport: async () => { calls++; return { status: 200 }; } });
  await service.register('d'.repeat(64));
  await service.enqueue({ type: 'weekly', dedupeKey: 'old', title: 'Old', body: 'Old' });
  await service.flush();
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

test('risk trigger uses real warning objects and alerts only codes absent the previous day', async () => {
  const store = memoryDb();
  const service = createNotifyService({ ...store, config: { enabled: false },
    now: () => Date.parse('2026-10-15T12:00:00Z') });
  const first = deriveRiskWarnings({ today: '2026-10-14', recovery: { latest: { acwr: { ratio: 1.5 } } } });
  const second = deriveRiskWarnings({ today: '2026-10-15', recovery: {
    latest: { acwr: { ratio: 1.6 }, hrv_baseline: [50] },
    last_7_days: [{ date: '2026-10-15', hrv: 40 }, { date: '2026-10-14', hrv: 42 }, { date: '2026-10-13', hrv: 44 }],
  } });
  await service.risks(first, '2026-10-14');
  const result = await service.risks(second, '2026-10-15');
  assert.equal(result.created, 1);
  assert.equal(store.outbox.filter((row) => row.dedupe_key.endsWith(':acwr')).length, 2);
  assert.match(store.outbox.find((row) => row.dedupe_key.endsWith(':hrv_streak')).body, /^HRV trend: HRV has/);
  assert.equal(store.outbox.find((row) => row.dedupe_key === 'risk:2026-10-15:acwr').error, 'present previous day');
});

test('provider-token rejection refreshes the JWT and retries once', async () => {
  const store = memoryDb(); const tokens = []; let calls = 0;
  let clock = Date.parse('2026-10-15T12:00:00Z');
  const service = createNotifyService({ ...store, config,
    now: () => clock, transport: async (request) => {
      tokens.push(request.token); calls++;
      clock += 1000;
      return calls === 1 ? { status: 403, reason: 'ExpiredProviderToken' } : { status: 200 };
    } });
  const token = 'e'.repeat(64); await service.register(token); await service.test(token);
  assert.equal(calls, 2);
  assert.notEqual(tokens[0], tokens[1]);
});

test('flush makes a second pass when an event is enqueued during delivery', async () => {
  const store = memoryDb(); const calls = [];
  let release;
  const firstStarted = new Promise((resolve) => { release = { resolve }; });
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const service = createNotifyService({ ...store, config,
    now: () => Date.parse('2026-10-15T12:00:00Z'), transport: async (request) => {
      calls.push(request.payload.type);
      if (calls.length === 1) { release.resolve(); await blocked; }
      return { status: 200 };
    } });
  await service.register('1'.repeat(64));
  await service.enqueue({ type: 'weekly', dedupeKey: 'first', title: 'First', body: 'First', payload: { type: 'first' } });
  await firstStarted;
  await service.enqueue({ type: 'weekly', dedupeKey: 'second', title: 'Second', body: 'Second', payload: { type: 'second' } });
  unblock();
  await service.flush();
  assert.deepEqual(calls, ['first', 'second']);
});

test('a hung transport is bounded and leaves the event retryable without wedging flush', async () => {
  const store = memoryDb(); let hang = true;
  const service = createNotifyService({ ...store, config, transportTimeoutMs: 15,
    now: () => Date.parse('2026-10-15T12:00:00Z'),
    transport: () => hang ? new Promise(() => {}) : Promise.resolve({ status: 200 }) });
  await service.register('f'.repeat(64));
  await service.enqueue({ type: 'weekly', dedupeKey: 'weekly:hung', title: 'Review', body: 'Ready' });
  await service.flush();
  assert.equal(store.outbox[0].sent_at, null);
  assert.match(store.outbox[0].error, /timeout/);
  hang = false;
  await service.flush();
  assert.equal(store.outbox[0].sent_at, 'now');
});

test('HTTP2 transport reuses its session and applies session and request timeouts', async () => {
  let connects = 0; const requests = [];
  class Session extends EventEmitter {
    constructor() { super(); this.closed = false; this.destroyed = false; }
    setTimeout(value, callback) { this.timeout = value; this.timeoutCallback = callback; }
    request() {
      const request = new EventEmitter(); requests.push(request);
      request.setTimeout = (value, callback) => { request.timeout = value; request.timeoutCallback = callback; };
      request.setEncoding = () => {};
      request.end = () => queueMicrotask(() => { request.emit('response', { ':status': 200 }); request.emit('end'); });
      return request;
    }
    destroy() { this.destroyed = true; this.emit('close'); }
  }
  const session = new Session();
  const transport = createHttp2Transport({ connect: () => { connects++; return session; }, timeoutMs: 25 });
  const request = { host: 'example.test', token: 'jwt', topic: 'topic', deviceToken: 'device', payload: {} };
  await transport(request); await transport(request);
  assert.equal(connects, 1);
  assert.equal(session.timeout, 25);
  assert.deepEqual(requests.map((item) => item.timeout), [25, 25]);
});

test('HTTP2 request timeout rejects and destroys the reusable session', async () => {
  class Session extends EventEmitter {
    constructor() { super(); this.closed = false; this.destroyed = false; }
    setTimeout() {}
    request() {
      const request = new EventEmitter();
      request.setTimeout = (_value, callback) => { this.requestTimeout = callback; };
      request.setEncoding = () => {};
      request.end = () => {};
      return request;
    }
    destroy(error) { this.destroyed = true; this.emit('error', error); this.emit('close'); }
  }
  const session = new Session();
  const transport = createHttp2Transport({ connect: () => session, timeoutMs: 25 });
  const pending = transport({ host: 'example.test', token: 'jwt', topic: 'topic', deviceToken: 'device', payload: {} });
  session.requestTimeout();
  await assert.rejects(pending, /request timeout/);
  assert.equal(session.destroyed, true);
});
