// Thin fetch wrapper over the Stage 2 Express API. Base URL is configurable
// via VITE_API_URL; defaults to the local API port.
const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';
// Shared API secret, baked in at build time (web/.env.local) — must match the
// server's API_SECRET or every call 401s.
const SECRET = import.meta.env.VITE_API_SECRET || '';

const qs = (params) => {
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== '');
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-Api-Key': SECRET } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': SECRET },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Surface the server's error body (guard rejections, Garmin failures) —
    // status alone reads as "500 Internal Server Error", which tells the
    // athlete (and the coach's repair relay) nothing.
    const detail = await res.json().then((b) => b.error).catch(() => null);
    throw new Error(`POST ${path} → ${res.status} ${detail || res.statusText}`);
  }
  return res.json();
}

export const api = {
  health: () => get('/api/health'),
  activities: (params = {}) => get(`/api/activities${qs(params)}`),
  activity: (id) => get(`/api/activities/${id}`),
  planned: (params = {}) => get(`/api/planned${qs(params)}`),
  recovery: (params = {}) => get(`/api/recovery${qs(params)}`),
  trainingBalance: () => get('/api/training-balance'),
  weekly: () => get('/api/summary/weekly'),
  raceOverride: (scheduleId, override) =>
    post(`/api/planned/${scheduleId}/race-override`, { override }),
  profile: () => get('/api/profile'),
  saveProfile: (fields) => post('/api/profile', fields),
  personalRecords: () => get('/api/personal-records'),
  racePredictions: () => get('/api/race-predictions'),
  chat: (messages) => post('/api/coach/chat', { messages }),
  plan: (messages) => post('/api/coach/plan', { messages }),
  compose: (messages) => post('/api/coach/compose', { messages }),
  savePlan: (plan) => post('/api/plan/save', { plan }),
  planCurrent: () => get('/api/plan/current'),
  planPushNext: (planId) => post(`/api/plan/${planId}/push-next`, {}),
  runnaCleared: (planId) => post(`/api/plan/${planId}/runna-cleared`, {}),
  discardPlan: (planId) => post(`/api/plan/${planId}/discard`, {}),
  moveSession: (id, to_date, force) => post(`/api/plan/session/${id}/move`, { to_date, force }),
  removeSession: (id) => post(`/api/plan/session/${id}/remove`, {}),
  replaceSession: (id, spec) => post(`/api/plan/session/${id}/replace`, { spec }),
  contextDump: () => get('/api/coach/context-dump'),
  coachNotes: (params = {}) => get(`/api/coach/notes${qs(params)}`),
  coachMemory: () => get('/api/coach/memory'),
  forgetMemory: (id) => post(`/api/coach/memory/${id}/forget`, {}),
  generateDaily: () => post('/api/coach/daily', {}),
  coachReport: () => post('/api/coach/report', {}),
  coachDay: (date) => post(`/api/coach/day/${date}`, {}),
  refreshIngest: () => post('/api/ingest/refresh'),
  pacerChat: (messages) => post('/api/pacer/chat', { messages }),
  pacerPreview: (params) => post('/api/pacer/preview', params),
  pacerPush: (params) => post('/api/pacer/push', params),
};
