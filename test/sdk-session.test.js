'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  DriveSession,
  toPermissionResult,
  normalizeMessage,
} = require('../src/sdk-session');

test('toPermissionResult maps card decisions to the SDK shape', () => {
  // AskUserQuestion: an answer becomes updatedInput.answers
  const ans = toPermissionResult(
    'AskUserQuestion',
    'answer',
    JSON.stringify({ 'Which DB?': 'Postgres' }),
    { questions: [{ question: 'Which DB?' }] }
  );
  assert.equal(ans.behavior, 'allow');
  assert.deepEqual(ans.updatedInput.answers, { 'Which DB?': 'Postgres' });

  // dismissing a question denies the tool
  assert.equal(toPermissionResult('AskUserQuestion', 'dismiss', '', {}).behavior, 'deny');

  // plain tools / plans: allow passes input through, deny carries the message
  assert.deepEqual(toPermissionResult('Bash', 'allow', '', { command: 'ls' }), {
    behavior: 'allow',
    updatedInput: { command: 'ls' },
  });
  const deny = toPermissionResult('ExitPlanMode', 'deny', 'add tests first', {});
  assert.equal(deny.behavior, 'deny');
  assert.equal(deny.message, 'add tests first');

  // timeout/cancel default to a safe deny (Drive owns the session)
  assert.equal(toPermissionResult('Bash', 'timeout', '', {}).behavior, 'deny');
});

test('normalizeMessage extracts text and tool activity', () => {
  const text = normalizeMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
  assert.deepEqual(text, [{ kind: 'text', role: 'assistant', text: 'hi' }]);

  const tool = normalizeMessage({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] },
  });
  assert.equal(tool[0].kind, 'activity');
  assert.match(tool[0].label, /Run tests/);

  assert.deepEqual(normalizeMessage({ type: 'result', result: 'done' }), [{ kind: 'result', text: 'done' }]);
  assert.deepEqual(normalizeMessage(null), []);
});

test('DriveSession answers AskUserQuestion through canUseTool', async () => {
  const events = [];
  let captured = null;

  // Fake SDK query: records options, drives the stream and the canUseTool call.
  const fakeRunQuery = (opts) => {
    captured = opts;
    return (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me ask.' }] } };

      const result = await opts.options.canUseTool(
        'AskUserQuestion',
        {
          questions: [
            { question: 'Which store?', options: [{ label: 'Redis' }, { label: 'In-memory' }] },
          ],
        },
        {}
      );
      // The SDK would receive the user's selection here.
      yield { type: 'assistant', message: { content: [{ type: 'text', text: `chose ${JSON.stringify(result.updatedInput.answers)}` }] } };
      yield { type: 'result', result: 'ok' };
    })();
  };

  const session = new DriveSession({
    cwd: '/tmp/proj',
    runQuery: fakeRunQuery,
    send: (e) => events.push(e),
  });

  await session.start();
  // Feed a prompt (streaming input).
  session.prompt('set up rate limiting');

  // Wait for the 'answer' card event the canUseTool callback emitted.
  const answerEvt = await waitFor(events, (e) => e.kind === 'answer');
  assert.match(answerEvt.title, /Which store/);

  // Answer it like the option buttons would.
  const ok = session.resolve(answerEvt.requestId, 'answer', JSON.stringify({ 'Which store?': 'Redis' }));
  assert.equal(ok, true);

  // The model receives the answer and the transcript reflects it.
  const chose = await waitFor(events, (e) => e.kind === 'drive-transcript' && /Redis/.test(e.text || ''));
  assert.ok(chose);

  // The streaming-input generator actually received the prompt.
  assert.equal(typeof captured.options.canUseTool, 'function');
  session.stop();
});

test('DriveSession routes ExitPlanMode + tool approvals to cards', async () => {
  const events = [];
  const fakeRunQuery = (opts) =>
    (async function* () {
      const plan = await opts.options.canUseTool('ExitPlanMode', { plan: '# do things' }, {});
      yield { type: 'assistant', message: { content: [{ type: 'text', text: plan.behavior }] } };
      const bash = await opts.options.canUseTool('Bash', { command: 'rm -rf x' }, {});
      yield { type: 'assistant', message: { content: [{ type: 'text', text: bash.behavior }] } };
      yield { type: 'result', result: 'ok' };
    })();

  const session = new DriveSession({ cwd: '/tmp/p', runQuery: fakeRunQuery, send: (e) => events.push(e) });
  await session.start();

  const planCard = await waitFor(events, (e) => e.kind === 'approval' && e.variant === 'plan');
  assert.equal(planCard.noPass, true);
  session.resolve(planCard.requestId, 'allow');

  const bashCard = await waitFor(events, (e) => e.kind === 'approval' && e.tool === 'Bash');
  session.resolve(bashCard.requestId, 'deny', 'too risky');

  await waitFor(events, (e) => e.kind === 'drive-transcript' && e.text === 'deny');
  session.stop();
});

/* poll the events array until predicate matches (the fake stream runs async) */
async function waitFor(events, pred, ms = 1000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const hit = events.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('timed out waiting for event; saw: ' + JSON.stringify(events.map((e) => e.kind)));
}
