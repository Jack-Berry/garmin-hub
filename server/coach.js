// AI coach — Claude client. Generates a daily coaching insight from the
// assembled training context (see context.js). Analyst, not workout generator.
const Anthropic = require('@anthropic-ai/sdk');
const { buildContext } = require('./context');

const MODEL = 'claude-opus-4-8';
// Conversational chat uses a faster/cheaper model — it's interactive and runs
// far more often than the daily insight.
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

let client;
const getClient = () => (client ||= new Anthropic());

// Generates the insight text. Returns { text, context, model } so the caller
// can persist it with the context's date range.
async function generateDailyInsight(db) {
  const context = buildContext(db);
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Here is today's training context as JSON. Write today's coaching insight.\n\n${JSON.stringify(context)}`,
    }],
  });
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return { text, context, model: MODEL };
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
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

module.exports = { generateDailyInsight, chatReply, MODEL };
