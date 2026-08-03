'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  DecisionBroker,
  toHookResponse,
  normalizeAnswers,
  describeToolCall,
  activityLabel,
} = require('../src/decisions');

test('resolve answers a pending ask', async () => {
  const broker = new DecisionBroker();
  const { id, promise } = broker.ask({ event: 'PermissionRequest', sessionId: 's1' }, 5000);

  assert.equal(broker.list().length, 1);
  assert.ok(broker.resolve(id, 'allow', 'fine by me'));
  assert.deepEqual(await promise, { action: 'allow', message: 'fine by me', timedOut: false });
  assert.equal(broker.list().length, 0);
  assert.equal(broker.resolve(id, 'allow'), false); // already gone
});

test('hasPending tracks whether a session is still waiting on the user', async () => {
  const broker = new DecisionBroker();
  const { id } = broker.ask({ event: 'PermissionRequest', sessionId: 's1' }, 5000);

  assert.equal(broker.hasPending('s1'), true);
  assert.equal(broker.hasPending('s2'), false);
  broker.resolve(id, 'allow');
  assert.equal(broker.hasPending('s1'), false);
});

test('unanswered asks time out', async () => {
  const broker = new DecisionBroker();
  const { promise } = broker.ask({ event: 'Stop', sessionId: 's1' }, 20);
  const result = await promise;
  assert.equal(result.action, 'timeout');
  assert.equal(result.timedOut, true);
});

test('extend pushes the deadline but never past the hard cap', () => {
  const broker = new DecisionBroker({ hardCapMs: 1000 });
  const { id, expiresAt } = broker.ask({ event: 'Stop', sessionId: 's1' }, 100);

  const extended = broker.extend(id, 500);
  assert.ok(extended > expiresAt);

  const capped = broker.extend(id, 60_000);
  assert.ok(capped <= Date.now() + 1000);

  broker.resolve(id, 'ok');
  assert.equal(broker.extend(id), null);
});

test('the initial hold is clamped to the hard cap', async () => {
  // Otherwise a big CLIPPY_*_HOLD_SECS outlives the hook's curl deadline and
  // the card is still on screen after Claude Code has moved on.
  const broker = new DecisionBroker({ hardCapMs: 30 });
  const { expiresAt, promise } = broker.ask({ event: 'Stop', sessionId: 's1' }, 10 * 60 * 1000);

  assert.ok(expiresAt <= Date.now() + 30, 'hold must not exceed the hard cap');
  assert.equal((await promise).timedOut, true);
});

test('cancelBySession drops only that session', async () => {
  const broker = new DecisionBroker();
  const a = broker.ask({ event: 'PermissionRequest', sessionId: 'a' }, 5000);
  const b = broker.ask({ event: 'PermissionRequest', sessionId: 'b' }, 5000);

  broker.cancelBySession('a');
  assert.deepEqual(await a.promise, { action: 'cancel', message: '', timedOut: false });
  assert.equal(broker.list().length, 1);
  broker.resolve(b.id, 'deny');
  assert.equal((await b.promise).action, 'deny');
});

test('PermissionRequest responses match the hook schema', () => {
  assert.deepEqual(toHookResponse('PermissionRequest', 'allow'), {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'allow' },
    },
  });

  const deny = toHookResponse('PermissionRequest', 'deny', 'use rg instead');
  assert.equal(deny.hookSpecificOutput.decision.behavior, 'deny');
  assert.equal(deny.hookSpecificOutput.decision.message, 'use rg instead');
  assert.ok(toHookResponse('PermissionRequest', 'deny').hookSpecificOutput.decision.message);

  // anything else must fall through to the normal permission flow
  assert.deepEqual(toHookResponse('PermissionRequest', 'pass'), {});
  assert.deepEqual(toHookResponse('PermissionRequest', 'timeout'), {});
  assert.deepEqual(toHookResponse('PermissionRequest', 'cancel'), {});
});

test('Stop responses block only on real feedback', () => {
  assert.deepEqual(toHookResponse('Stop', 'feedback', 'also add tests'), {
    decision: 'block',
    reason: 'also add tests',
  });
  assert.deepEqual(toHookResponse('Stop', 'feedback', '   '), {});
  assert.deepEqual(toHookResponse('Stop', 'ok'), {});
  assert.deepEqual(toHookResponse('Stop', 'timeout'), {});
  assert.deepEqual(toHookResponse('UnknownEvent', 'allow'), {});
});

test('normalizeAnswers produces one string per question', () => {
  // Single-select: the chosen label, as-is.
  assert.deepEqual(normalizeAnswers({ 'Which store?': 'Redis' }), { 'Which store?': 'Redis' });

  // Multi-select: comma-joined, the shape the terminal picker records.
  assert.deepEqual(
    normalizeAnswers({ Toppings: ['Cheese', 'Ham', 'Olives'] }),
    { Toppings: 'Cheese, Ham, Olives' }
  );

  // The UI hands it over as JSON on the IPC wire.
  assert.deepEqual(normalizeAnswers('{"Crust":["Thin"]}'), { Crust: 'Thin' });

  // Unanswered questions are dropped rather than sent as empty strings.
  assert.deepEqual(normalizeAnswers({ a: 'Yes', b: null, c: [], d: '  ' }), { a: 'Yes' });

  // Nothing usable -> null, so callers fall back to the terminal picker.
  assert.equal(normalizeAnswers('not json'), null);
  assert.equal(normalizeAnswers({}), null);
  assert.equal(normalizeAnswers({ a: '' }), null);
  assert.equal(normalizeAnswers(null), null);
  assert.equal(normalizeAnswers(['Redis']), null);
});

test('an answered AskUserQuestion comes back as updatedInput.answers', () => {
  const toolInput = {
    questions: [
      { question: 'Which store?', options: [{ label: 'Redis' }, { label: 'In-memory' }] },
    ],
  };

  const reply = toHookResponse('PreToolUse', 'answer', '{"Which store?":"Redis"}', { toolInput });
  assert.deepEqual(reply, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      // The original input is preserved; `answers` is what makes the tool
      // resolve without ever drawing the terminal picker.
      updatedInput: { ...toolInput, answers: { 'Which store?': 'Redis' } },
    },
  });

  // Everything else hands the question back to the terminal untouched.
  for (const action of ['pass', 'dismiss', 'timeout', 'cancel']) {
    assert.deepEqual(toHookResponse('PreToolUse', action, '', { toolInput }), {});
  }
  assert.deepEqual(toHookResponse('PreToolUse', 'answer', 'garbage', { toolInput }), {});
  assert.deepEqual(toHookResponse('PreToolUse', 'answer', '{}'), {});
});

test('describeToolCall summarizes common tools', () => {
  const bash = describeToolCall('Bash', { command: 'rm -rf /tmp/build', description: 'Clean build dir' });
  assert.match(bash.title, /Clean build dir/);
  assert.match(bash.detail, /\$ rm -rf \/tmp\/build/);

  const edit = describeToolCall('Edit', {
    file_path: '/a/b.js',
    old_string: 'foo',
    new_string: 'bar',
  });
  assert.match(edit.detail, /\/a\/b\.js/);
  assert.match(edit.detail, /- foo/);
  assert.match(edit.detail, /\+ bar/);

  const long = describeToolCall('Bash', { command: 'x'.repeat(2000) });
  assert.ok(long.detail.length < 800);
  assert.match(long.detail, /…$/);

  const other = describeToolCall('WebFetch', { url: 'https://example.com' });
  assert.match(other.title, /WebFetch/);
  assert.match(other.detail, /example\.com/);
});

test('describeToolCall renders an ExitPlanMode plan', () => {
  const plan = describeToolCall('ExitPlanMode', { plan: '# Plan\n- step one\n- step two' });
  assert.match(plan.title, /plan/i);
  assert.match(plan.detail, /step one/);
});

test('describeToolCall renders AskUserQuestion options', () => {
  const q = describeToolCall('AskUserQuestion', {
    questions: [
      {
        question: 'Which database?',
        options: [
          { label: 'Postgres', description: 'relational' },
          { label: 'Mongo', description: 'document' },
        ],
      },
    ],
  });
  assert.match(q.title, /Which database/);
  assert.match(q.detail, /Postgres/);
  assert.match(q.detail, /Mongo/);
});

test('activityLabel is terse and verb-forward', () => {
  assert.match(activityLabel('Bash', { command: 'npm test', description: 'Run tests' }), /Run tests/);
  assert.equal(activityLabel('Edit', { file_path: '/a/b/src/server.js' }), 'Editing server.js');
  assert.match(activityLabel('WebFetch', { url: 'https://example.com/x' }), /example\.com/);
  assert.match(activityLabel('ExitPlanMode', {}), /plan/i);
  assert.match(activityLabel('mcp__memory__create', {}), /memory__create/);
});
