'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { SessionTracker } = require('../src/sessions');

const payload = (id, cwd = '/Users/me/projects/my-app') => ({
  session_id: id,
  cwd,
  transcript_path: '/tmp/t.jsonl',
});

test('session lifecycle produces the right reactions', () => {
  const t = new SessionTracker();

  const start = t.handle('SessionStart', null, payload('s1'));
  assert.equal(start.kind, 'info');
  assert.equal(start.name, 'my-app');
  assert.deepEqual(t.counts(), { total: 1, waiting: 0 });

  const prompt = t.handle('UserPromptSubmit', null, payload('s1'));
  assert.equal(prompt.kind, 'clear');
  assert.deepEqual(t.counts(), { total: 1, waiting: 0 });

  const perm = t.handle('Notification', 'permission_prompt', payload('s1'));
  assert.equal(perm.kind, 'attention');
  assert.equal(perm.urgency, 'urgent');
  assert.match(perm.message, /permission/);
  assert.match(perm.message, /my-app/);
  assert.deepEqual(t.counts(), { total: 1, waiting: 1 });

  // user approves, Claude works again, then finishes
  t.handle('UserPromptSubmit', null, payload('s1'));
  const stop = t.handle('Stop', null, payload('s1'));
  assert.equal(stop.kind, 'attention');
  assert.equal(stop.urgency, 'normal');
  assert.deepEqual(t.counts(), { total: 1, waiting: 1 });

  const idle = t.handle('Notification', 'idle_prompt', payload('s1'));
  assert.equal(idle.kind, 'attention');
  assert.match(idle.message, /waiting/);

  const end = t.handle('SessionEnd', null, payload('s1'));
  assert.equal(end.kind, 'remove');
  assert.deepEqual(t.counts(), { total: 0, waiting: 0 });
});

test('tracks multiple sessions independently', () => {
  const t = new SessionTracker();
  t.handle('SessionStart', null, payload('a', '/repo/alpha'));
  t.handle('SessionStart', null, payload('b', '/repo/beta'));
  t.handle('UserPromptSubmit', null, payload('a', '/repo/alpha'));
  t.handle('Notification', 'permission_prompt', payload('b', '/repo/beta'));

  assert.deepEqual(t.counts(), { total: 2, waiting: 1 });
  const beta = t.list().find((s) => s.sessionId === 'b');
  assert.equal(beta.status, 'needs_permission');
  const alpha = t.list().find((s) => s.sessionId === 'a');
  assert.equal(alpha.status, 'working');
});

test('PreToolUse/PostToolUse drive the activity line (meaningful tools only)', () => {
  const t = new SessionTracker();
  t.handle('SessionStart', null, payload('s1'));

  const pre = t.handle('PreToolUse', null, {
    ...payload('s1'),
    tool_name: 'Bash',
    tool_input: { command: 'npm test', description: 'Run tests' },
  });
  assert.equal(pre.kind, 'activity');
  assert.equal(pre.activity.tool, 'Bash');
  assert.equal(pre.activity.state, 'start');
  assert.match(pre.activity.label, /Run tests/);
  assert.equal(t.list()[0].activity.label, pre.activity.label);

  const ok = t.handle('PostToolUse', null, {
    ...payload('s1'),
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    success: true,
  });
  assert.equal(ok.activity.state, 'done');
  assert.equal(ok.activity.ok, true);

  const fail = t.handle('PostToolUse', null, {
    ...payload('s1'),
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    success: false,
  });
  assert.equal(fail.activity.ok, false);
  assert.match(fail.message, /failed/);

  // UserPromptSubmit resets the activity; SessionStart clears it.
  assert.equal(t.handle('UserPromptSubmit', null, payload('s1')).activity.label, 'Working…');
});

test('setActivity updates a tracked session', () => {
  const t = new SessionTracker();
  t.handle('SessionStart', null, payload('s1'));
  t.setActivity('s1', { tool: 'Edit', label: 'Editing x.js', state: 'start', ok: true });
  assert.equal(t.list()[0].activity.label, 'Editing x.js');
});

test('PermissionRequest marks the session as needing permission', () => {
  const t = new SessionTracker();
  t.handle('SessionStart', null, payload('s1'));

  const r = t.handle('PermissionRequest', null, payload('s1'));
  assert.equal(r.kind, 'approval');
  assert.equal(r.urgency, 'urgent');
  assert.match(r.message, /my-app/);
  assert.deepEqual(t.counts(), { total: 1, waiting: 1 });

  t.setStatus('s1', 'working');
  assert.equal(t.list()[0].status, 'working');
  assert.deepEqual(t.counts(), { total: 1, waiting: 0 });
});

test('handles missing cwd and unknown events gracefully', () => {
  const t = new SessionTracker();
  const r = t.handle('Notification', null, { session_id: 'deadbeefcafe' });
  assert.equal(r.kind, 'attention');
  assert.match(r.message, /deadbeef/);
  assert.equal(t.handle('SomethingNew', null, payload('x')), null);
});
