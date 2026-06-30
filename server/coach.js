// AI coach — Claude client. Generates coaching text from the assembled training
// context (see context.js). Analyst, not workout generator. Three tiers:
//   - brief        : cheap 2-3 sentence daily glance (Sonnet)
//   - detailed     : full multi-section daily report, on demand (Opus)
//   - day insight  : on-demand per-day run report / planned tips (Sonnet)
const Anthropic = require('@anthropic-ai/sdk');
const { buildContext, buildDayFocus } = require('./context');

// Opus for the deep, on-demand detailed report only — depth is worth the cost
// when explicitly requested.
const MODEL = 'claude-opus-4-8';
// Sonnet for everything frequent/interactive: chat, the daily brief, and the
// per-day insights. Cheaper and fast enough for a glance.
const CHAT_MODEL = 'claude-sonnet-4-6';

// Static framing for the chat coach — the interactive sibling of the daily
// insight. Same analyst-not-generator role; conversational rather than essay.
const CHAT_SYSTEM = `You are this athlete's running coach and analyst, answering their questions in a chat.

You have their full recent training context injected below as JSON: recent runs (including interval work-reps), recovery (HRV, resting HR, sleep, readiness), upcoming planned workouts, personal records, current Garmin race predictions, derived signals/flags, and their profile (shoes, goals, injuries/constraints). Use it — answer specifically with real numbers (paces, HR, HRV, mileage, dates) rather than generic advice. The athlete should never have to re-explain their training.

You do NOT prescribe full workouts or write training plans — they use Runna for that. But you CAN answer practical questions: which shoes for a session, whether a goal is realistic given current fitness, why a run felt hard, what the recovery data suggests, how recent paces compare to goal paces.

Be concise and conversational — this is a chat, not an essay. Short, direct answers. No headers or long bullet lists unless genuinely useful.`;

// Static system prompt — never changes between calls, so it's marked cacheable.
// (Opus 4.8 only caches prefixes ≥4096 tokens, so this short prompt won't
// actually cache yet; the breakpoint is correct and kicks in if it grows.)
const SYSTEM_PROMPT = `You are an analytical running coach reviewing one athlete's recent training and recovery data.

Your job is insight and observation, NOT prescribing workouts. The athlete plans their training with Runna, so never tell them which session to run or write a training plan.

Focus on how their body is responding to training: recovery trends (HRV vs baseline, resting HR, sleep, readiness), heart-rate behaviour, and the balance between training load and readiness. Comment on how recent sessions actually went and what the numbers suggest. Pay particular attention to signals.flags, these are pre-computed warnings; address any that are present. If a race appears in the upcoming list, factor in its proximity and the athlete's goal paces. Use the profile (shoes, goals, typical paces, injuries/constraints) for relevant context, for example how recent paces compare to goal paces, or whether an injury constraint bears on the current load.

Be specific: cite actual numbers (paces, HR, HRV, mileage, dates). That specificity is the value, so keep it. Avoid generic advice ("stay hydrated", "listen to your body").

Output a scannable structure:
- Start with a one-line TL;DR: a single bold sentence (wrapped in **) at the very top capturing the day's headline, e.g. the key takeaway about readiness or training state. No header above it.
- Then a few short sections, each under a light markdown header (## Header). Choose sensible headers like Recovery, Training, Mileage, Looking ahead. Use only the ones that fit the day's data, not every section every day.
- Each section is a tight 1 to 3 sentences, not a dense paragraph.

Style rules:
- Do NOT use the ~ symbol. Write "around 4:00/km" or "about 4:00/km" instead.
- Do NOT use em-dashes (—). Use commas, periods, or restructure the sentence.
- Keep it clean and direct.

If the data is sparse, say so briefly rather than padding.`;

// Glance-tier brief: the cheap default at the top of the dashboard. Deliberately
// thin so it doesn't duplicate the detailed report's depth.
const BRIEF_SYSTEM = `You are this athlete's running coach writing a short daily check-in, 2 to 3 conversational sentences and no more.

In plain, warm prose cover three things: how their body is responding right now (recovery, expressed in words rather than a stat dump), what's on the plan today, and a light encouraging nudge.

This is a glance, not a report. Do NOT: analyse past runs in detail, use any section headers, open with a bold TL;DR line, or list out numbers. Include at most one concrete number, and only if it genuinely adds colour, the detailed report is where the depth lives. If signals.flags are present, work them in briefly and in passing.

Style: second person, direct. Do NOT use em-dashes. Do NOT use the ~ symbol, write "around 4:00/km" instead.`;

// Per-day insight prompts (Sonnet). "How the run went" is the post-run analysis
// deliberately kept OUT of the brief; "planned tips" coaches execution.
const DAY_COMPLETED_SYSTEM = `You are this athlete's running coach reviewing ONE completed run in detail.

From the focus run (pace, avg/max HR, time-in-HR-zone, cadence, power, training load and effect, plus any interval work-reps) and the backdrop context (recovery, recent runs, goal paces), tell them how this session actually went. If a planned workout matched the day, judge execution against it: did they hit the target paces and intervals, or over/under-cook it. Comment on effort relative to recovery and how it fits recent training.

Be specific with real numbers (paces, HR, load). Keep to a few short sentences or a couple of tight bullets. One short markdown header at most, only if it helps. No bold TL;DR line. Do NOT use em-dashes or the ~ symbol. Second person.`;

const DAY_PLANNED_SYSTEM = `You are this athlete's running coach giving practical tips for an UPCOMING planned workout.

From the focus workout (title, distance, structured steps with any pace targets) and the backdrop context (current recovery and readiness, recent training load, goal paces, PRs), advise how to approach and execute it: what it's training, sensible pacing for the reps or segments, and any adjustment today's recovery or recent load warrants. If it's a race, factor its proximity and goal pace.

You do NOT rewrite the workout, they use Runna for that, you coach the execution. Be specific with paces and numbers. A few short sentences or tight bullets. One short markdown header at most. No bold TL;DR line. Do NOT use em-dashes or the ~ symbol. Second person.`;

const DAY_ROUTINE_SYSTEM = `You are this athlete's running coach commenting on a recurring non-running session in their week (e.g. football, gym, cycling).

You have the session (activity, intensity 1-10, whether it has been logged today) plus the backdrop context (recovery, recent runs, upcoming planned runs, goal paces). Treat it as cross-training that affects running load and recovery. For an upcoming or expected session, advise how hard to go given current recovery and any nearby running workouts, and how to protect the next run. For a completed one, note how it adds to the week's load and what that means for upcoming runs.

You do NOT coach the sport itself, only how it fits their running. A few short sentences. One short markdown header at most. No bold TL;DR line. Do NOT use em-dashes or the ~ symbol. Second person.`;

let client;
const getClient = () => (client ||= new Anthropic());

// Join the text blocks of a messages response into one trimmed string.
const extractText = (response) =>
  response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

// Glance brief (Sonnet). Returns { text, context, model } so the caller can
// persist it with the context's date range (same note shape as before).
async function generateBrief(db) {
  const context = buildContext(db);
  const response = await getClient().messages.create({
    model: CHAT_MODEL,
    max_tokens: 300,
    system: [{ type: 'text', text: BRIEF_SYSTEM }],
    messages: [{
      role: 'user',
      content: `Today's training context as JSON. Write today's check-in.\n\n${JSON.stringify(context)}`,
    }],
  });
  return { text: extractText(response), context, model: CHAT_MODEL };
}

// Detailed multi-section report (Opus), generated on demand. Stateless — the
// caller returns it directly without persisting.
async function generateDetailedReport(db) {
  const context = buildContext(db);
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Here is today's training context as JSON. Write today's detailed coaching report.\n\n${JSON.stringify(context)}`,
    }],
  });
  return { text: extractText(response), model: MODEL };
}

// On-demand per-day insight (Sonnet). Branches on what's on `date`: a completed
// run gets a "how it went" analysis, a planned-only day gets execution tips, and
// a rest day returns a static line with no model call. Returns { text, kind, model }.
async function generateDayInsight(db, date) {
  const focus = buildDayFocus(db, date);
  if (focus.kind === 'rest') {
    return { text: 'Rest day. Nothing planned and no run logged.', kind: 'rest', model: null };
  }
  // A missed recurring session needs no model call — a static line is enough.
  if (focus.kind === 'routine' && focus.routine.state === 'missed') {
    return {
      text: `Looks like you skipped ${focus.routine.activity} today. No matching session was logged.`,
      kind: 'routine', model: null,
    };
  }
  const context = buildContext(db);
  const isRoutine = focus.kind === 'routine';
  const system = isRoutine ? DAY_ROUTINE_SYSTEM
    : focus.kind === 'completed' ? DAY_COMPLETED_SYSTEM : DAY_PLANNED_SYSTEM;
  const verb = isRoutine
    ? (focus.routine.state === 'done'
        ? `Comment on today's completed ${focus.routine.activity} session and how it fits the running week.`
        : `Give tips for today's ${focus.routine.activity} session (intensity ${focus.routine.intensity ?? '?'}/10) and how to balance it with running.`)
    : focus.kind === 'completed'
      ? 'Analyse how this session went.'
      : 'Give tips for executing this planned workout.';
  const response = await getClient().messages.create({
    model: CHAT_MODEL,
    max_tokens: 600,
    system: [
      { type: 'text', text: system },
      {
        type: 'text',
        text: `Backdrop training context as JSON:\n\n${JSON.stringify(context)}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{
      role: 'user',
      content: `${verb} Focus day: ${date}.\n\nFocus as JSON:\n${JSON.stringify(focus)}`,
    }],
  });
  return { text: extractText(response), kind: focus.kind, model: CHAT_MODEL };
}

// Interactive chat reply. `messages` is the conversation so far — an array of
// {role, content} user/assistant turns sent in full by the client each turn
// (the server is stateless, no chat persistence). Fresh context is built and
// injected as a cacheable system prompt on every call so every reply is
// grounded in current training data. Returns the assistant reply text.
async function chatReply(db, messages) {
  const context = buildContext(db);
  const response = await getClient().messages.create({
    model: CHAT_MODEL,
    max_tokens: 800,
    system: [
      { type: 'text', text: CHAT_SYSTEM },
      {
        type: 'text',
        text: `Current training context as JSON:\n\n${JSON.stringify(context)}`,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages,
  });
  return extractText(response);
}

module.exports = { generateBrief, generateDetailedReport, generateDayInsight, chatReply, MODEL };
