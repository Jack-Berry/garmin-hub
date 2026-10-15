const assert = require('node:assert/strict');
const test = require('node:test');
const express = require('express');
const { createChatThreadsRouter, MAX_BYTES } = require('./chat-threads');

function fakePools() {
  const rows = new Map();
  const calls = { reads: [], writes: [] };
  let tick = 0;
  const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++tick)).toISOString();
  const summary = (row) => ({
    id: row.id, mode: row.mode, title: row.title, updated_at: row.updated_at,
    revision: row.revision, message_count: row.messages.length,
  });
  return {
    calls,
    db: {
      all: async (sql, params) => {
        calls.reads.push({ sql, params });
        return [...rows.values()]
          .filter((row) => !params[0] || row.mode === params[0])
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
          .map(summary);
      },
      get: async (sql, params) => {
        calls.reads.push({ sql, params });
        const row = rows.get(params[0]);
        return row && { ...row };
      },
    },
    writeDb: {
      run: async (sql, params) => {
        calls.writes.push({ sql, params });
        if (/^DELETE/.test(sql.trim())) {
          const deleted = rows.delete(params[0]);
          return { rowCount: deleted ? 1 : 0, rows: deleted ? [{ thread_id: params[0] }] : [] };
        }
        const [id, mode, title, messagesJson, base] = params;
        const previous = rows.get(id);
        if (/^INSERT/.test(sql.trim()) && previous) return { rowCount: 0, rows: [] };
        if (/^UPDATE/.test(sql.trim()) &&
            (!previous || previous.mode !== mode || previous.revision !== base)) {
          return { rowCount: 0, rows: [] };
        }
        const row = {
          id, mode, title, messages: JSON.parse(messagesJson),
          revision: previous ? previous.revision + 1 : 1,
          created_at: previous?.created_at || stamp(), updated_at: stamp(),
        };
        rows.set(id, row);
        return { rowCount: 1, rows: [summary(row)] };
      },
    },
  };
}

async function fixture() {
  const pools = fakePools();
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/chat-threads', createChatThreadsRouter(pools));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return {
    ...pools,
    url: `http://127.0.0.1:${server.address().port}/api/chat-threads`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const request = (url, method = 'GET', body) => fetch(url, {
  method,
  headers: body ? { 'Content-Type': 'application/json' } : {},
  body: body && JSON.stringify(body),
});

test('CRUD uses read and write pools and lists newest first', async () => {
  const f = await fixture();
  try {
    for (const body of [
      { id: 'older', mode: 'chat', messages: [{ role: 'user', content: 'First question' }] },
      { id: 'newer', mode: 'planning', messages: [{ role: 'user', content: 'Build a tempo' }] },
    ]) assert.equal((await request(f.url, 'POST', body)).status, 200);

    const list = await (await request(f.url)).json();
    assert.deepEqual(list.map((row) => row.id), ['newer', 'older']);
    assert.equal(list[0].message_count, 1);

    const updated = await (await request(f.url, 'POST', {
      id: 'older', mode: 'chat', messages: [
        { role: 'user', content: 'Updated question with a long enough title' },
        { role: 'assistant', content: 'Answer' },
      ], base: 1,
    })).json();
    assert.equal(updated.message_count, 2);
    assert.equal(updated.title, 'Updated question with a long enough title');

    const loaded = await (await request(`${f.url}/older`)).json();
    assert.equal(loaded.messages[1].content, 'Answer');
    assert.equal((await request(`${f.url}/older`, 'DELETE')).status, 200);
    assert.equal((await request(`${f.url}/older`)).status, 404);

    assert.equal(f.calls.reads.length, 3);
    assert.equal(f.calls.writes.length, 4);
    assert.ok(f.calls.reads.every(({ sql }) => /SELECT/.test(sql)));
    assert.ok(f.calls.writes.every(({ sql }) => /INSERT|UPDATE|DELETE/.test(sql)));
  } finally { await f.close(); }
});

test('mode filtering is ordered and read-only', async () => {
  const f = await fixture();
  try {
    await request(f.url, 'POST', { id: 'chat', mode: 'chat', messages: [] });
    await request(f.url, 'POST', { id: 'plan', mode: 'planning', messages: [] });
    const rows = await (await request(`${f.url}?mode=chat`)).json();
    assert.deepEqual(rows.map((row) => row.id), ['chat']);
    assert.equal(f.calls.writes.length, 2);
  } finally { await f.close(); }
});

test('validates message shape and rejects credential fields', async () => {
  const f = await fixture();
  try {
    for (const body of [
      { mode: 'other', messages: [] },
      { mode: 'chat', messages: {} },
      { mode: 'chat', messages: [{ role: 'system', content: 'no' }] },
      { mode: 'chat', messages: [{ role: 'user', content: 'hi', api_key: 'secret' }] },
    ]) assert.equal((await request(f.url, 'POST', body)).status, 400);
    assert.equal(f.calls.writes.length, 0);
  } finally { await f.close(); }
});

test('enforces the encoded thread size cap', async () => {
  const f = await fixture();
  try {
    const response = await request(f.url, 'POST', {
      mode: 'chat', messages: [{ role: 'user', content: 'x'.repeat(MAX_BYTES) }],
    });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /limited/);
    assert.equal(f.calls.writes.length, 0);
  } finally { await f.close(); }
});

test('stale, deleted and mode-changing updates return 409 without writing', async () => {
  const f = await fixture();
  try {
    const initial = { id: 'shared', mode: 'planning', messages: [{ role: 'user', content: 'Plan' }] };
    assert.equal((await request(f.url, 'POST', initial)).status, 200);
    assert.equal((await request(f.url, 'POST', initial)).status, 409, 'create collision');
    assert.equal((await request(f.url, 'POST', { ...initial, base: 9 })).status, 409, 'stale base');
    assert.equal((await request(f.url, 'POST', { ...initial, mode: 'chat', base: 1 })).status, 409,
      'mode change');
    assert.equal((await request(`${f.url}/shared`, 'DELETE')).status, 200);
    assert.equal((await request(f.url, 'POST', { ...initial, base: 1 })).status, 409,
      'deleted row resurrection');
  } finally { await f.close(); }
});
