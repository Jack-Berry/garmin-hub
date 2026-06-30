// Pacer builder — conversational parameter gathering (Stage 5c).
//
// SEPARATE from the analyst coach (coach.js): this Sonnet flow ONLY conducts a
// short guided Q&A to extract the structured params for a pacing workout, then
// hands off to a deterministic preview. It cannot and does not push to Garmin —
// the build + upload happens in pacer_cli.py after the user approves a preview.
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-6';

// When the model has every parameter and the user has confirmed, it emits a
// fenced ```json block holding exactly this shape. The server parses it out.
const PARAMS_SHAPE = `{
  "distance_m": <number, metres>,
  "target": <string, e.g. "sub 20" or "4:00/km">,
  "strategy": "flat" | "negative",
  "segment_m": <number, default 500>,
  "warmup_m": <number or 0>,
  "cooldown_m": <number or 0>,
  "date": "YYYY-MM-DD"
}`;

const systemPrompt = (today) => `You help this runner set up a custom pacing workout (a "pacer") for their Engo 3 running glasses. You conduct a SHORT, friendly guided Q&A to gather the parameters, confirm them, then hand off to a preview. Today is ${today}.

You ONLY gather and confirm parameters. You do NOT build or push workouts — a deterministic preview-then-approve step does that after you. Never claim you have scheduled or pushed anything.

Parameters to collect:
- distance_m: the run distance in metres. The user gives this up front in their first message (e.g. "5k" = 5000, "10k" = 10000). Acknowledge it, don't re-ask.
- target: their goal, either a finish time or a pace. Parse natural phrasing: "sub 20" -> "sub 20", "19:54" -> "19:54", "4 min/km" -> "4:00/km". Keep finish times as-is and paces with "/km".
- strategy: "flat" (even pace) or "negative" (negative split — starts a touch slower, finishes fast). Ask which they want; explain briefly if needed.
- warmup_m / cooldown_m: optional easy-running metres before/after. Ask once; default both to 0 if they don't want any.
- date: which day to schedule it (resolve relative phrasing like "Saturday" to an actual YYYY-MM-DD using today's date above).

Be efficient and warm. Distance is already given, so confirm it and ask the few remaining questions, ideally grouping a couple together. Don't interrogate one field per message unnecessarily.

When you have ALL parameters AND the user has confirmed they look right, reply with a one-line confirmation followed by a fenced json code block with EXACTLY this shape and nothing after it:

\`\`\`json
${PARAMS_SHAPE}
\`\`\`

Until then, just keep the conversation going in plain friendly text with NO json block.`;

let client;
const getClient = () => (client ||= new Anthropic());

// Pull the params object out of a fenced ```json block, if the model emitted
// one (its "ready" signal). Returns the parsed object, or null if not ready.
function extractParams(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1].trim());
  } catch {
    return null;
  }
}

// Run one conversational turn. `messages` is the full chat so far. Returns
// { reply, params } — reply is the assistant text to display (json block
// stripped), params is the structured object when the Q&A is complete, else null.
async function pacerChat(messages, today) {
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 600,
    system: systemPrompt(today),
    messages,
  });
  const raw = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  const params = extractParams(raw);
  // Strip the json block from the visible reply; leave any lead-in confirmation.
  const reply = raw.replace(/```json[\s\S]*?```/i, '').trim()
    || 'Great — here are your pacer details. Building a preview…';
  return { reply, params };
}

module.exports = { pacerChat, MODEL };
