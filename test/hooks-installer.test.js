'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  installHooks,
  uninstallHooks,
  listInstalled,
  checkDrift,
  hookCommand,
  SPECS,
  MARKER,
  MEANINGFUL_TOOLS,
  QUESTION_TOOL,
} = require('../bin/clippy-hooks');

/** The install group for an event + matcher pair. */
const groupFor = (settings, event, matcher) =>
  (settings.hooks[event] || []).find((g) => (g.matcher || '') === (matcher || ''));

test('install adds all hooks and is idempotent', () => {
  const settings = installHooks({}, 43117);
  assert.equal(listInstalled(settings).length, SPECS.length);

  const notif = settings.hooks.Notification;
  assert.deepEqual(
    notif.map((g) => g.matcher),
    ['permission_prompt', 'idle_prompt']
  );
  assert.equal(notif[0].hooks[0].type, 'command');
  assert.equal(notif[0].hooks[0].timeout, 5);
  assert.match(notif[0].hooks[0].command, /hook\/Notification\?kind=permission_prompt/);
  assert.ok(notif[0].hooks[0].command.endsWith(MARKER));

  // re-install must not duplicate
  installHooks(settings, 43117);
  assert.equal(listInstalled(settings).length, SPECS.length);
});

test('uninstall removes only our hooks and preserves user hooks', () => {
  const settings = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './lint.sh' }] }],
    },
    model: 'opus',
  };
  installHooks(settings, 9999);
  assert.ok(listInstalled(settings).length > 0);

  uninstallHooks(settings);
  assert.equal(listInstalled(settings).length, 0);
  // user's own config untouched
  assert.equal(settings.model, 'opus');
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'say done');
  assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, './lint.sh');
  assert.equal(settings.hooks.SessionStart, undefined);
});

test('hook command never blocks or errors Claude Code', () => {
  const cmd = hookCommand({ event: 'SessionStart' }, 43117);
  assert.match(cmd, /-m 2/); // curl timeout
  assert.match(cmd, /\|\| true/); // always exit 0
  assert.match(cmd, /127\.0\.0\.1:43117\/hook\/SessionStart/);
});

test('decide hooks echo the response as their decision and fail fast when app is down', () => {
  const cmd = hookCommand({ event: 'PermissionRequest', mode: 'decide' }, 43117);
  assert.match(cmd, /--connect-timeout 1/); // no-op when Clippy isn't running
  assert.match(cmd, /\|\| true/);
  assert.match(cmd, /127\.0\.0\.1:43117\/hook\/PermissionRequest/);
  assert.doesNotMatch(cmd, />\/dev\/null 2>&1/); // stdout IS the decision
  assert.doesNotMatch(cmd, /\?kind=/); // kind is only for Notification hooks

  const settings = installHooks({}, 43117);
  for (const spec of SPECS.filter((s) => s.mode === 'decide')) {
    const group = groupFor(settings, spec.event, spec.matcher);
    assert.ok(
      group.hooks[0].timeout > 100,
      `${spec.event} needs headroom over curl -m`
    );
  }
});

test('activity hooks are fire-and-forget and scoped to meaningful tools', () => {
  const settings = installHooks({}, 43117);

  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    const group = groupFor(settings, event, MEANINGFUL_TOOLS);
    assert.ok(group, `${event} should carry the tool matcher`);
    const cmd = group.hooks[0].command;
    assert.match(cmd, new RegExp(`hook/${event}`));
    assert.doesNotMatch(cmd, /\?kind=/); // matcher is a Claude Code filter, not a ?kind
    assert.match(cmd, />\/dev\/null 2>&1/); // fire-and-forget, no decision echoed
    assert.equal(group.hooks[0].timeout, 5);
  }

  // The matcher must exclude the noisy read-only tools so they never fire.
  for (const noisy of ['Read', 'Grep', 'Glob', 'TodoWrite']) {
    assert.doesNotMatch(MEANINGFUL_TOOLS, new RegExp(`\\b${noisy}\\b`));
  }
  // ...and include the ones we care about.
  for (const wanted of ['Bash', 'Edit', 'ExitPlanMode']) {
    assert.match(MEANINGFUL_TOOLS, new RegExp(`\\b${wanted}\\b`));
  }
});

test('AskUserQuestion gets an interactive hook, not the fire-and-forget one', () => {
  const settings = installHooks({}, 43117);

  // Its own PreToolUse group, and its stdout is kept (that's the answer).
  const question = groupFor(settings, 'PreToolUse', QUESTION_TOOL);
  assert.ok(question, 'AskUserQuestion needs its own PreToolUse group');
  assert.doesNotMatch(question.hooks[0].command, />\/dev\/null 2>&1/);
  assert.ok(question.hooks[0].timeout > 100);

  // If it also rode the activity matcher, both hooks would fire for one call.
  assert.doesNotMatch(MEANINGFUL_TOOLS, /AskUserQuestion/);
  assert.equal(
    settings.hooks.PreToolUse.filter((g) => (g.matcher || '').includes(QUESTION_TOOL)).length,
    1
  );
});

test('checkDrift spots hooks older than this build, and a port mismatch', () => {
  assert.deepEqual(checkDrift({}, 43117), {
    installed: false,
    missing: [],
    wrongPort: false,
    noTerminalInfo: false,
  });

  const current = installHooks({}, 43117);
  assert.deepEqual(checkDrift(current, 43117), {
    installed: true,
    missing: [],
    wrongPort: false,
    noTerminalInfo: false,
  });

  // An install from an older Clippy: no question hook, no failure hook.
  const old = installHooks({}, 43117);
  old.hooks.PreToolUse = old.hooks.PreToolUse.filter((g) => g.matcher !== QUESTION_TOOL);
  delete old.hooks.PostToolUseFailure;
  const drift = checkDrift(old, 43117);
  assert.equal(drift.installed, true);
  assert.deepEqual(drift.missing, [
    `PreToolUse (${QUESTION_TOOL})`,
    `PostToolUseFailure (${MEANINGFUL_TOOLS})`,
  ]);

  assert.equal(checkDrift(installHooks({}, 43117), 5005).wrongPort, true);

  // An install from before Clippy learned to find a session's terminal window.
  const noTerm = installHooks({}, 43117);
  for (const groups of Object.values(noTerm.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        hook.command = hook.command.replace(/-H "X-Clippy-[^"]*" /g, '');
      }
    }
  }
  assert.equal(checkDrift(noTerm, 43117).noTerminalInfo, true);
});
