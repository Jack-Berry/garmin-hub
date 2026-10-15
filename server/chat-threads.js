const crypto = require('crypto');
const express = require('express');

const MAX_MESSAGES = 200;
const MAX_BYTES = 256 * 1024;
const MODES = new Set(['chat', 'planning']);
const FORBIDDEN_KEYS = /^(authorization|api[_-]?key|x[_-]?api[_-]?key)$/i;

const fail = (status, message) => Object.assign(new Error(message), { status });

function validateMessages(messages) {
  if (!Array.isArray(messages)) throw fail(400, 'messages must be an array');
  if (messages.length > MAX_MESSAGES) throw fail(413, `threads are limited to ${MAX_MESSAGES} messages`);
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw fail(400, 'each message must be an object');
    }
    if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw fail(400, 'each message needs a user or assistant role and string content');
    }
  }
  const json = JSON.stringify(messages, (key, value) => {
    if (FORBIDDEN_KEYS.test(key)) throw fail(400, 'message data cannot contain credentials');
    return value;
  });
  if (Buffer.byteLength(json) > MAX_BYTES) {
    throw fail(413, `threads are limited to ${MAX_BYTES} bytes`);
  }
  return json;
}

function titleFrom(messages) {
  const first = messages.find((message) => message.role === 'user' && !message.system);
  const title = first?.content.replace(/\s+/g, ' ').trim() || 'New conversation';
  return [...title].slice(0, 80).join('');
}

function createChatThreadsRouter({ db, writeDb }) {
  const router = express.Router();
  const handler = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  };

  router.get('/', handler(async (req, res) => {
    const params = [];
    const where = req.query.mode ? 'WHERE mode = $1' : '';
    if (req.query.mode) {
      if (!MODES.has(req.query.mode)) throw fail(400, 'mode must be chat or planning');
      params.push(req.query.mode);
    }
    const rows = await db.all(
      `SELECT thread_id AS id, mode, title, updated_at,
              jsonb_array_length(messages_json) AS message_count
       FROM chat_threads ${where}
       ORDER BY updated_at DESC`, params);
    res.json(rows);
  }));

  router.get('/:id', handler(async (req, res) => {
    const row = await db.get(
      `SELECT thread_id AS id, mode, title, messages_json AS messages,
              created_at, updated_at
       FROM chat_threads WHERE thread_id = $1`, [req.params.id]);
    if (!row) throw fail(404, 'thread not found');
    res.json(row);
  }));

  router.post('/', handler(async (req, res) => {
    const mode = req.body?.mode;
    if (!MODES.has(mode)) throw fail(400, 'mode must be chat or planning');
    const id = req.body?.id || crypto.randomUUID();
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
      throw fail(400, 'invalid thread id');
    }
    const messagesJson = validateMessages(req.body?.messages);
    const title = titleFrom(req.body.messages);
    const result = await writeDb.run(
      `INSERT INTO chat_threads
         (thread_id, mode, title, messages_json, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now(), now())
       ON CONFLICT (thread_id) DO UPDATE SET
         mode = EXCLUDED.mode,
         title = EXCLUDED.title,
         messages_json = EXCLUDED.messages_json,
         updated_at = now()
       RETURNING thread_id AS id, mode, title, updated_at,
                 jsonb_array_length(messages_json) AS message_count`,
      [id, mode, title, messagesJson]);
    res.json(result.rows[0]);
  }));

  router.delete('/:id', handler(async (req, res) => {
    const result = await writeDb.run(
      'DELETE FROM chat_threads WHERE thread_id = $1 RETURNING thread_id',
      [req.params.id]);
    if (!result.rowCount) throw fail(404, 'thread not found');
    res.json({ deleted: req.params.id });
  }));

  return router;
}

module.exports = { createChatThreadsRouter, MAX_BYTES, MAX_MESSAGES };
