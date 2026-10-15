const express = require('express');
const {
  activityDetail, buildContext, localDate, sectionAlignedRecovery, sectionWeeklyReview,
} = require('./context');
const { planComplianceSummary, trainingHistorySummary } = require('./coach-evidence');
const {
  CHAT_MODEL, MODEL, getClient, requestConfig, visibleText, withPolicy,
  HONESTY_RULES, COACHING_PRINCIPLES, READINESS_RULES,
} = require('./coach');

const DEBRIEF_LIMIT = 3;

const shiftDate = (date, days) => {
  const value = new Date(`${date}T12:00:00`);
  value.setDate(value.getDate() + days);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
};
const sundayOnOrBefore = (date) => {
  const value = new Date(`${date}T12:00:00`);
  return shiftDate(date, -value.getDay());
};

const DEBRIEF_SYSTEM = `You write a short post-run debrief for one completed run.

Cover exactly three things: how it went against the matched plan if one exists, what the run and recovery data actually show, and one concrete thing to take forward. Keep it under 170 words. Do not invent targets or split detail that is absent.

${HONESTY_RULES}

${COACHING_PRINCIPLES}

${READINESS_RULES}`;

const WEEKLY_SYSTEM = `You write the athlete's weekly coaching review. Be concise but substantive. Cover plan compliance, load and freshness, the recovery trend, material risks, and next week's scheduled work. Use headings and keep it under 650 words. Treat this as the coach's carried-over view for future conversations.

${HONESTY_RULES}

${COACHING_PRINCIPLES}

${READINESS_RULES}`;

const ask = async (client, model, effort, maxTokens, system, user) => {
  const response = await client.messages.create({
    ...requestConfig(model, effort, maxTokens),
    system: [{ type: 'text', text: withPolicy(system) }],
    messages: [{ role: 'user', content: user }],
  });
  return visibleText(response);
};

async function debriefInput(db, activity) {
  const planned = await db.get(
    `SELECT p.calendar_date, COALESCE(gh.title, p.title) AS title,
            COALESCE(gh.estimated_distance_m, p.estimated_distance_m) AS estimated_distance_m,
            COALESCE(gh.steps_json, p.steps_json) AS steps_json, p.source
     FROM planned_workouts p LEFT JOIN plans pl ON pl.plan_id = p.plan_id
     LEFT JOIN planned_workouts gh ON gh.source = 'garmin'
       AND p.source = 'app' AND p.workout_id = gh.workout_id
     WHERE p.calendar_date = $1 AND p.removed_at IS NULL
       AND pl.status IS DISTINCT FROM 'draft'
     ORDER BY ABS(COALESCE(gh.estimated_distance_m, p.estimated_distance_m, $2) - $2), p.schedule_id
     LIMIT 1`, [activity.date, activity.distance_m || 0]);
  const [detail, recovery] = await Promise.all([
    activityDetail(db, { activityId: String(activity.activity_id) }),
    sectionAlignedRecovery(db, activity.date, localDate()),
  ]);
  return { activity: detail, matched_plan: planned || null, recovery };
}

async function weeklyInput(db, today, weekStart, weekEnd) {
  const [context, compliance, history] = await Promise.all([
    buildContext(db),
    planComplianceSummary(db, { weeks: 1 }, shiftDate(weekEnd, 1)),
    trainingHistorySummary(db, { weeks: 2 }, weekEnd),
  ]);
  return { today, week: { start: weekStart, end: weekEnd }, compliance, history, context };
}

function createProactiveService({ db, writeDb, client, today = localDate,
  buildDebriefInput = debriefInput, buildWeeklyInput = weeklyInput,
  buildSignals = async (database) => (await buildContext(database)).signals.warnings, notifier } = {}) {
  const modelClient = client || getClient();
  let debriefRunning = false;
  let weeklyRunning = false;

  const pendingDebriefs = async () => {
    if (debriefRunning) return { busy: true, created: [] };
    debriefRunning = true;
    try {
      const end = today();
      const candidates = (await db.all(
        `SELECT a.activity_id::text AS activity_id, a.start_time_local::date AS date,
                a.name, a.distance_m
         FROM activities a
         WHERE a.activity_group = 'run' AND a.distance_m > 0
           AND a.start_time_local::date BETWEEN $1 AND $2
           AND NOT EXISTS (
             SELECT 1 FROM coach_notes n
             WHERE CASE WHEN n.note_type = 'debrief'
               THEN n.content::jsonb ->> 'activity_id' END = a.activity_id::text)
         ORDER BY a.start_time_local
         LIMIT $3`, [shiftDate(end, -3), end, DEBRIEF_LIMIT])).slice(0, DEBRIEF_LIMIT);
      const created = [];
      const errors = [];
      for (const activity of candidates) {
        try {
          const input = await buildDebriefInput(db, activity);
          const text = await ask(modelClient, CHAT_MODEL, 'low', 1800, DEBRIEF_SYSTEM,
            `Write the debrief from this evidence:\n\n${JSON.stringify(input)}`);
          const content = JSON.stringify({ activity_id: String(activity.activity_id), debrief: text });
          const result = await writeDb.run(
            `INSERT INTO coach_notes
               (created_at, note_type, content, model, date_range_start, date_range_end)
             VALUES ($1, 'debrief', $2, $3, $4, $4) RETURNING id`,
            [new Date().toISOString(), content, CHAT_MODEL, activity.date]);
          created.push({ id: result.rows?.[0]?.id, activity_id: String(activity.activity_id),
            date: activity.date, content: text, model: CHAT_MODEL });
          if (notifier) await notifier.enqueue({
            type: 'debrief', dedupeKey: `debrief:${activity.activity_id}`,
            title: 'Run debrief ready', body: activity.name || 'Your latest run has been reviewed.',
            payload: { type: 'debrief', activity_id: String(activity.activity_id) },
          }).catch(() => {});
        } catch (error) {
          errors.push({ activity_id: String(activity.activity_id), date: activity.date,
            error: error.message });
        }
      }
      if (notifier) {
        await Promise.resolve().then(() => buildSignals(db))
          .then((warnings) => notifier.risks(warnings)).catch(() => {});
        await notifier.flush().catch(() => {});
      }
      if (candidates.length && errors.length === candidates.length) {
        const error = new Error('Every pending debrief attempt failed.');
        error.result = { created, errors };
        throw error;
      }
      return { busy: false, created, errors };
    } finally { debriefRunning = false; }
  };

  const weeklyReview = async () => {
    if (weeklyRunning) return { busy: true, created: false };
    weeklyRunning = true;
    try {
      const end = sundayOnOrBefore(today());
      const start = shiftDate(end, -6);
      const existing = await db.get(
        `SELECT id, created_at, content, model, date_range_start, date_range_end
         FROM coach_notes WHERE note_type = 'weekly'
           AND date_range_start = $1 AND date_range_end = $2
         ORDER BY id DESC LIMIT 1`, [start, end]);
      if (existing) return { created: false, note: existing };
      const input = await buildWeeklyInput(db, end, start, end);
      const text = await ask(modelClient, MODEL, 'medium', 7000, WEEKLY_SYSTEM,
        `Write the weekly review from this evidence:\n\n${JSON.stringify(input)}`);
      const createdAt = new Date().toISOString();
      const result = await writeDb.run(
        `INSERT INTO coach_notes
           (created_at, note_type, content, model, date_range_start, date_range_end)
         VALUES ($1, 'weekly', $2, $3, $4, $5) RETURNING id`,
        [createdAt, text, MODEL, start, end]);
      if (notifier) await notifier.enqueue({
        type: 'weekly', dedupeKey: `weekly:${start}:${end}`,
        title: 'Weekly review ready', body: `Your review for ${start} to ${end} is ready.`,
        payload: { type: 'weekly' },
      }).catch(() => {});
      return { created: true, note: { id: result.rows?.[0]?.id, created_at: createdAt,
        note_type: 'weekly', content: text, model: MODEL,
        date_range_start: start, date_range_end: end } };
    } finally { weeklyRunning = false; }
  };

  return { pendingDebriefs, weeklyReview };
}

function createProactiveRouter(options) {
  const router = express.Router();
  const service = createProactiveService(options);
  const handle = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (error) {
      res.status(500).json({ error: error.message, ...(error.result || {}) });
    }
  };
  router.post('/debriefs/pending', handle(async (req, res) => res.json(await service.pendingDebriefs())));
  router.get('/debriefs/:activityId', handle(async (req, res) => {
    if (!/^\d+$/.test(req.params.activityId)) return res.status(400).json({ error: 'bad activity id' });
    const row = await options.db.get(
      `SELECT id, created_at, content, model, date_range_start, date_range_end
       FROM coach_notes WHERE CASE WHEN note_type = 'debrief'
         THEN content::jsonb ->> 'activity_id' END = $1
       ORDER BY id DESC LIMIT 1`, [req.params.activityId]);
    if (!row) return res.json(null);
    const parsed = JSON.parse(row.content);
    res.json({ ...row, activity_id: parsed.activity_id, content: parsed.debrief });
  }));
  router.get('/weekly/latest', handle(async (req, res) => res.json(await sectionWeeklyReview(options.db))));
  router.post('/weekly', handle(async (req, res) => res.json(await service.weeklyReview())));
  router.get('/risks', handle(async (req, res) => {
    const context = await buildContext(options.db);
    if (options.notifier) await options.notifier.risks(context.signals.warnings).catch(() => {});
    res.json(context.signals.warnings);
  }));
  return router;
}

module.exports = {
  createProactiveRouter, createProactiveService, DEBRIEF_LIMIT, DEBRIEF_SYSTEM, WEEKLY_SYSTEM,
};
