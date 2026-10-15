const crypto = require('crypto');
const fs = require('fs');
const http2 = require('http2');
const express = require('express');

const TYPES = ['debrief', 'weekly', 'risk', 'job_failure'];
const DEFAULT_PREFS = Object.fromEntries(TYPES.map((type) => [type, true]));

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))
  .toString('base64url');

function createJwt({ key, keyId, teamId, now = Date.now }) {
  const issued = Math.floor(now() / 1000);
  const unsigned = `${b64({ alg: 'ES256', kid: keyId })}.${b64({ iss: teamId, iat: issued })}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), {
    key, dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { token: `${unsigned}.${signature}`, issued };
}

function londonHour(value) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23',
  }).format(new Date(value)));
}

function londonDate(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}

const previousDate = (day) => {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
};

function createHttp2Transport({ connect = http2.connect, timeoutMs = 10000 } = {}) {
  let session;
  let sessionHost;
  const close = (error) => {
    const current = session;
    session = null;
    sessionHost = null;
    if (current && !current.destroyed) current.destroy(error);
  };
  const getSession = (host) => {
    if (session && sessionHost === host && !session.closed && !session.destroyed) return session;
    close();
    session = connect(`https://${host}`);
    sessionHost = host;
    const client = session;
    client.on('error', () => { if (session === client) { session = null; sessionHost = null; } });
    client.on('close', () => { if (session === client) { session = null; sessionHost = null; } });
    client.setTimeout(timeoutMs, () => { if (session === client) close(new Error('APNs session timeout')); });
    return client;
  };
  return ({ host, token, topic, deviceToken, payload }) => new Promise((resolve, reject) => {
    const client = getSession(host);
    const request = client.request({
      ':method': 'POST', ':path': `/3/device/${deviceToken}`,
      authorization: `bearer ${token}`, 'apns-topic': topic,
      'apns-push-type': 'alert', 'apns-priority': '10',
    });
    let response = '';
    let status = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    request.setTimeout(timeoutMs, () => {
      const error = new Error('APNs request timeout');
      close(error);
      finish(reject, error);
    });
    request.setEncoding('utf8');
    request.on('response', (headers) => { status = Number(headers[':status']); });
    request.on('data', (chunk) => { response += chunk; });
    request.on('end', () => {
      let parsed = {};
      try { parsed = response ? JSON.parse(response) : {}; } catch (_) { /* APNs may return no JSON */ }
      finish(resolve, { status, reason: parsed.reason });
    });
    request.on('error', (error) => finish(reject, error));
    request.end(JSON.stringify(payload));
  });
}

const defaultTransport = createHttp2Transport();

function loadConfig(env = process.env, logger = console) {
  const required = ['APNS_KEY_PATH', 'APNS_KEY_ID', 'APNS_TEAM_ID', 'APNS_TOPIC'];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) {
    logger.warn(`APNs notifications disabled: missing ${missing.join(', ')}`);
    return { enabled: false, missing };
  }
  try {
    return {
      enabled: true, key: fs.readFileSync(env.APNS_KEY_PATH, 'utf8'),
      keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_TOPIC,
      host: env.APNS_HOST || 'api.push.apple.com',
    };
  } catch (error) {
    logger.warn(`APNs notifications disabled: APNS_KEY_PATH is unreadable (${error.code || 'read error'})`);
    return { enabled: false, missing: ['APNS_KEY_PATH'] };
  }
}

function createNotifyService({ db, writeDb, config = loadConfig(), transport = defaultTransport,
  transportTimeoutMs = 11000, now = Date.now } = {}) {
  let jwt;
  let flushing;
  let enqueueVersion = 0;
  const authToken = () => {
    if (!jwt || now() / 1000 - jwt.issued > 50 * 60) jwt = createJwt({ ...config, now });
    return jwt.token;
  };
  const status = () => ({ enabled: config.enabled, reason: config.enabled ? null : 'APNs is not configured' });
  const register = async (token, platform = 'ios') => {
    if (!/^[0-9a-f]{64,}$/i.test(token || '')) throw new Error('invalid device token');
    await writeDb.run(
      `INSERT INTO notification_devices (token, platform) VALUES ($1, $2)
       ON CONFLICT (token) DO UPDATE SET platform = EXCLUDED.platform, last_seen_at = now()`,
      [token, platform]);
    return device(token);
  };
  const device = async (token) => {
    const row = await db.get('SELECT platform, preferences FROM notification_devices WHERE token = $1', [token]);
    return { ...status(), registered: Boolean(row), platform: row?.platform,
      preferences: { ...DEFAULT_PREFS, ...(row?.preferences || {}) } };
  };
  const preferences = async (token, value) => {
    const prefs = Object.fromEntries(TYPES.map((type) => [type, value?.[type] !== false]));
    const result = await writeDb.run(
      'UPDATE notification_devices SET preferences = $2::jsonb, last_seen_at = now() WHERE token = $1',
      [token, JSON.stringify(prefs)]);
    if (!result.rowCount) throw new Error('device is not registered');
    return { ...status(), registered: true, preferences: prefs };
  };
  const enqueue = async ({ type, dedupeKey, title, body, payload = {} }) => {
    const result = await writeDb.run(
      `INSERT INTO notification_outbox (type, dedupe_key, title, body, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [type, dedupeKey, title, body, JSON.stringify(payload)]);
    if (result.rowCount) enqueueVersion++;
    void flush().catch(() => {});
    return { queued: Boolean(result.rowCount) };
  };
  const callTransport = (request) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('APNs transport timeout')), transportTimeoutMs);
    Promise.resolve().then(() => transport(request)).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
  const send = async (deviceToken, payload) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await callTransport({ ...config, token: authToken(), deviceToken, payload });
      if (result.status === 403 && ['ExpiredProviderToken', 'InvalidProviderToken'].includes(result.reason)
          && attempt === 0) {
        jwt = null;
        continue;
      }
      return result;
    }
    return { status: 403, reason: 'InvalidProviderToken' };
  };
  const runFlush = async () => {
    if (!config.enabled || londonHour(now()) >= 22 || londonHour(now()) < 7) return { sent: 0 };
    await writeDb.run(
      `UPDATE notification_outbox SET sent_at = now(), error = 'expired during quiet hours'
       WHERE sent_at IS NULL AND created_at < now() - interval '24 hours'`);
    const events = await db.all(
      `SELECT id, type, title, body, payload FROM notification_outbox
       WHERE sent_at IS NULL AND created_at >= now() - interval '24 hours' ORDER BY id`);
    let sent = 0;
    for (const event of events) {
      const devices = await db.all(
        `SELECT token FROM notification_devices
         WHERE COALESCE((preferences ->> $1)::boolean, true)`, [event.type]);
      let error = null;
      let retry = false;
      for (const { token } of devices) {
        try {
          const result = await send(token,
            { aps: { alert: { title: event.title, body: event.body }, sound: 'default' }, ...event.payload });
          if (result.status === 410 || ['Unregistered', 'BadDeviceToken'].includes(result.reason)) {
            await writeDb.run('DELETE FROM notification_devices WHERE token = $1', [token]);
          } else if (result.status < 200 || result.status >= 300) error = result.reason || `APNs ${result.status}`;
        } catch (cause) { error = cause.message; retry = true; }
      }
      if (retry) {
        await writeDb.run('UPDATE notification_outbox SET error = $2 WHERE id = $1', [event.id, error]);
      } else {
        await writeDb.run('UPDATE notification_outbox SET sent_at = now(), error = $2 WHERE id = $1', [event.id, error]);
        sent++;
      }
    }
    return { sent };
  };
  const flush = () => {
    if (!flushing) flushing = (async () => {
      let version;
      do { version = enqueueVersion; await runFlush(); } while (version !== enqueueVersion);
    })().finally(() => { flushing = null; });
    return flushing;
  };
  const test = async (token) => {
    const row = await db.get('SELECT token FROM notification_devices WHERE token = $1', [token]);
    if (!row) throw new Error('device is not registered');
    if (!config.enabled) return status();
    const result = await send(token,
      { aps: { alert: { title: 'Garmin Hub', body: 'Notifications are working.' }, sound: 'default' }, type: 'test' });
    if (result.status === 410 || ['Unregistered', 'BadDeviceToken'].includes(result.reason)) {
      await writeDb.run('DELETE FROM notification_devices WHERE token = $1', [token]);
      throw new Error('device token is no longer registered');
    }
    if (result.status < 200 || result.status >= 300) throw new Error(result.reason || `APNs ${result.status}`);
    return { enabled: true, sent: true };
  };
  const risks = async (warnings, day = londonDate(now())) => {
    const prior = await db.all(
      `SELECT payload -> 'warning' ->> 'code' AS code FROM notification_outbox
       WHERE type = 'risk' AND dedupe_key LIKE $1`, [`risk:${previousDate(day)}:%`]);
    const priorCodes = new Set(prior.map((row) => row.code));
    const created = [];
    for (const warning of warnings || []) {
      if (!warning?.code || !warning?.title || !warning?.detail) continue;
      const body = `${warning.title}: ${warning.detail}`;
      if (priorCodes.has(warning.code)) {
        await writeDb.run(
          `INSERT INTO notification_outbox
             (type, dedupe_key, title, body, payload, sent_at, error)
           VALUES ('risk', $1, 'Training risk', $2, $3::jsonb, now(), 'present previous day')
           ON CONFLICT (dedupe_key) DO NOTHING`,
          [`risk:${day}:${warning.code}`, body, JSON.stringify({ type: 'risk', warning })]);
      } else {
        created.push(await enqueue({ type: 'risk', dedupeKey: `risk:${day}:${warning.code}`,
          title: 'New training risk', body, payload: { type: 'risk', warning } }));
      }
    }
    return { created: created.filter((item) => item.queued).length };
  };
  return { status, register, device, preferences, enqueue, flush, test, risks };
}

function createNotifyRouter(service) {
  const router = express.Router();
  const handle = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (error) { res.status(400).json({ error: error.message }); }
  };
  router.get('/status', handle(() => service.device('')));
  router.post('/device', handle((req) => service.register(req.body?.token, req.body?.platform)));
  router.post('/device/status', handle((req) => service.device(req.body?.token)));
  router.post('/device/preferences', handle((req) => service.preferences(req.body?.token, req.body?.preferences)));
  router.post('/test', handle((req) => service.test(req.body?.token)));
  router.post('/flush', handle(() => service.flush()));
  router.post('/job-failure', handle((req) => {
    const job = String(req.body?.job || 'unknown');
    const day = String(req.body?.day || londonDate(Date.now()));
    return service.enqueue({ type: 'job_failure', dedupeKey: `job:${job}:${day}`,
      title: `${job} job failed`, body: String(req.body?.message || 'Check Garmin Hub status.'),
      payload: { type: 'job_failure', job } });
  }));
  return router;
}

module.exports = { TYPES, DEFAULT_PREFS, createJwt, londonHour, londonDate, loadConfig,
  createHttp2Transport, createNotifyService, createNotifyRouter, defaultTransport };
