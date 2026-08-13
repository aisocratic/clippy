'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseAsn,
  parseAppInfo,
  bundleForProgram,
  focusedTtyScript,
  parseTty,
  looksFocused,
  frontmostApp,
  createFocusProbe,
} = require('../src/frontmost');
const { TERMINAL_APP, ITERM_APP } = require('../src/terminal');

const FRONT_OUT = 'ASN:0x0-0x23797774:\n';
const INFO_OUT = `"pid"=48726
"CFBundleIdentifier"="com.google.Chrome"
"LSDisplayName"="Google Chrome"
`;

test('the front app is read out of what lsappinfo actually prints', () => {
  assert.equal(parseAsn(FRONT_OUT), 'ASN:0x0-0x23797774:');
  assert.deepEqual(parseAppInfo(INFO_OUT), {
    pid: 48726,
    bundleId: 'com.google.Chrome',
    name: 'Google Chrome',
  });
});

test('an app we cannot identify is the same as no answer', () => {
  // Every one of these has to end up as null rather than a half-filled object:
  // a partial answer here would be treated as a real one by looksFocused.
  for (const junk of ['', 'nonsense', '"CFBundleIdentifier"="com.foo"', '"pid"=0', '"pid"=x']) {
    assert.equal(parseAppInfo(junk), null, junk);
  }
  assert.equal(parseAsn('nothing here'), '');
});

test('a name with spaces survives the parse', () => {
  const parsed = parseAppInfo('"pid"=12\n"CFBundleIdentifier"="com.openai.codex"\n"LSDisplayName"="ChatGPT Atlas"\n');
  assert.equal(parsed.name, 'ChatGPT Atlas');
  assert.equal(parsed.bundleId, 'com.openai.codex');
});

test('only the two terminals whose tabs we can read have a script', () => {
  assert.match(focusedTtyScript(TERMINAL_APP), /selected tab of front window/);
  assert.match(focusedTtyScript(ITERM_APP), /current session of current tab/);
  // Everything else has no way to be asked, and must not get a script that
  // would fail at runtime instead.
  for (const other of ['Ghostty', 'WezTerm', 'vscode', '', undefined]) {
    assert.equal(focusedTtyScript(other), null, String(other));
  }
});

test('a terminal with no window answers "none", not an error', () => {
  assert.equal(parseTty('none\n'), '');
  assert.equal(parseTty('  '), '');
  assert.equal(parseTty('/dev/ttys004\n'), '/dev/ttys004');
});

const chrome = { pid: 48726, bundleId: 'com.google.Chrome', name: 'Google Chrome' };
const ghostty = { pid: 900, bundleId: 'com.mitchellh.ghostty', name: 'Ghostty' };

test('a session whose app is in front is one you are looking at', () => {
  assert.equal(looksFocused({ front: ghostty, app: { pid: 900, name: 'Ghostty' } }), true);
  assert.equal(looksFocused({ front: chrome, app: { pid: 900, name: 'Ghostty' } }), false);
});

test('Terminal and iTerm are matched by bundle, since they never resolve a pid', () => {
  // terminal.js talks to those two by name and finds the tab itself, so there
  // is no app pid on the target to compare against.
  const front = { pid: 5, bundleId: 'com.apple.Terminal', name: 'Terminal' };
  assert.equal(
    looksFocused({ front, program: TERMINAL_APP, tty: '/dev/ttys001', focusedTty: '/dev/ttys001' }),
    true
  );
  assert.equal(bundleForProgram(ITERM_APP), 'com.googlecode.iterm2');
  assert.equal(bundleForProgram('Ghostty'), '');
});

test('the wrong tab in the right app is not something you are looking at', () => {
  // The whole point of asking about tabs: one Terminal window can hold a dozen
  // sessions, and eleven of them are behind the one on screen.
  const front = { pid: 5, bundleId: 'com.apple.Terminal', name: 'Terminal' };
  assert.equal(
    looksFocused({ front, program: TERMINAL_APP, tty: '/dev/ttys009', focusedTty: '/dev/ttys001' }),
    false
  );
  // And a tab we could not ask about is not an excuse to assume the good case.
  assert.equal(
    looksFocused({ front, program: TERMINAL_APP, tty: '/dev/ttys009', focusedTty: '' }),
    false
  );
});

test('every kind of not-knowing answers "not focused"', () => {
  // Being wrong this way pops a buddy that was not strictly needed. Being wrong
  // the other way loses a message entirely, so the bias is deliberate.
  assert.equal(looksFocused({}), false);
  assert.equal(looksFocused({ front: null, app: { pid: 900 } }), false);
  assert.equal(looksFocused({ front: { pid: 0 }, app: { pid: 0 } }), false);
  assert.equal(looksFocused({ front: ghostty, app: null, program: 'Ghostty' }), false);
  assert.equal(looksFocused({ front: ghostty, app: { pid: 0, name: 'Ghostty' } }), false);
});

test('a machine without lsappinfo is not an error, it is "do not know"', async () => {
  const boom = async () => {
    throw new Error('ENOENT');
  };
  assert.equal(await frontmostApp({ exec: boom }), null);
});

test('the front app is fetched with two calls, the second using the first answer', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args.join(' '));
    return args[0] === 'front' ? FRONT_OUT : INFO_OUT;
  };
  const front = await frontmostApp({ exec });
  assert.equal(front.name, 'Google Chrome');
  assert.deepEqual(calls, ['front', 'info -only pid,bundleid,name ASN:0x0-0x23797774:']);
});

test('a burst of hooks asks the window server once, not once each', async () => {
  let calls = 0;
  let clock = 1000;
  const exec = async (_cmd, args) => {
    calls++;
    return args[0] === 'front' ? FRONT_OUT : INFO_OUT;
  };
  const probe = createFocusProbe({ exec, ttlMs: 400, now: () => clock });

  const [a, b, c] = await Promise.all([probe.current(), probe.current(), probe.current()]);
  assert.equal(a.front.pid, 48726);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(calls, 2, 'one front + one info for all three callers');

  await probe.current();
  assert.equal(calls, 2, 'still inside the memory');

  // Past the window, the desktop may well have changed underneath us.
  clock += 500;
  await probe.current();
  assert.equal(calls, 4);
});

test('forgetting makes the next question a real one', async () => {
  let calls = 0;
  const exec = async (_cmd, args) => {
    calls++;
    return args[0] === 'front' ? FRONT_OUT : INFO_OUT;
  };
  const probe = createFocusProbe({ exec, now: () => 1000 });
  await probe.current();
  assert.equal(calls, 2);
  probe.forget();
  await probe.current();
  assert.equal(calls, 4);
});

test('a probe that blows up answers "do not know" rather than rejecting', async () => {
  // This runs in front of every hook: it has to be impossible for it to break
  // one, however the machine misbehaves.
  const probe = createFocusProbe({
    exec: async () => {
      throw new Error('window server said no');
    },
  });
  assert.deepEqual(await probe.current(), { front: null, focusedTty: '' });
});

test('only a terminal we can read gets asked about its tabs', async () => {
  const asked = [];
  const exec = async (cmd, args) => {
    asked.push(cmd);
    if (args[0] === 'front') return FRONT_OUT;
    if (args[0] === 'info') return '"pid"=5\n"CFBundleIdentifier"="com.google.Chrome"\n"LSDisplayName"="Chrome"\n';
    return 'none';
  };
  await createFocusProbe({ exec }).current();
  assert.ok(!asked.includes('/usr/bin/osascript'), 'Chrome has no tabs we can ask about');
});
