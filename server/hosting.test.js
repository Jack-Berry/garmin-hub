const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { DEFAULT_ORIGINS, resolveHost, cors, keyGate, mountDashboard } = require('./hosting');

const SECRET = 'focused-test-key';

async function fixture() {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'garmin-hub-static-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<h1>dashboard</h1>');
  const app = express();
  app.use(cors(DEFAULT_ORIGINS));
  app.use('/api', keyGate(SECRET));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api', (req, res) => res.sendStatus(404));
  mountDashboard(app, SECRET, dist);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('host defaults to loopback and respects HOST', () => {
  assert.equal(resolveHost({}), '127.0.0.1');
  assert.equal(resolveHost({ HOST: '0.0.0.0' }), '0.0.0.0');
});

test('401 without key on /api/health and /; 200 with key on both', async () => {
  const app = await fixture();
  try {
    assert.equal((await fetch(`${app.base}/api/health`)).status, 401);
    assert.equal((await fetch(`${app.base}/`)).status, 401);
    assert.equal((await fetch(`${app.base}/api/health`, {
      headers: { 'X-Api-Key': SECRET },
    })).status, 200);
    const page = await fetch(`${app.base}/`, { headers: { 'X-Api-Key': SECRET } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /dashboard/);
  } finally {
    await app.close();
  }
});

test('CORS allows localhost and hub://dashboard before auth', async () => {
  const app = await fixture();
  try {
    for (const origin of ['http://localhost:4173', 'http://localhost:5173', 'hub://dashboard']) {
      const response = await fetch(`${app.base}/api/health`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Headers': 'X-Api-Key' },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), origin);
    }
    const denied = await fetch(`${app.base}/api/health`, {
      method: 'OPTIONS', headers: { Origin: 'https://example.com' },
    });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  } finally {
    await app.close();
  }
});
