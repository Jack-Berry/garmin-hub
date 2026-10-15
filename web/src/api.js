// Empty means same origin, which is the production image default. The local
// Mac build sets this to either localhost:3001 or the droplet in .env.local.
const configuredBase = import.meta.env.VITE_API_BASE;
const BASE = (configuredBase === ''
  ? ''
  : configuredBase || import.meta.env.VITE_API_URL || 'http://localhost:3001')
  .replace(/\/$/, '');
// The iOS shell injects its Keychain value before page scripts run. Local Mac
// builds retain the Vite fallback; the production image sets neither value.
const SECRET = window.__HUB_API_KEY__ || import.meta.env.VITE_API_SECRET || '';

const qs = (params) => {
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== '');
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'X-Api-Key': SECRET } });
  if (!res.ok) {
    const error = new Error(`GET ${path} → ${res.status} ${res.statusText}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

async function post(path, body, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': SECRET },
    body: JSON.stringify(body),
    keepalive: options.keepalive,
  });
  if (!res.ok) {
    // Surface the server's error body (guard rejections, Garmin failures) —
    // status alone reads as "500 Internal Server Error", which tells the
    // athlete (and the coach's repair relay) nothing.
    const detail = await res.json().then((b) => b.error).catch(() => null);
    const error = new Error(`POST ${path} → ${res.status} ${detail || res.statusText}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

async function del(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { 'X-Api-Key': SECRET },
  });
  if (!res.ok) {
    const error = new Error(`DELETE ${path} → ${res.status} ${res.statusText}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

export const api = {
  health: () => get('/api/health'),
  status: () => get('/api/status'),
  activities: (params = {}) => get(`/api/activities${qs(params)}`),
  activity: (id) => get(`/api/activities/${id}`),
  planned: (params = {}) => get(`/api/planned${qs(params)}`),
  recovery: (params = {}) => get(`/api/recovery${qs(params)}`),
  trainingBalance: () => get('/api/training-balance'),
  fitness: (days = 120) => get(`/api/fitness${qs({ days })}`),
  gear: () => get('/api/gear'),
  weekly: () => get('/api/summary/weekly'),
  raceOverride: (scheduleId, override) =>
    post(`/api/planned/${scheduleId}/race-override`, { override }),
  profile: () => get('/api/profile'),
  saveProfile: (fields) => post('/api/profile', fields),
  personalRecords: () => get('/api/personal-records'),
  racePredictions: () => get('/api/race-predictions'),
  predictionHistory: (days = 180) => get(`/api/race-predictions/history${qs({ days })}`),
  raceCountdown: () => get('/api/race-countdown'),
  chat: (messages) => post('/api/coach/chat', { messages }),
  plan: (messages) => post('/api/coach/plan', { messages }),
  chatThreads: (mode) => get(`/api/chat-threads${qs({ mode })}`),
  chatThread: (id) => get(`/api/chat-threads/${id}`),
  saveChatThread: (thread, options) => post('/api/chat-threads', thread, options),
  deleteChatThread: (id) => del(`/api/chat-threads/${id}`),
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
  debrief: (activityId) => get(`/api/coach/debriefs/${activityId}`),
  weeklyReview: () => get('/api/coach/weekly/latest'),
  risks: () => get('/api/coach/risks'),
  // maxAgeMinutes: only actually pull if the last run is older than this (the
  // dashboard's on-load refresh). Omit it to always pull (the manual button).
  refreshIngest: (maxAgeMinutes) =>
    post('/api/ingest/refresh',
      maxAgeMinutes ? { max_age_minutes: maxAgeMinutes } : {}),
  pacerChat: (messages) => post('/api/pacer/chat', { messages }),
  pacerPreview: (params) => post('/api/pacer/preview', params),
  pacerPush: (params) => post('/api/pacer/push', params),
};
