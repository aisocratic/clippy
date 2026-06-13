'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  DecisionBroker,
  toHookResponse,
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
