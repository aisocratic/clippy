'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const {
  terminalFromHeaders,
  parseProcessTable,
  appNameFromComm,
  findAppAncestor,
  ancestorsOf,
  windowScript,
  parseBounds,
  dockPosition,
  promptPosition,
  typeScript,
  TERMINAL_APP,
  ITERM_APP,
} = require('../src/terminal');

test('terminalFromHeaders reads what the hook shipped', () => {
  assert.deepEqual(
    terminalFromHeaders({
      'x-clippy-term': 'Apple_Terminal',
      'x-clippy-tty': 's004',
      'x-clippy-pid': '4711',
    }),
    { program: 'Apple_Terminal', tty: '/dev/ttys004', pid: 4711 }
  );

  // ps prints the device path in some shells, `ttys004` in others.
  assert.equal(terminalFromHeaders({ 'x-clippy-tty': 'ttys004' }).tty, '/dev/ttys004');
  assert.equal(terminalFromHeaders({ 'x-clippy-tty': '/dev/ttys004' }).tty, '/dev/ttys004');

  // A process with no controlling terminal, and hooks from an older install.
  assert.equal(terminalFromHeaders({ 'x-clippy-tty': '??', 'x-clippy-pid': '9' }).tty, '');
  assert.equal(terminalFromHeaders({}), null);
  assert.equal(terminalFromHeaders(), null);
});

test('the process table gets us from claude to its terminal app', () => {
  const table = parseProcessTable(`
  4711  4700 /usr/local/bin/node
  4700  4690 /bin/zsh
  4690     1 /Applications/Ghostty.app/Contents/MacOS/ghostty
`);
  assert.equal(table.size, 3);
  assert.deepEqual(findAppAncestor(4711, table), {
    pid: 4690,
    name: 'Ghostty',
    bundle: '/Applications/Ghostty.app',
  });

  // The chain runs out (process gone) -> nothing to aim at.
  assert.equal(findAppAncestor(9999, table), null);
});

test('appNameFromComm only matches real app bundles', () => {
  assert.equal(appNameFromComm('/Applications/iTerm.app/Contents/MacOS/iTerm2'), 'iTerm');
  assert.equal(appNameFromComm('/bin/zsh'), '');
  assert.equal(appNameFromComm(''), '');
  // A windowless Electron helper is not the app we want to point at.
  assert.equal(
    appNameFromComm(
      '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper'
    ),
    ''
  );
});

test("VS Code's nested helper is skipped for the window-owning app", () => {
  // Real ancestry of a Claude Code session in VS Code's integrated terminal.
  const table = parseProcessTable(`
 24047 23520 claude
 23520  2802 /bin/zsh
  2802  1196 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper
  1196     1 /Applications/Visual Studio Code.app/Contents/MacOS/Code
`);
  // The bundle is the OUTER app, not the helper's nested bundle — `open` on
  // the helper would be meaningless.
  assert.deepEqual(findAppAncestor(24047, table), {
    pid: 1196,
    name: 'Visual Studio Code',
    bundle: '/Applications/Visual Studio Code.app',
  });
});

test('the ancestor chain starts at the process itself and stops at the root', () => {
  const table = parseProcessTable(`
 24047 23520 claude
 23520  2802 /bin/zsh
  2802  1196 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper
  1196     1 /Applications/Visual Studio Code.app/Contents/MacOS/Code
`);

  // The starting pid is in the chain: a tmux pane whose command `exec`s has no
  // intermediate shell, so the agent *is* the pane process.
  assert.deepEqual(ancestorsOf(24047, table), [24047, 23520, 2802, 1196]);
  assert.deepEqual(ancestorsOf(1196, table), [1196]);

  // The same walk findAppAncestor makes, so the two agree about the tree.
  assert.ok(ancestorsOf(24047, table).includes(findAppAncestor(24047, table).pid));
});

test('an ancestor walk gives up rather than running away', () => {
  const table = parseProcessTable('  500 400 claude\n  300 200 /bin/zsh\n');

  // A pid whose parent left the table: report what is known, not a guess.
  assert.deepEqual(ancestorsOf(500, table), [500]);
  assert.deepEqual(ancestorsOf(999, table), []);
  assert.deepEqual(ancestorsOf(0, table), []);

  const deep = parseProcessTable(
    Array.from({ length: 30 }, (_, i) => ` ${100 + i} ${101 + i} p${i}`).join('\n')
  );
  assert.equal(ancestorsOf(100, deep, { maxHops: 4 }).length, 4);
});

test('windowScript targets the tty for Terminal and iTerm, the app otherwise', () => {
  const term = windowScript({ program: TERMINAL_APP, tty: '/dev/ttys004' }, { reveal: true });
  assert.match(term, /tell application "Terminal"/);
  assert.match(term, /tty of t is "\/dev\/ttys004"/);
  assert.match(term, /set index of targetWindow to 1/);

  // Measuring must never steal focus.
  const measure = windowScript({ program: TERMINAL_APP, tty: '/dev/ttys004' }, { reveal: false });
  assert.doesNotMatch(measure, /activate/);

  assert.match(
    windowScript({ program: ITERM_APP, tty: '/dev/ttys001' }, { reveal: true }),
    /tell application "iTerm2"/
  );

  const other = windowScript(
    { program: 'ghostty', tty: '/dev/ttys002', app: { pid: 4690, name: 'Ghostty' }, hint: 'clippy' },
    { reveal: true }
  );
  assert.match(other, /unix id is 4690/);
  assert.match(other, /set frontmost of proc to true/);
  assert.match(other, /perform action "AXRaise"/);
  // Floating panels (VS Code's 1800x39 palette host) must not be mistaken for
  // the editor window, and with several project windows open the right one is
  // the one titled after this session's project.
  assert.match(other, /repeat with w in windows of proc/);
  assert.match(other, /\(name of w\) contains "clippy"/);
  assert.match(other, /repeat 3 times/); // an empty window list can be transient

  // No project name to go on -> size alone decides, no title test at all.
  const noHint = windowScript({ app: { pid: 4690, name: 'Ghostty' } }, { reveal: false });
  assert.doesNotMatch(noHint, /name of w/);

  // Nothing to go on.
  assert.equal(windowScript({ program: 'ghostty', tty: '', app: null }, { reveal: true }), null);
  assert.equal(windowScript(null, {}), null);
});

test('a project name is data in the script, never syntax', () => {
  // macOS allows almost anything in a folder name, and the folder name is what
  // the window hint is. A quote would close the literal; a newline is worse,
  // because AppleScript has no multi-line string, so the *whole script* stops
  // compiling — which used to mean every window lookup failing silently for as
  // long as that project was open.
  const nasty = [
    ['my "quoted" app', 'my "quoted" app'],
    ['back\\slash', 'back\\slash'],
    ['two\nlines', 'two\nlines'],
    ['carriage\rreturn', 'carriage\rreturn'],
    // Nothing a terminal can use, and nothing a script literal can hold.
    ['a\x07bell', 'abell'],
    ['проект ✨', 'проект ✨'],
  ];

  for (const [hint, expected] of nasty) {
    const script = windowScript({ app: { pid: 42 }, hint }, { reveal: false });
    const literal = script.match(/contains ("(?:[^"\\]|\\.)*")/);
    assert.ok(literal, `no readable literal for ${JSON.stringify(hint)}`);
    assert.doesNotMatch(literal[1], /[\n\r]/, 'a raw line break would not compile');

    // The proof, rather than the pattern: ask AppleScript itself what it read.
    const said = execFileSync('/usr/bin/osascript', ['-e', `return ${literal[1]}`], {
      encoding: 'utf8',
    });
    assert.equal(said.replace(/\n$/, ''), expected, JSON.stringify(hint));
  }
});

test('typed text is one line, and carries no control characters into the script', () => {
  const script = typeScript('first line\nsecond "line"\x07');
  assert.match(script, /keystroke "first line second \\"line\\""/);
  assert.doesNotMatch(script, /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
});

test('parseBounds accepts the scripts output and nothing else', () => {
  assert.deepEqual(parseBounds('12,34,900,600\n'), { x: 12, y: 34, width: 900, height: 600 });
  assert.equal(parseBounds('none'), null);
  assert.equal(parseBounds('12,34,0,600'), null); // a window with no size is no use
  assert.equal(parseBounds(''), null);
});

test('dockPosition perches top-right and stays on screen', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  const win = { w: 104, h: 118 };

  assert.deepEqual(
    dockPosition({ x: 100, y: 100, width: 900, height: 600 }, win.w, win.h, workArea),
    { x: 100 + 900 - 104 - 10, y: 102 }
  );

  // A window hanging off the right edge / above the menu bar is pulled back in.
  const clamped = dockPosition({ x: 1400, y: -200, width: 900, height: 600 }, win.w, win.h, workArea);
  assert.equal(clamped.x, workArea.width - win.w);
  assert.equal(clamped.y, workArea.y);
});

test('promptPosition stands on the input line, bottom-left', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 };
  const win = { w: 104, h: 148 }; // compact buddy plus room for the arrow
  const term = { x: 100, y: 100, width: 900, height: 600 };

  const spot = promptPosition(term, win.w, win.h, workArea);
  assert.equal(spot.x, term.x + 18, 'just in from the left edge');
  // Feet above the input box, so the arrow lands on it and he never covers it.
  assert.equal(spot.y, term.y + term.height - 62 - win.h);
  assert.ok(spot.y + win.h < term.y + term.height, 'inside the window');

  // Same clamping as the perch: a window half off-screen still gets a buddy
  // that's fully on it.
  const off = promptPosition({ x: -400, y: 700, width: 900, height: 600 }, win.w, win.h, workArea);
  assert.equal(off.x, workArea.x);
  assert.equal(off.y, workArea.y + workArea.height - win.h);
});

test('typeScript sends one line and one Return, whatever was typed', () => {
  const script = typeScript('fix the tests\n\n  then push');
  // Newlines would submit the prompt early, so they collapse to spaces.
  assert.ok(script.includes('keystroke "fix the tests then push"'));
  // Exactly one Return — key code 36 — and only after the text.
  assert.equal(script.match(/key code 36/g).length, 1);
  assert.ok(script.indexOf('keystroke') < script.indexOf('key code 36'));

  // Quotes and backslashes ride inside the AppleScript string, escaped.
  assert.ok(typeScript('say "hi" \\ there').includes('keystroke "say \\"hi\\" \\\\ there"'));
});
