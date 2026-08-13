'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  DecisionBroker,
  toHookResponse,
  normalizeAnswers,
  describeToolCall,
  activityLabel,
  FULL_DETAIL_MAX,
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

test('Stop is always answered with no opinion — the chat is never held', () => {
  // Review feedback goes back as a typed prompt, never as a hook decision.
  assert.deepEqual(toHookResponse('Stop', 'feedback', 'also add tests'), {});
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

test('an answered Codex request_user_input skips the native picker with a tool result', () => {
  const toolInput = {
    questions: [
      {
        id: 'store',
        header: 'Store',
        question: 'Which store?',
        options: [{ label: 'Redis', description: 'Shared state' }],
      },
    ],
  };

  const reply = toHookResponse(
    'PreToolUse',
    'answer',
    '{"Which store?":"Redis"}',
    { toolInput, source: 'codex', toolName: 'request_user_input' }
  );
  assert.equal(reply.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(reply.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(reply.hookSpecificOutput.permissionDecisionReason, /answered this request through Clippy/);
  assert.match(
    reply.hookSpecificOutput.permissionDecisionReason,
    /"answers":\{"store":\{"answers":\["Redis"\]\}\}/
  );

  for (const action of ['pass', 'dismiss', 'timeout', 'cancel']) {
    assert.deepEqual(
      toHookResponse('PreToolUse', action, '', {
        toolInput,
        source: 'codex',
        toolName: 'request_user_input',
      }),
      {}
    );
  }
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
  // The card leads with the file's name and never dumps the contents — the
  // full path is there for "which repo?", the diff belongs in the editor.
  assert.equal(edit.title, 'Edit b.js');
  assert.match(edit.detail, /\/a\/b\.js/);
  assert.doesNotMatch(edit.detail, /foo|bar/);

  const long = describeToolCall('Bash', { command: 'x'.repeat(2000) });
  assert.ok(long.detail.length < 800);
  assert.match(long.detail, /…$/);

  const other = describeToolCall('WebFetch', { url: 'https://example.com' });
  assert.match(other.title, /WebFetch/);
  assert.match(other.detail, /example\.com/);
});

test('a cut card keeps the rest of the message for "read all"', () => {
  const long = describeToolCall('Bash', { command: 'x'.repeat(2000) });
  // What the card shows is cut; what it can grow into is not.
  assert.match(long.detail, /…$/);
  assert.ok(long.fullDetail.length > long.detail.length);
  assert.doesNotMatch(long.fullDetail, /…$/);
  assert.ok(long.fullDetail.includes('x'.repeat(2000)));

  // Nothing was cut, so there is nothing to offer — the empty string is what
  // tells the card not to show the button at all.
  assert.equal(describeToolCall('Bash', { command: 'ls' }).fullDetail, '');
  assert.equal(describeToolCall('Edit', { file_path: '/a/b.js' }).fullDetail, '');

  // Even the whole version has a ceiling: this is a window over a desktop.
  const huge = describeToolCall('Write', { file_path: '/a/b.txt', content: 'y'.repeat(FULL_DETAIL_MAX * 2) });
  assert.ok(huge.fullDetail.length <= FULL_DETAIL_MAX + 200);
  assert.match(huge.fullDetail, /…$/);
});

test('Codex apply_patch calls name the edited file', () => {
  const input = { command: '*** Begin Patch\n*** Update File: /repo/src/app.js\n@@\n-old\n+new\n*** End Patch' };
  const described = describeToolCall('apply_patch', input);
  assert.equal(described.title, 'Edit app.js');
  assert.equal(described.detail, '/repo/src/app.js');
  assert.equal(activityLabel('apply_patch', input), 'Editing app.js');
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

test('a multi-select answered in Clippy reaches Codex as a list, not one joined label', () => {
  // The bug this covers: normalizeAnswers joins with commas because Claude's
  // updatedInput wants one string per question. Codex takes one entry per
  // chosen option, so joining produced `answers: ["Redis, Postgres"]` — a
  // single option label matching nothing it offered, and an answer that
  // therefore meant nothing.
  const toolInput = {
    questions: [
      {
        id: 'stores',
        question: 'Which stores?',
        multiSelect: true,
        options: [{ label: 'Redis' }, { label: 'Postgres' }],
      },
    ],
  };
  const reply = toHookResponse('PreToolUse', 'answer', '{"Which stores?":["Redis","Postgres"]}', {
    toolInput,
    source: 'codex',
    toolName: 'request_user_input',
  });
  assert.match(
    reply.hookSpecificOutput.permissionDecisionReason,
    /"stores":\{"answers":\["Redis","Postgres"\]\}/
  );
});

test('a single-choice Codex answer is still a one-item list', () => {
  const toolInput = { questions: [{ id: 'store', question: 'Which store?', options: [{ label: 'Redis' }] }] };
  const reply = toHookResponse('PreToolUse', 'answer', '{"Which store?":"Redis"}', {
    toolInput,
    source: 'codex',
    toolName: 'request_user_input',
  });
  assert.match(reply.hookSpecificOutput.permissionDecisionReason, /"store":\{"answers":\["Redis"\]\}/);
});

test('a Codex question with no id cannot be answered, and says so by declining', () => {
  // Answering by position would be a guess about which question we replied to.
  // Handing it back is the honest failure: Codex asks in its own picker.
  const toolInput = { questions: [{ question: 'Which store?', options: [{ label: 'Redis' }] }] };
  assert.deepEqual(
    toHookResponse('PreToolUse', 'answer', '{"Which store?":"Redis"}', {
      toolInput,
      source: 'codex',
      toolName: 'request_user_input',
    }),
    {}
  );
});
