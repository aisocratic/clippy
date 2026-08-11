'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  sshArgs,
  controlPathFor,
  controlDir,
  ensureControlDir,
  remoteProbeScript,
  parseProbe,
  linesOf,
  safeId,
  createRemoteReader,
} = require('../src/transport');
const { turnsFrom, encodeProjectDir } = require('../src/transcript');

/**
 * Run the probe script the way the far side would, with $HOME pointed at a
 * fake one. The script is the risky part of this module — quoting, portability,
 * byte offsets — and none of that is provable by reading it.
 */
const runProbe = (script, home) =>
  execFileSync('/bin/sh', ['-c', script], {
    encoding: 'buffer',
    env: { ...process.env, HOME: home },
    maxBuffer: 8 * 1024 * 1024,
  });

/** A fake remote home with a Claude transcript in it. */
function remoteHome(t, { cwd, sessionId, lines }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-remote-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(cwd, { recursive: true });
  const dir = path.join(home, '.claude', 'projects', encodeProjectDir(fs.realpathSync(cwd)));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines);
  return { home, file };
}

const say = (id, text) =>
  JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } });

test('ssh is told to multiplex, and never to ask for anything', () => {
  const args = sshArgs('me@box', { controlPath: '/tmp/clippy/ssh-%r@%h-%p' });

  // Without a shared connection every poll is a full handshake.
  assert.ok(args.includes('ControlMaster=auto'));
  assert.ok(args.some((a) => a.startsWith('ControlPath=')));
  assert.ok(args.includes('ControlPersist=120'));
  // There is no terminal on this ssh, so a passphrase prompt would just hang.
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.some((a) => a.startsWith('ConnectTimeout=')));
  assert.equal(args.at(-1), 'me@box', 'the host is the last argument, before the command');
  // A unix socket path is capped near 104 bytes and ssh simply refuses past
  // it, so the socket cannot live under the app's own (long) data directory.
  const controlPath = controlPathFor();
  assert.ok(controlPath.length < 60, `${controlPath} is ${controlPath.length} bytes`);
  assert.match(controlPath, /%C$/, 'ssh hashes the connection details itself');
  // Even with a long username and host appended, ssh stays under the cap.
  assert.ok(controlPath.replace('%C', 'a'.repeat(40)).length < 104);
});

test('the control socket directory is private to this user', () => {
  // /tmp is world-writable; a control socket anyone can reach is a session
  // anyone can reach. 0700 is the whole defence.
  const calls = [];
  const dir = ensureControlDir((d, opts) => calls.push([d, opts]));
  assert.deepEqual(calls, [[dir, { recursive: true, mode: 0o700 }]]);
  assert.equal(dir, controlDir());
  // An unwritable /tmp must not take the app down with it.
  assert.doesNotThrow(() => ensureControlDir(() => { throw new Error('nope'); }));
});

test('the probe finds a Claude transcript and reports its size', async (t) => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-proj-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const body = `${say('m1', 'first')}\n${say('m2', 'second')}\n`;
  const { home, file } = remoteHome(t, { cwd, sessionId, lines: body });

  const probe = parseProbe(runProbe(remoteProbeScript({ agent: 'claude', cwd, sessionId }), home));
  assert.equal(probe.path, file);
  assert.equal(probe.size, Buffer.byteLength(body));
  assert.equal(probe.from, 0);
  assert.equal(probe.bytes.toString('utf8'), body);
  assert.ok(probe.mtimeMs > 0 && probe.ino > 0);
});

test('the probe reads only the bytes that are new', async (t) => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-proj-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const first = `${say('m1', 'first')}\n`;
  const { home, file } = remoteHome(t, { cwd, sessionId, lines: first });

  const offset = Buffer.byteLength(first);
  fs.appendFileSync(file, `${say('m2', 'second')}\n`);

  const probe = parseProbe(runProbe(remoteProbeScript({ agent: 'claude', cwd, sessionId, offset }), home));
  assert.equal(probe.from, offset);
  assert.ok(probe.bytes.toString('utf8').includes('second'));
  assert.ok(!probe.bytes.toString('utf8').includes('first'), 'the delta, not the file');
});

test('a transcript that is not there yet answers "none" rather than failing', async (t) => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-proj-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-remote-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  // The first minutes of every spawned session.
  const out = runProbe(remoteProbeScript({ agent: 'claude', cwd, sessionId: 'nope' }), home);
  assert.match(out.toString('utf8'), /#clippy none/);
  assert.equal(parseProbe(out), null);

  // And a project directory that does not exist at all.
  const gone = runProbe(remoteProbeScript({ agent: 'claude', cwd: '/nope/missing', sessionId: 'x' }), home);
  assert.equal(parseProbe(gone), null);
});

test('a project path full of shell metacharacters is data, never syntax', async (t) => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-proj-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const nasty = path.join(parent, "it's; $(touch /tmp/clippy-PWNED) `id` app");
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const body = `${say('m1', 'survived')}\n`;
  const { home } = remoteHome(t, { cwd: nasty, sessionId, lines: body });

  const probe = parseProbe(runProbe(remoteProbeScript({ agent: 'claude', cwd: nasty, sessionId }), home));
  assert.ok(probe, 'the path round-tripped through the shell intact');
  assert.ok(probe.bytes.toString('utf8').includes('survived'));
  assert.ok(!fs.existsSync('/tmp/clippy-PWNED'), 'nothing in the path was executed');
});

test('a tilde is expanded on the far side, not quoted into uselessness', () => {
  // `cd '~'` fails, and `~` is exactly what people type for a remote path.
  const script = remoteProbeScript({ cwd: '~/app', sessionId: 'x' });
  assert.ok(script.includes('"$HOME"/'), script.split('\n')[0]);
  assert.ok(!script.includes("cd '~/app'"));
  assert.ok(remoteProbeScript({ cwd: '', sessionId: 'x' }).includes('cd "$HOME"'));
});

test('a session id that is not a session id cannot reach the shell', () => {
  // It lands inside a double-quoted string, where quoting would be literal.
  assert.equal(safeId('a1b2-c3d4'), 'a1b2-c3d4');
  assert.equal(safeId('$(id)'), 'id');
  assert.equal(safeId('a/../../etc/passwd'), 'a....etcpasswd');
  assert.ok(!remoteProbeScript({ sessionId: '"; id; "' }).includes('; id; '));
});

test('the framing survives a transcript with no trailing newline', () => {
  // A trailer would be appended straight onto that last line and corrupt it,
  // which is why every field lives in the header.
  const probe = parseProbe(Buffer.from('#clippy path=/a/b size=12 mtime=1700 ino=99 from=4\n{"a":1}'));
  assert.equal(probe.path, '/a/b');
  assert.equal(probe.size, 12);
  assert.equal(probe.mtimeMs, 1_700_000);
  assert.equal(probe.ino, 99);
  assert.equal(probe.from, 4);
  assert.equal(probe.bytes.toString('utf8'), '{"a":1}');
});

test('a malformed answer is nothing, not a crash', () => {
  assert.equal(parseProbe(''), null);
  assert.equal(parseProbe('no header here\nbody'), null);
  assert.equal(parseProbe('#clippy none\n'), null);
  assert.equal(parseProbe('#clippy path=/a size=oops\n'), null);
  assert.equal(parseProbe(Buffer.from('#clippy path=/a\n')), null);
});

test('complete lines are taken and a partial one is left for next time', () => {
  const { lines, rest } = linesOf(Buffer.from('{"a":1}\n{"b":2}\n{"half'));
  assert.deepEqual(lines.map((l) => l.toString('utf8')), ['{"a":1}', '{"b":2}']);
  assert.equal(rest, 6, 'the partial line is not consumed');
  assert.deepEqual(linesOf(Buffer.alloc(0)), { lines: [], rest: 0 });
});

test('a remote reader turns one ssh call into turns, then reads only the delta', async () => {
  const body = [`${say('m1', 'hello')}`, `${say('m2', 'again')}`].join('\n') + '\n';
  const calls = [];
  let answer = Buffer.concat([
    Buffer.from(`#clippy path=/r/s.jsonl size=${Buffer.byteLength(body)} mtime=1700 ino=7 from=0\n`),
    Buffer.from(body),
  ]);

  const reader = createRemoteReader({
    host: 'me@box',
    agent: 'claude',
    cwd: '~/app',
    sessionId: 'sid',
    controlPath: '/tmp/cp',
    turnsFrom,
    exec: async (file, args) => {
      calls.push({ file, host: args.at(-2), script: args.at(-1) });
      return answer;
    },
  });

  const first = await reader.poll();
  assert.deepEqual(first.turns.map((t) => t.text), ['hello', 'again']);
  assert.equal(first.cold, true);
  assert.equal(reader.offset, Buffer.byteLength(body));
  assert.equal(calls[0].file, '/usr/bin/ssh');
  assert.equal(calls[0].host, 'me@box');

  // Unchanged: same size and mtime means nothing to say.
  answer = Buffer.from(`#clippy path=/r/s.jsonl size=${Buffer.byteLength(body)} mtime=1700 ino=7 from=0\n`);
  assert.deepEqual(await reader.poll(), { turns: [], changed: false });

  // The next poll asks from where it left off.
  assert.ok(calls.at(-1).script.includes(`start=${Buffer.byteLength(body)}`));
});

test('a remote transcript replaced under the reader is re-read from scratch', async () => {
  const line = `${say('m9', 'after clear')}\n`;
  const reader = createRemoteReader({
    host: 'h',
    turnsFrom,
    controlPath: '/tmp/cp',
    exec: async () =>
      Buffer.concat([
        // Smaller than what we had read, and a different inode.
        Buffer.from(`#clippy path=/r/s.jsonl size=${Buffer.byteLength(line)} mtime=99 ino=42 from=0\n`),
        Buffer.from(line),
      ]),
  });

  await reader.poll();
  assert.equal(reader.offset, Buffer.byteLength(line));
  // Same answer again: unchanged size and mtime, so nothing new to report.
  assert.deepEqual((await reader.poll()).turns, []);
});

test('an unreachable host is an error the watcher can back off on', async () => {
  const reader = createRemoteReader({
    host: 'h',
    turnsFrom,
    controlPath: '/tmp/cp',
    exec: async () => {
      throw new Error('ssh: connect to host h port 22: Operation timed out');
    },
  });

  await assert.rejects(() => reader.poll(), /Operation timed out/);
});

test('the remote reader works end to end against a real filesystem', async (t) => {
  // No network, but everything else is real: the probe script is run by an
  // actual shell against actual files, and the reader parses what comes back.
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-proj-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const { home, file } = remoteHome(t, { cwd, sessionId, lines: `${say('m1', 'hello from over there')}\n` });

  const reader = createRemoteReader({
    host: 'pretend-host',
    agent: 'claude',
    cwd,
    sessionId,
    controlPath: '/tmp/cp',
    turnsFrom,
    // Stand in for ssh: run the script the far side would have run.
    exec: async (_file, args) => runProbe(args.at(-1), home),
  });

  const cold = await reader.poll();
  assert.deepEqual(cold.turns.map((x) => x.text), ['hello from over there']);
  assert.equal(cold.cold, true);

  assert.deepEqual((await reader.poll()).turns, [], 'nothing new to say');

  fs.appendFileSync(file, `${say('m2', 'and again')}\n`);
  const next = await reader.poll();
  assert.deepEqual(next.turns.map((x) => x.text), ['and again'], 'the delta only');

  // A line that is still being written is not a turn until it is finished.
  const half = say('m3', 'incomplete');
  fs.appendFileSync(file, half.slice(0, 20));
  assert.deepEqual((await reader.poll()).turns, []);
  fs.appendFileSync(file, `${half.slice(20)}\n`);
  assert.deepEqual((await reader.poll()).turns.map((x) => x.text), ['incomplete']);

  // And a /clear over there starts the file again.
  fs.writeFileSync(file, `${say('m9', 'fresh start')}\n`);
  assert.deepEqual((await reader.poll()).turns.map((x) => x.text), ['fresh start']);
});

test('only a genuine skip drops a line, and an ordinary delta never does', async () => {
  const line = (id, text) => `${say(id, text)}\n`;
  let answer;
  const reader = createRemoteReader({
    host: 'h',
    turnsFrom,
    controlPath: '/tmp/cp',
    exec: async () => answer,
  });

  // Cold start.
  const body = line('m1', 'one');
  answer = Buffer.from(`#clippy path=/r size=${body.length} mtime=1 ino=5 from=0\n${body}`);
  assert.deepEqual((await reader.poll()).turns.map((x) => x.text), ['one']);

  // An ordinary delta: the far side started exactly where we asked, so every
  // line in it is a whole line. Dropping one here was a real bug.
  const delta = line('m2', 'two');
  const size = body.length + delta.length;
  answer = Buffer.from(`#clippy path=/r size=${size} mtime=2 ino=5 from=${body.length}\n${delta}`);
  assert.deepEqual((await reader.poll()).turns.map((x) => x.text), ['two']);

  // A skip: we fell far behind, so the far side began mid-record and the first
  // line really is a fragment.
  const skipped = `alf-a-record"}\n${line('m3', 'three')}`;
  answer = Buffer.from(`#clippy path=/r size=99999 mtime=3 ino=5 from=90000\n${skipped}`);
  assert.deepEqual((await reader.poll()).turns.map((x) => x.text), ['three']);
});
