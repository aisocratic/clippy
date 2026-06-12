'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  installHooks,
  uninstallHooks,
  listInstalled,
  hookCommand,
  SPECS,
  MARKER,
} = require('../bin/clippy-hooks');

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
  const cmd = hookCommand({ event: 'Stop' }, 43117);
  assert.match(cmd, /-m 2/); // curl timeout
  assert.match(cmd, /\|\| true/); // always exit 0
  assert.match(cmd, /127\.0\.0\.1:43117\/hook\/Stop/);
});
