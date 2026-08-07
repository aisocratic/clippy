'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  installHooks,
  installCodexHooks,
  installToFiles,
  settingsPathFor,
  uninstallHooks,
  listInstalled,
  checkDrift,
  checkCodexDrift,
  hookCommand,
  statuslineCommand,
  removeCommandFile,
  SPECS,
  CODEX_SPECS,
  MARKER,
  MEANINGFUL_TOOLS,
  CODEX_MEANINGFUL_TOOLS,
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

test('Codex install uses its supported hook subset and tags the source', () => {
  const settings = installCodexHooks({}, 43117);
  assert.equal(listInstalled(settings).length, CODEX_SPECS.length);
  assert.equal(settings.hooks.Notification, undefined);
  assert.equal(settings.hooks.PostToolUseFailure, undefined);
  assert.equal(groupFor(settings, 'PreToolUse', 'AskUserQuestion'), undefined);

  const activity = groupFor(settings, 'PreToolUse', CODEX_MEANINGFUL_TOOLS);
  assert.ok(activity);
  assert.match(activity.hooks[0].command, /\?source=codex/);
  assert.match(CODEX_MEANINGFUL_TOOLS, /apply_patch/);
  assert.match(CODEX_MEANINGFUL_TOOLS, /request_user_input/);

  assert.deepEqual(checkCodexDrift(settings, 43117), {
    installed: true,
    missing: [],
    stale: false,
    wrongPort: false,
    noTerminalInfo: false,
  });
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
  const cmd = hookCommand({ event: 'UserPromptSubmit' }, 43117);
  assert.match(cmd, /-m 2/); // curl timeout
  assert.match(cmd, /\|\| true/); // always exit 0
  assert.match(cmd, /127\.0\.0\.1:43117\/hook\/UserPromptSubmit/);
  assert.match(cmd, />\/dev\/null 2>&1/); // fire-and-forget, nothing on the terminal
});

test('the hooks never subscribe SessionStart', () => {
  for (const specs of [SPECS, CODEX_SPECS]) {
    assert.ok(!specs.some((spec) => spec.event === 'SessionStart'));
  }
});

test('install claims the statusline only when free: the 📎, right-padded, linkable', () => {
  const settings = installHooks({}, 43117);
  assert.equal(settings.statusLine.type, 'command');
  assert.match(settings.statusLine.command, /127\.0\.0\.1:43117\/statusline\?cols=/);
  assert.match(settings.statusLine.command, /stty size <\/dev\/tty/); // width for right-alignment
  assert.match(settings.statusLine.command, /--connect-timeout 1/);
  assert.match(settings.statusLine.command, /curl -sf /); // an old app's 404 shows nothing
  assert.match(settings.statusLine.command, /\|\| true/);
  assert.ok(settings.statusLine.command.endsWith(MARKER));

  // re-install replaces rather than stacking
  installHooks(settings, 43117);
  assert.equal(settings.statusLine.command, statuslineCommand(43117));

  uninstallHooks(settings);
  assert.equal(settings.statusLine, undefined);

  // Codex has no statusline concept; its install must not invent the key
  assert.equal(installCodexHooks({}, 43117).statusLine, undefined);
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

// A statusline the way builds before this one wrote it into settings.json.
const OLD_STATUSLINE = {
  type: 'command',
  command: `curl -sf -X POST 'http://127.0.0.1:43117/statusline' --data-binary @- || true ${MARKER}`,
};

test('an older build\'s statusline is replaced by install, never the user\'s own', () => {
  // install replaces the whole previous footprint, statusline included
  const settings = installHooks({ statusLine: { ...OLD_STATUSLINE } }, 43117);
  assert.equal(settings.statusLine.command, statuslineCommand(43117));

  const removed = uninstallHooks({ statusLine: { ...OLD_STATUSLINE } });
  assert.equal(removed.statusLine, undefined);

  // a statusline the user wrote themselves survives both install and uninstall
  const theirs = { type: 'command', command: '~/bin/my-statusline.sh' };
  const user = installHooks({ statusLine: { ...theirs } }, 43117);
  assert.deepEqual(user.statusLine, theirs);
  uninstallHooks(user);
  assert.deepEqual(user.statusLine, theirs);
});

test('checkDrift flags leftovers from older builds as stale, but never the user\'s own', () => {
  // a name-plate statusline from before this build (it never probed the width)
  const old = installHooks({}, 43117);
  old.statusLine = { ...OLD_STATUSLINE };
  assert.equal(checkDrift(old, 43117).stale, true);
  assert.equal(checkDrift(installHooks({}, 43117), 43117).stale, false);

  // ...and a hook event this build no longer subscribes to
  const start = installHooks({}, 43117);
  start.hooks.SessionStart = [
    { hooks: [{ type: 'command', command: `curl -s -X POST 'http://127.0.0.1:43117/hook/SessionStart' ${MARKER}` }] },
  ];
  assert.equal(checkDrift(start, 43117).stale, true);

  // the user's own statusline is not ours to count, but its slot being taken
  // must not read as "missing" either
  const user = installHooks({}, 43117);
  user.statusLine = { type: 'command', command: '~/bin/my-statusline.sh' };
  const drift = checkDrift(user, 43117);
  assert.equal(drift.stale, false);
  assert.equal(drift.wrongPort, false);
  assert.deepEqual(drift.missing, []);

  // no statusline at all is an install from before there was one
  const bare = installHooks({}, 43117);
  delete bare.statusLine;
  assert.deepEqual(checkDrift(bare, 43117).missing, ['statusLine (the 📎 under the input box)']);

  // ours pointing at another port counts as moved
  const moved = installHooks({}, 43117);
  moved.statusLine = { type: 'command', command: statuslineCommand(5005) };
  assert.equal(checkDrift(moved, 43117).wrongPort, true);
});

test('checkDrift spots hooks older than this build, and a port mismatch', () => {
  assert.deepEqual(checkDrift({}, 43117), {
    installed: false,
    missing: [],
    stale: false,
    wrongPort: false,
    noTerminalInfo: false,
  });

  const current = installHooks({}, 43117);
  assert.deepEqual(checkDrift(current, 43117), {
    installed: true,
    missing: [],
    stale: false,
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

test('a leftover /clippy command from an older build is removed, a user\'s own survives', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-cmd-'));
  const file = path.join(dir, 'clippy.md');

  fs.writeFileSync(file, `---\ndescription: retired\n---\n<!-- ${MARKER} -->\n`);
  removeCommandFile(file);
  assert.ok(!fs.existsSync(file));

  // a clippy.md the user wrote themselves is not ours to delete
  fs.writeFileSync(file, 'my own clippy command');
  removeCommandFile(file);
  assert.equal(fs.readFileSync(file, 'utf8'), 'my own clippy command');

  // removing a file that isn't there is quiet
  removeCommandFile(path.join(dir, 'nope', 'clippy.md'));
});

test('settingsPathFor names each agent\'s user-level hook file', () => {
  assert.ok(settingsPathFor('claude').endsWith(path.join('.claude', 'settings.json')));
  assert.ok(settingsPathFor('codex').endsWith(path.join('.codex', 'hooks.json')));
});

test('installToFiles writes both agents\' files in-process and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-hooks-'));
  const pathFor = (agent) => path.join(dir, agent, agent === 'claude' ? 'settings.json' : 'hooks.json');
  const commandFile = path.join(dir, 'commands', 'clippy.md');

  // a command file from the builds that installed one is cleared on install
  fs.mkdirSync(path.dirname(commandFile), { recursive: true });
  fs.writeFileSync(commandFile, `retired ${MARKER}\n`);

  const results = installToFiles({ port: 5005, pathFor, commandFile });
  assert.deepEqual(results.map((r) => [r.agent, r.ok]), [['claude', true], ['codex', true]]);
  assert.ok(!fs.existsSync(commandFile));

  const claude = JSON.parse(fs.readFileSync(pathFor('claude'), 'utf8'));
  assert.equal(listInstalled(claude).length, SPECS.length);
  assert.deepEqual(checkDrift(claude, 5005), {
    installed: true, missing: [], stale: false, wrongPort: false, noTerminalInfo: false,
  });
  const codex = JSON.parse(fs.readFileSync(pathFor('codex'), 'utf8'));
  assert.equal(listInstalled(codex).length, CODEX_SPECS.length);

  // Second run replaces rather than duplicates, and unrelated keys survive.
  claude.theme = 'dark';
  fs.writeFileSync(pathFor('claude'), JSON.stringify(claude));
  installToFiles({ port: 5005, agents: ['claude'], pathFor, commandFile });
  const again = JSON.parse(fs.readFileSync(pathFor('claude'), 'utf8'));
  assert.equal(listInstalled(again).length, SPECS.length);
  assert.equal(again.theme, 'dark');
});

test('installToFiles reports a broken config without clobbering it or the other agent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-hooks-'));
  const pathFor = (agent) => path.join(dir, `${agent}.json`);
  fs.writeFileSync(pathFor('claude'), '{ not json');

  const results = installToFiles({ pathFor, commandFile: path.join(dir, 'clippy.md') });
  const byAgent = Object.fromEntries(results.map((r) => [r.agent, r]));
  assert.equal(byAgent.claude.ok, false);
  assert.match(byAgent.claude.error, /not valid JSON/);
  assert.equal(fs.readFileSync(pathFor('claude'), 'utf8'), '{ not json'); // untouched
  assert.equal(byAgent.codex.ok, true); // the healthy agent still installs
});
