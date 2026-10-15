const assert = require('node:assert/strict');
const test = require('node:test');
const { createProactiveService, DEBRIEF_LIMIT } = require('./proactive-coach');

const client = (calls) => ({ messages: { create: async (request) => {
  calls.push(request);
  return { content: [{ type: 'text', text: 'Evidence-led coaching text.' }] };
} } });

test('pending debrief generation is idempotent and capped per call', async () => {
  const runs = Array.from({ length: 5 }, (_, i) => ({
    activity_id: String(i + 1), date: `2026-10-${String(10 + i).padStart(2, '0')}`, distance_m: 5000,
  }));
  const notes = [];
  const db = { all: async () => runs.filter((run) => !notes.some((note) => note.activity_id === run.activity_id)) };
  const writeDb = { run: async (_sql, params) => {
    const value = JSON.parse(params[1]); notes.push(value); return { rows: [{ id: notes.length }] };
  } };
  const calls = [];
  const service = createProactiveService({ db, writeDb, client: client(calls),
    today: () => '2026-10-15', buildDebriefInput: async (_db, run) => ({ run }) });
  assert.equal((await service.pendingDebriefs()).created.length, DEBRIEF_LIMIT);
  assert.equal(calls.length, DEBRIEF_LIMIT);
  assert.equal(calls[0].model, 'claude-sonnet-5-5');
  assert.equal(calls[0].output_config.effort, 'low');
  assert.equal((await service.pendingDebriefs()).created.length, 2);
  assert.equal((await service.pendingDebriefs()).created.length, 0);
  assert.equal(new Set(notes.map((note) => note.activity_id)).size, 5);
});

test('weekly review is idempotent for its Monday to Sunday range', async () => {
  let note = null;
  const db = { get: async () => note };
  const writeDb = { run: async (_sql, params) => {
    note = { id: 4, content: params[1], model: params[2],
      date_range_start: params[3], date_range_end: params[4] };
    return { rows: [{ id: 4 }] };
  } };
  const calls = [];
  const service = createProactiveService({ db, writeDb, client: client(calls),
    today: () => '2026-10-18', buildWeeklyInput: async () => ({ evidence: true }) });
  assert.equal((await service.weeklyReview()).created, true);
  assert.equal((await service.weeklyReview()).created, false);
  assert.equal(calls.length, 1);
  assert.equal(note.date_range_start, '2026-10-12');
  assert.equal(note.date_range_end, '2026-10-18');
  assert.equal(calls[0].model, 'claude-opus-5-5');
  assert.equal(calls[0].output_config.effort, 'medium');
});
