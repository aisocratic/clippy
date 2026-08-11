'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFile, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  shQuote,
  oneLine,
  escapeSemicolon,
  needsFlattening,
  sessionName,
  isValidSessionName,
  loginShell,
  launchCommand,
  newSessionArgs,
  hasSessionArgs,
  listPanesArgs,
  killSessionArgs,
  paneInfoArgs,
  capturePaneArgs,
  loadBufferArgs,
  pasteBufferArgs,
  sendKeysArgs,
  sendKeysLiteralArgs,
  attachCommand,
  parseNewSession,
  parseSessionList,
  parsePaneList,
  parsePaneInfo,
  tmuxCandidates,
  DETACHED_SIZE,
} = require('../src/tmux');

const sh = (script) =>
  new Promise((resolve, reject) =>
    execFile('/bin/sh', ['-c', script], (err, stdout) => (err ? reject(err) : resolve(stdout)))
  );

/**
 * A directory holding stand-ins that print their own argv, so a generated
 * command line can be checked by *running* it rather than by matching a regex
 * against layers of nested quoting. `ssh` is here so the ssh launch line can be
 * peeled apart without a network.
 */
const STUB = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-tmux-stub-'));
const PRINT_ARGV = '#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n';
for (const name of ['argv', 'ssh']) {
  fs.writeFileSync(path.join(STUB, name), PRINT_ARGV, { mode: 0o755 });
}
process.on('exit', () => fs.rmSync(STUB, { recursive: true, force: true }));

/** Run `script` under /bin/sh and return the argv its stub printed. */
const runArgv = (script, PATH = process.env.PATH, env = {}) =>
  execFileSync('/bin/sh', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH, ...env },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\n')
    .filter((line) => line.startsWith('[') && line.endsWith(']'))
    .map((line) => line.slice(1, -1));

/** The argv a launch line hands to the shell it names. */
const argvOf = (command) =>
  runArgv(command.replace(/^exec '[^']*'/, `exec '${path.join(STUB, 'argv')}'`));

/** Stop before the persistent login shell that follows the agent command. */
const withoutPersistentShell = (script) => script.replace(/; exec '[^']+' -il$/, '');

test('a session name survives whatever the folder was called', () => {
  assert.equal(sessionName('My.App', { now: 0 }), 'clippy-my-app-0');
  assert.equal(sessionName('/Users/me/Web UI!', { now: 0 }), 'clippy-users-me-web-ui-0');
  // tmux silently rewrites ':' and '.' in names, so we never hand it one.
  for (const label of ['a.b', 'a:b', 'a b', '', '!!!', 'x'.repeat(80)]) {
    const name = sessionName(label, { now: 1 });
    assert.ok(isValidSessionName(name), `${label} -> ${name}`);
    assert.doesNotMatch(name, /[.: ]/);
  }
  assert.equal(sessionName('', { now: 0 }), 'clippy-agent-0');
});

test('a second session in the same folder gets a different name', () => {
  const now = 12345;
  assert.notEqual(sessionName('app', { now }), sessionName('app', { now, seq: 1 }));
});

test('shQuote survives everything a shell would otherwise eat', async () => {
  for (const raw of ["it's", '$HOME', '`whoami`', 'a\\b', 'a;rm -rf /', 'a b', '$(id)', '"q"']) {
    assert.equal(await sh(`printf %s ${shQuote(raw)}`), raw);
  }
});

test('the launch line resolves the agent through a login shell, and outlives it', () => {
  // -ilc, because a Finder-launched Electron app has a bare PATH and the tmux
  // server inherits it — `claude` is only findable the way the user finds it.
  const command = launchCommand({ agent: 'claude', sessionId: 'abc-123', shell: '/bin/zsh' });
  assert.match(command, /^exec '\/bin\/zsh' -ilc /);

  // What the shell is actually handed, rather than what the string looks like:
  // exactly one command argument, whatever the quoting had to do to get there.
  const [flags, script, ...extra] = argvOf(command);
  assert.equal(flags, '-ilc');
  assert.deepEqual(extra, [], 'the whole command must be a single argument');
  assert.ok(script.startsWith("claude --session-id 'abc-123'"), script);
  // The pane drops to a shell rather than dying, so the session persists.
  assert.ok(script.endsWith("; exec '/bin/zsh' -il"), script);
});

test('the ssh launch line quotes the host and leaves the remote $SHELL alone', () => {
  const command = launchCommand({
    agent: 'codex',
    host: 'me@box',
    remotePath: "/srv/it's app",
    shell: '/bin/zsh',
  });

  assert.match(command, /ssh -t /);
  assert.ok(command.includes('me@box'));
  // Unexpanded on purpose: it is the *remote* user's shell, resolved over there.
  assert.ok(command.includes('"$SHELL"'), 'the remote shell must not expand locally');
  // Codex has no --session-id to give.
  assert.doesNotMatch(command, /--session-id/);
  assert.ok(command.includes('codex'));
});

test('a prompt handed to the agent at launch is one argument, not a second command', () => {
  const command = launchCommand({ agent: 'claude', prompt: 'fix it; rm -rf /tmp/NOPE', shell: '/bin/sh' });
  const [, script] = argvOf(command);

  // The semicolon stays inside the agent's argument; it never becomes a
  // command separator in the shell that runs the pane.
  assert.ok(script.startsWith("claude 'fix it; rm -rf /tmp/NOPE'"), script);
});

test('an ssh launch survives a project path with a quote in it, at every layer', () => {
  const remotePath = "/srv/it's app";
  const [, script] = argvOf(launchCommand({ agent: 'codex', host: 'me@box', remotePath, shell: '/bin/sh' }));

  // Layer 2: ssh gets -t, the host, and exactly one remote command.
  const [dashT, host, remote, ...rest] = runArgv(
    withoutPersistentShell(script),
    `${STUB}:${process.env.PATH}`
  );
  assert.equal(dashT, '-t');
  assert.equal(host, 'me@box');
  assert.ok(rest.length <= 1, 'ssh takes one remote command'); // the trailing `exec sh -il`

  // Layer 3: the remote shell parses that back into the original path.
  const [remoteFlags, remoteScript] = runArgv(remote, `${STUB}:${process.env.PATH}`, {
    SHELL: path.join(STUB, 'argv'),
  });
  assert.equal(remoteFlags, '-ilc');
  assert.ok(remoteScript.includes(`cd ${shQuote(remotePath)}`), remoteScript);
  assert.ok(remoteScript.endsWith('exec codex'), remoteScript);
});

test('the pane\'s ssh opens the connection the transcript probe will reuse', () => {
  const controlPath = '/tmp/cp/ssh-%r@%h-%p';
  const [, script] = argvOf(
    launchCommand({ agent: 'claude', host: 'me@box', remotePath: '~/my app', sessionId: 'u-1', controlPath, shell: '/bin/sh' })
  );
  const argv = runArgv(withoutPersistentShell(script), `${STUB}:${process.env.PATH}`);

  // Each -o must arrive as its own argument, not one run-together word.
  assert.deepEqual(argv.slice(0, 2), ['-t', '-o']);
  assert.ok(argv.includes(`ControlPath=${controlPath}`), argv.join(' '));
  assert.ok(argv.includes('ControlMaster=auto'));
  assert.ok(argv.includes('me@box'));

  // A `~` has to expand on the far side; quoting it would break `cd`.
  const remote = argv[argv.indexOf('me@box') + 1];
  assert.ok(remote.includes('cd "$HOME"/'), remote);
  assert.ok(remote.includes("'my app'"), remote);

  // Without a control path nothing extra is added.
  assert.doesNotMatch(launchCommand({ agent: 'claude', host: 'h', shell: '/bin/sh' }), /ControlMaster/);
});

test('new-session reports its pane, sizes itself, and takes the command last', () => {
  const args = newSessionArgs({ name: 'clippy-a-1', cwd: '/tmp/x', command: 'exec zsh' });

  assert.equal(args[0], 'new-session');
  assert.ok(args.includes('-d'));
  assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', '/tmp/x']);
  // Detached sessions default to 80x24, and the TUI renders at that width forever.
  assert.deepEqual(args.slice(args.indexOf('-x'), args.indexOf('-x') + 2), [
    '-x',
    String(DETACHED_SIZE.width),
  ]);
  assert.deepEqual(args.slice(args.indexOf('-F'), args.indexOf('-F') + 2), [
    '-F',
    '#{pane_id} #{pane_pid}',
  ]);
  assert.equal(args.at(-1), 'exec zsh', 'the command is one argv element, at the end');
});

test('every target is an exact match, so a name is never a prefix of another', () => {
  // Without '=', `-t clippy-app` also selects `clippy-app-2`.
  for (const args of [hasSessionArgs('clippy-app'), listPanesArgs('clippy-app'), killSessionArgs('clippy-app')]) {
    assert.ok(args.includes('=clippy-app'), args.join(' '));
    assert.ok(!args.includes('clippy-app'), 'the bare name must not be the target');
  }
});

test('the attach command quotes the target, because zsh expands a bare =name', () => {
  const command = attachCommand('/opt/homebrew/bin/tmux', 'clippy-a-1');
  assert.equal(command, "'/opt/homebrew/bin/tmux' attach -t '=clippy-a-1'");
});

test('a prompt reaches tmux on stdin, never through its command parser', () => {
  const load = loadBufferArgs('clippy-1');
  assert.equal(load.at(-1), '-', 'load-buffer reads the prompt from stdin');

  const paste = pasteBufferArgs('%3', 'clippy-1');
  assert.ok(paste.includes('-p'), 'bracketed paste is what makes newlines survive');
  assert.ok(paste.includes('-d'));
});

test('the send-keys fallback is defended against tmux argument parsing', () => {
  const args = sendKeysLiteralArgs('%3', '-n');
  assert.equal(args.at(-2), '--', 'a leading dash must not be read as a flag');
  assert.equal(args.at(-1), '-n');
  assert.deepEqual(sendKeysArgs('%3', 'Enter').at(-1), 'Enter');

  // tmux reads a trailing ';' as a command separator and eats it.
  assert.equal(escapeSemicolon('run make;'), 'run make\\;');
  assert.equal(escapeSemicolon('a;b'), 'a;b');
  assert.equal(escapeSemicolon(''), '');
});

test('oneLine collapses a prompt the same way a keystroke has to', () => {
  assert.equal(oneLine('first\n\n  second  \nthird'), 'first second third');
});

test('a multi-line prompt is only flattened for panes that submit on newline', () => {
  const prompt = 'first line\nsecond line';

  // An agent's process name is not predictable: Claude Code renames itself to
  // its own version number, and a shim shows up as whatever the shim is. An
  // unrecognised command is therefore assumed to be a TUI that can take a
  // bracketed paste — flattening those was the bug this guards.
  for (const command of ['2.1.227', 'claude', 'codex', 'node', 'bun', 'python3.13']) {
    assert.equal(needsFlattening(command, prompt), false, command);
  }
  // The pane the agent drops to when it exits really does submit on newline.
  for (const command of ['zsh', 'bash', 'fish', 'less', 'cat']) {
    assert.equal(needsFlattening(command, prompt), true, command);
  }
  // A single-line prompt is never at risk either way.
  assert.equal(needsFlattening('zsh', 'just one line'), false);
  assert.equal(needsFlattening(null, prompt), false);
});

test('pane inspection asks what is running, since the pane outlives the agent', () => {
  assert.ok(paneInfoArgs('%3').includes('#{pane_current_command}\t#{pane_dead}'));
  assert.ok(capturePaneArgs('%3', { lines: 50 }).includes('-50'));
});

test('parsers read tmux output, and reject anything else', () => {
  assert.deepEqual(parseNewSession('%12 34567\n'), { paneId: '%12', panePid: 34567 });
  assert.equal(parseNewSession('no such session'), null);
  assert.equal(parseNewSession(''), null);

  assert.deepEqual(parseSessionList('a\nclippy-b-1\n\n'), ['a', 'clippy-b-1']);
  assert.deepEqual(parseSessionList(''), []);

  assert.deepEqual(parsePaneList('%1 100\n%2 200\n'), [
    { paneId: '%1', panePid: 100 },
    { paneId: '%2', panePid: 200 },
  ]);

  assert.deepEqual(parsePaneInfo('claude\t0'), { command: 'claude', dead: false });
  assert.deepEqual(parsePaneInfo('zsh\t1'), { command: 'zsh', dead: true });
  assert.equal(parsePaneInfo(''), null);
});

test('the tmux binary is looked for where it lives, with an escape hatch first', () => {
  assert.equal(tmuxCandidates({ CLIPPY_TMUX_BIN: '/my/tmux' })[0], '/my/tmux');
  assert.ok(tmuxCandidates({}).includes('/opt/homebrew/bin/tmux'));
});

test('loginShell only trusts something that looks like a shell', () => {
  assert.equal(loginShell({ SHELL: '/bin/fish' }), '/bin/fish');
  assert.equal(loginShell({}), '/bin/zsh');
  assert.equal(loginShell({ SHELL: 'zsh' }), '/bin/zsh');
  assert.equal(loginShell({ SHELL: '/bin/my shell' }), '/bin/zsh');
});
