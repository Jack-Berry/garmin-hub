// Thin fetch wrapper over the Stage 2 Express API. Base URL is configurable
// via VITE_API_URL; defaults to the local API port.
const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const qs = (params) => {
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== '');
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
};

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  health: () => get('/api/health'),
  activities: (params = {}) => get(`/api/activities${qs(params)}`),
  activity: (id) => get(`/api/activities/${id}`),
  planned: (params = {}) => get(`/api/planned${qs(params)}`),
  recovery: (params = {}) => get(`/api/recovery${qs(params)}`),
  weekly: () => get('/api/summary/weekly'),
  raceOverride: (scheduleId, override) =>
    post(`/api/planned/${scheduleId}/race-override`, { override }),
  profile: () => get('/api/profile'),
  saveProfile: (fields) => post('/api/profile', fields),
  personalRecords: () => get('/api/personal-records'),
  racePredictions: () => get('/api/race-predictions'),
  chat: (messages) => post('/api/coach/chat', { messages }),
  contextDump: () => get('/api/coach/context-dump'),
  coachNotes: (params = {}) => get(`/api/coach/notes${qs(params)}`),
  generateDaily: () => post('/api/coach/daily', {}),
  coachReport: () => post('/api/coach/report', {}),
  coachDay: (date) => post(`/api/coach/day/${date}`, {}),
  refreshIngest: () => post('/api/ingest/refresh'),
  pacerChat: (messages) => post('/api/pacer/chat', { messages }),
  pacerPreview: (params) => post('/api/pacer/preview', params),
  pacerPush: (params) => post('/api/pacer/push', params),
};
