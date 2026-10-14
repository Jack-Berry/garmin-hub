#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const usage = `Usage: node eval/coach-traps.mjs [--dry-run] [--coach /path/to/coach.js]

The candidate and comparison coach both run with tools enabled. Before the
selected coach loads, its local db module is replaced with a no-op stub, so no
evaluation path can read or write a real database.`;
if (args.includes('--help')) {
  console.log(usage);
  process.exit(0);
}
const dryRun = args.includes('--dry-run');
const coachIndex = args.indexOf('--coach');
if (coachIndex >= 0 && !args[coachIndex + 1]) throw new Error('--coach needs a path');
const requestedCoachPath = path.resolve(
  coachIndex >= 0 ? args[coachIndex + 1] : path.join(here, '..', 'coach.js'));
const coachPath = fs.realpathSync(requestedCoachPath);

const cases = JSON.parse(fs.readFileSync(path.join(here, 'cases.json'), 'utf8'));
if (!Array.isArray(cases) || cases.length < 10) throw new Error('cases.json needs at least 10 cases');
const ids = new Set();
for (const item of cases) {
  if (!item.id || ids.has(item.id)) throw new Error(`invalid or duplicate case id: ${item.id}`);
  ids.add(item.id);
  if (!item.message || !item.rubric || !item.context?.today) {
    throw new Error(`case ${item.id} is missing message, rubric, or context.today`);
  }
}

const requests = cases.map((item) => ({
  id: item.id,
  messages: [{ role: 'user', content: item.message }],
  context: item.context,
  rubric: item.rubric,
}));

const graderRequest = (item, reply) => ({
  model: 'claude-sonnet-5-5',
  max_tokens: 1500,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'low' },
  system: 'Grade the running coach reply against the rubric. Return only strict JSON: {"pass":true|false,"reason":"one line"}. Do not reward disagreement by itself; reward correct evidence-based judgement.',
  messages: [{
    role: 'user',
    content: JSON.stringify({ rubric: item.rubric, context: item.context, athlete: item.message, reply }),
  }],
});

const require = createRequire(import.meta.url);
const emptyResult = { rows: [{ id: 0 }], rowCount: 0 };
const stubDb = {
  all: async () => [],
  get: async (sql = '') => (/count\s*\(/i.test(sql) ? { n: 0 } : undefined),
  run: async () => emptyResult,
  query: async () => emptyResult,
  end: async () => {},
};

// Install this before context.js or coach.js is loaded. Both the candidate and
// a baseline coach destructure writeDb at require time, so replacing the module
// afterward would be too late and could leave memory tools connected to Postgres.
const coachDir = path.dirname(coachPath);
const dbPath = path.join(coachDir, 'db.js');
if (!fs.existsSync(dbPath)) throw new Error(`coach db module not found: ${dbPath}`);
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { db: stubDb, writeDb: stubDb },
};

let activeContext = null;
const contextPath = path.join(coachDir, 'context.js');
const contextModule = require(contextPath);
contextModule.buildContext = async () => activeContext;
const coach = require(coachPath);
if (typeof coach.chatReply !== 'function') throw new Error('coach module must export chatReply');
if (require.cache[dbPath]?.exports.writeDb !== stubDb) {
  throw new Error('coach database isolation was not installed');
}

if (dryRun) {
  const graderRequests = requests.map((item) => graderRequest(item, '[dry run reply]'));
  console.log(`Validated ${requests.length} trap cases.`);
  console.log(`Built ${requests.length} chat requests and ${graderRequests.length} grader requests.`);
  console.log(`Loaded coach module: ${coachPath}`);
  console.log('Tools: enabled for candidate and baseline; database: no-op stub.');
  process.exit(0);
}

if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY is required for a live eval');
}

const grader = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function grade(item, reply) {
  const response = await grader.messages.create(graderRequest(item, reply));
  if (response.stop_reason === 'refusal') throw new Error(`grader refused case ${item.id}`);
  const text = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('').trim();
  return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
}

const rows = [];
for (const item of requests) {
  activeContext = item.context;
  const reply = coach.SUPPORTS_CONTEXT_INJECTION
    ? await coach.chatReply(stubDb, item.messages, { context: item.context })
    : await coach.chatReply(stubDb, item.messages);
  const result = await grade(item, reply);
  rows.push({ case: item.id, pass: Boolean(result.pass), reason: result.reason });
}
console.table(rows);
console.log(`Total: ${rows.filter((row) => row.pass).length}/${rows.length} passed`);
