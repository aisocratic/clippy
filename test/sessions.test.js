'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
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

test('a failed tool arrives on PostToolUseFailure, not PostToolUse', () => {
  // Claude Code only fires PostToolUse on success, so this is the event that
  // actually produces the ⚠ in the activity line.
  const t = new SessionTracker();
  t.handle('SessionStart', null, payload('s1'));

  const failed = t.handle('PostToolUseFailure', null, {
    ...payload('s1'),
    tool_name: 'Bash',
    tool_input: { command: 'ls /nope', description: 'List a missing path' },
    error: 'Exit code 1\nls: /nope: No such file or directory',
    is_interrupt: false,
  });
  assert.equal(failed.activity.state, 'done');
  assert.equal(failed.activity.ok, false);
  assert.equal(failed.activity.error, 'Exit code 1'); // first line only
  assert.match(failed.message, /Bash failed/);

  // Hitting esc isn't a failure — don't cry wolf.
  const stopped = t.handle('PostToolUseFailure', null, {
    ...payload('s1'),
    tool_name: 'Bash',
    tool_input: { command: 'sleep 100' },
    error: 'Interrupted',
    is_interrupt: true,
  });
  assert.equal(stopped.activity.ok, true);
  assert.equal(stopped.message, '');
});

test('stale sessions are swept, parked ones get a longer leash', () => {
  const t = new SessionTracker();
  const now = Date.now();

  t.handle('SessionStart', null, payload('busy', '/p/busy'));
  t.handle('PreToolUse', null, { ...payload('busy'), tool_name: 'Bash', tool_input: {} });
  t.handle('Stop', null, payload('parked', '/p/parked'));
  assert.deepEqual(t.counts(), { total: 2, waiting: 1 });

  // Nothing is stale yet.
  assert.deepEqual(t.sweepStale(now), []);

  // A working session that has gone quiet is a dead terminal; a session parked
  // on the user is just someone who stepped away, so it survives.
  const removed = t.sweepStale(now + 45 * 60 * 1000);
  assert.deepEqual(removed.map((s) => s.sessionId), ['busy']);
  assert.deepEqual(t.counts(), { total: 1, waiting: 1 });

  assert.equal(t.sweepStale(now + 7 * 60 * 60 * 1000).length, 1);
  assert.deepEqual(t.counts(), { total: 0, waiting: 0 });
});

test('a session remembers the terminal window it runs in', () => {
  const t = new SessionTracker();
  const term = { program: 'Apple_Terminal', tty: '/dev/ttys004', pid: 4711 };

  // Learned before any event for that session has been handled.
  assert.equal(t.setTerminal('s1', term), true);
  assert.equal(t.setTerminal('s1', term), false); // only new the first time
  assert.equal(t.setTerminal('s1', null), false); // older hooks report nothing
  assert.deepEqual(t.terminalFor('s1'), term);

  t.handle('SessionStart', null, payload('s1'));
  assert.deepEqual(t.list()[0].terminal, term);

  t.handle('SessionEnd', null, payload('s1'));
  assert.equal(t.terminalFor('s1'), null);
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

test('Codex sessions keep their identity and detect non-zero PostToolUse exits', () => {
  const t = new SessionTracker();
  const codex = { ...payload('cx'), agent: 'codex' };
  const start = t.handle('SessionStart', null, codex);
  assert.equal(start.agent, 'codex');
  assert.equal(start.agentName, 'Codex');

  const failed = t.handle('PostToolUse', null, {
    ...codex,
    tool_name: 'Bash',
    tool_input: { command: 'false' },
    tool_response: { exit_code: 1 },
  });
  assert.equal(failed.activity.ok, false);
  assert.match(failed.message, /failed/);
  assert.equal(t.agentFor('cx'), 'codex');
});

test('OpenClaw sessions keep their identity, unknown agents fall back to Claude', () => {
  const t = new SessionTracker();
  const openclaw = { ...payload('openclaw:tg-42'), agent: 'openclaw' };
  const start = t.handle('SessionStart', null, openclaw);
  assert.equal(start.agent, 'openclaw');
  assert.equal(start.agentName, 'OpenClaw');

  const stop = t.handle('Stop', null, openclaw);
  assert.match(stop.message, /OpenClaw finished/);
  assert.equal(t.agentFor('openclaw:tg-42'), 'openclaw');
  // A later payload without an agent doesn't reset the session to Claude.
  t.handle('UserPromptSubmit', null, payload('openclaw:tg-42'));
  assert.equal(t.agentFor('openclaw:tg-42'), 'openclaw');

  const unknown = t.handle('SessionStart', null, { ...payload('u1'), agent: 'mystery' });
  assert.equal(unknown.agent, 'claude');
  assert.equal(unknown.agentName, 'Claude');
});

test('remembers a model reported by session hooks', () => {
  const t = new SessionTracker();
  const start = t.handle('SessionStart', null, {
    ...payload('modelled'),
    model: 'claude-sonnet-5',
  });
  assert.equal(start.model, 'claude-sonnet-5');
  assert.equal(t.modelFor('modelled'), 'claude-sonnet-5');

  t.handle('UserPromptSubmit', null, {
    ...payload('modelled'),
    model: { id: 'claude-opus-5', display_name: 'Opus' },
  });
  assert.equal(t.modelFor('modelled'), 'claude-opus-5');
});

test('handles missing cwd and unknown events gracefully', () => {
  const t = new SessionTracker();
  const r = t.handle('Notification', null, { session_id: 'deadbeefcafe' });
  assert.equal(r.kind, 'attention');
  assert.match(r.message, /deadbeef/);
  assert.equal(t.handle('SomethingNew', null, payload('x')), null);
});

test('only remembers a transcript path that is really an agent transcript', () => {
  const t = new SessionTracker();
  const home = os.homedir();
  const real = path.join(home, '.claude', 'projects', '-Users-me-app', 's1.jsonl');

  t.handle('Stop', null, { session_id: 's1', cwd: '/Users/me/app' });
  t.setTranscript('s1', real);
  assert.equal(t.transcriptFor('s1'), real);

  // A forged hook naming something the app has no business reading. Each is
  // refused outright, and the path we already trust is left alone.
  for (const forged of [
    '/etc/passwd',
    path.join(home, '.ssh', 'id_rsa'),
    path.join(home, '.ssh', 'id_rsa.jsonl'),
    path.join(home, '.claude', '..', '.ssh', 'id_rsa.jsonl'),
    path.join(home, '.claude', 'projects', '..', '..', '.aws', 'credentials.jsonl'),
    'relative.jsonl',
    `${real}\0/etc/passwd`,
    42,
    null,
  ]) {
    t.setTranscript('s1', forged);
    assert.equal(t.transcriptFor('s1'), real, `accepted ${String(forged)}`);
  }

  // Codex keeps its rollouts somewhere else entirely, and those are fine.
  const rollout = path.join(home, '.codex', 'sessions', '2026', '09', '01', 'rollout-x.jsonl');
  t.setTranscript('s1', rollout);
  assert.equal(t.transcriptFor('s1'), rollout);
});

test('an agent name that happens to be an Object property is not an agent', () => {
  const t = new SessionTracker();
  const r = t.handle('Stop', null, { session_id: 's1', cwd: '/Users/me/app', agent: 'constructor' });
  assert.equal(r.agent, 'claude');
  assert.equal(r.agentName, 'Claude');
  assert.match(r.message, /^Claude finished/);
  assert.equal(t.agentFor('s1'), 'claude');
});

test('terminal and transcript learned for a session nobody tracks do not pile up', () => {
  const t = new SessionTracker();
  const real = path.join(os.homedir(), '.claude', 'projects', '-x', 'ghost.jsonl');

  // A hook notes its terminal and transcript before the state machine sees it,
  // and some hooks are answered without ever reaching the state machine.
  t.setTerminal('ghost', { program: 'iTerm.app', tty: 'ttys004', pid: 1 });
  t.setTranscript('ghost', real);
  assert.ok(t.terminalFor('ghost'));
  assert.equal(t.transcriptFor('ghost'), real);

  assert.deepEqual(t.sweepStale(), []); // no session to remove...
  assert.equal(t.terminalFor('ghost'), null); // ...and nothing left behind
  assert.equal(t.transcriptFor('ghost'), '');

  // A session that is still being tracked keeps both.
  t.handle('PreToolUse', null, { session_id: 's1', cwd: '/Users/me/app', tool_name: 'Bash' });
  t.setTerminal('s1', { program: 'iTerm.app', tty: 'ttys005', pid: 2 });
  t.setTranscript('s1', real);
  t.sweepStale();
  assert.ok(t.terminalFor('s1'));
  assert.equal(t.transcriptFor('s1'), real);
});
