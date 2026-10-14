const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CHAT_MODEL,
  chatReply,
  createResolvingTools,
  runCoachTool,
  visibleText,
} = require('./coach');

const params = {
  model: CHAT_MODEL,
  max_tokens: 4000,
  thinking: { type: 'adaptive' },
  output_config: { effort: 'medium' },
  system: [{ type: 'text', text: 'test' }],
};

function fakeClient(responses, calls) {
  return {
    messages: {
      create: async (request) => {
        calls.push(request);
        return responses.shift();
      },
    },
  };
}

test('tool loop keeps tools on the capped fallback and preserves thinking blocks', async () => {
  const calls = [];
  const responses = [];
  const contents = [];
  for (let index = 0; index < 4; index++) {
    const content = [
      { type: 'thinking', thinking: `reason ${index}`, signature: `sig ${index}` },
      { type: 'tool_use', id: `tool ${index}`, name: 'get_scheduled_workouts', input: {} },
    ];
    contents.push(content);
    responses.push({ stop_reason: 'tool_use', content });
  }
  responses.push({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'answer' }] });
  const db = { all: async () => [] };

  const response = await createResolvingTools(
    db,
    params,
    [{ role: 'user', content: 'question' }],
    { client: fakeClient(responses, calls) },
  );

  assert.equal(response.content[0].text, 'answer');
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => Array.isArray(call.tools)));
  assert.match(calls.at(-1).messages.at(-1).content[0].text, /Answer now/);
  for (let index = 0; index < contents.length; index++) {
    const assistant = calls[index + 1].messages.find(
      (message) => message.role === 'assistant' && message.content === contents[index]);
    assert.ok(assistant, `round ${index} content was not passed back unchanged`);
  }
});

test('a throwing tool becomes an error tool_result', async () => {
  const result = await runCoachTool(
    { all: async () => { throw new Error('database unavailable'); } },
    { id: 'tool 1', name: 'get_scheduled_workouts', input: {} },
  );
  assert.equal(result.type, 'tool_result');
  assert.equal(result.is_error, true);
  assert.match(result.content, /database unavailable/);
});

test('stop reasons surface truncation and refusal clearly', () => {
  assert.match(visibleText({
    stop_reason: 'max_tokens',
    content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'partial' }],
  }), /length limit/);
  assert.throws(
    () => visibleText({ stop_reason: 'refusal', content: [] }),
    /Coach unavailable.*refused/,
  );
});

test('chat supports injected eval context and disables tools', async () => {
  const calls = [];
  const reply = await chatReply(null, [{ role: 'user', content: 'Am I right?' }], {
    context: { today: '2026-10-14', signals: { flags: [] } },
    tools: false,
    client: fakeClient([
      { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'check' }, { type: 'text', text: 'No.' }] },
    ], calls),
  });
  assert.equal(reply, 'No.');
  assert.equal(calls[0].tools, undefined);
  assert.deepEqual(calls[0].thinking, { type: 'adaptive' });
  assert.deepEqual(calls[0].output_config, { effort: 'medium' });
  assert.equal(calls[0].max_tokens, 4000);
  assert.equal(calls[0].messages.at(-1).content.at(-1).cache_control.type, 'ephemeral');
});
