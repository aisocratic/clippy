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

test('handles missing cwd and unknown events gracefully', () => {
  const t = new SessionTracker();
  const r = t.handle('Notification', null, { session_id: 'deadbeefcafe' });
  assert.equal(r.kind, 'attention');
  assert.match(r.message, /deadbeef/);
  assert.equal(t.handle('SomethingNew', null, payload('x')), null);
});
