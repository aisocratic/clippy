'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { lockPath, allowsMultiple, readLock, writeLock, holderOf } = require('../src/single-instance');

const alive = () => true;
const dead = () => false;

test('the lock is machine-wide, not per profile', () => {
  // The whole point: Electron's own lock is scoped to the user-data directory,
  // so a copy started with --user-data-dir walks past it. This path must not
  // move when that flag does.
  const file = lockPath('/Users/someone');
  assert.equal(file, '/Users/someone/Library/Application Support/clippy-for-claude/running.lock');
});

test('a live holder stops a second Clippy', () => {
  assert.equal(holderOf(writeLock(4242), alive, 99), 4242);
});

test('a lock left by a crash is litter, not a holder', () => {
  // Otherwise a machine that lost power mid-session would need a file deleting
  // by hand before Clippy would ever start again.
  assert.equal(holderOf(writeLock(4242), dead, 99), 0);
});

test('our own claim never locks us out', () => {
  assert.equal(holderOf(writeLock(1234), alive, 1234), 0);
});

test('no lock at all is a clear way in', () => {
  assert.equal(holderOf(null, alive, 99), 0);
  assert.equal(holderOf('', alive, 99), 0);
});

test('a corrupt lock is not an excuse to refuse to start', () => {
  for (const raw of ['{', 'null', '{}', '{"pid":"nope"}', '{"pid":0}', '{"pid":-3}', '{"pid":1}']) {
    assert.equal(holderOf(raw, alive, 99), 0, raw);
  }
});

test('the lock round-trips', () => {
  const parsed = readLock(writeLock(777, 1700));
  assert.deepEqual(parsed, { pid: 777, at: 1700 });
});

test('running two on purpose stays possible, but only on purpose', () => {
  assert.equal(allowsMultiple({}), false);
  assert.equal(allowsMultiple({ CLIPPY_ALLOW_MULTIPLE: '1' }), true);
  // The dev sandbox exists to put several buddies on screen at once.
  assert.equal(allowsMultiple({ CLIPPY_SANDBOX: '1' }), true);
  assert.equal(allowsMultiple({ CLIPPY_ALLOW_MULTIPLE: '0' }), false);
});

/* ---------- Holding on to it, not just taking it once ---------- */

const { defend } = require('../src/single-instance');
const me = { pid: 500, at: 1000 };

test('a lock that went missing is taken back, not shrugged at', () => {
  // This is the whole reason defend() exists: claiming once at startup meant a
  // lock file that vanished left the running copy defending nothing, and the
  // next start walked in beside it.
  assert.equal(defend(null, alive, me), 'retake');
  assert.equal(defend('', alive, me), 'retake');
  assert.equal(defend('{ broken', alive, me), 'retake');
});

test('our own lock is left exactly as it is', () => {
  assert.equal(defend(writeLock(500, 1000), alive, me), 'keep');
  // Even if the timestamp has drifted — it is still our pid, so it is ours.
  assert.equal(defend(writeLock(500, 9999), alive, me), 'keep');
});

test('a lock left by a copy that died is litter, and litter is retaken', () => {
  assert.equal(defend(writeLock(4242, 10), dead, me), 'retake');
});

test('the copy that got there first keeps the menu bar', () => {
  // The older claim wins because it is the one the user has had on screen.
  assert.equal(defend(writeLock(4242, 999), alive, me), 'yield');
  assert.equal(defend(writeLock(4242, 1001), alive, me), 'retake');
});

test('two copies never both leave, and never both stay', () => {
  // The failure that matters: a rule where both yield leaves no Clippy at all,
  // and one where both retake leaves the two the user complained about. Run
  // the decision from each side and exactly one of them must go.
  // Real pids: readLock rejects anything <= 1 on purpose, since pid 1 is
  // launchd and a lock naming it is corrupt rather than a rival.
  const cases = [
    [{ pid: 4100, at: 100 }, { pid: 4200, at: 200 }],
    [{ pid: 4700, at: 500 }, { pid: 4300, at: 500 }], // same instant, different pids
  ];
  for (const [a, b] of cases) {
    const aSays = defend(writeLock(b.pid, b.at), alive, a);
    const bSays = defend(writeLock(a.pid, a.at), alive, b);
    const leaving = [aSays, bSays].filter((d) => d === 'yield').length;
    assert.equal(leaving, 1, `exactly one should go, got ${aSays}/${bSays}`);
  }
});

/* ---------- Claiming it without a gap ---------- */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The real claim, lifted out of main so the file mechanics can be tested
// without an Electron. main.js does exactly this — see claimAtomically.
function claimAtomically(file, contents, pid = process.pid) {
  const scratch = `${file}.${pid}`;
  fs.writeFileSync(scratch, contents);
  try {
    fs.linkSync(scratch, file);
  } finally {
    fs.rmSync(scratch, { force: true });
  }
}

test('claiming the lock never leaves it briefly empty', () => {
  // The bug this replaced: writeFileSync(..., 'wx') creates the file first and
  // fills it a moment later, so a second copy could read an empty lock, call it
  // litter from a crash, delete it and claim the menu bar for itself. Five
  // simultaneous starts really did leave one Clippy running and no lock at all.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-lock-'));
  const file = path.join(dir, 'running.lock');

  claimAtomically(file, writeLock(4242, 1000));
  // Whatever is at that name is a complete lock, never a half-written one.
  assert.deepEqual(readLock(fs.readFileSync(file, 'utf8')), { pid: 4242, at: 1000 });

  // And a second claim cannot succeed while it stands.
  let refused = null;
  try {
    claimAtomically(file, writeLock(777, 2000), 777);
  } catch (err) {
    refused = err.code;
  }
  assert.equal(refused, 'EEXIST', 'a second claim must fail, not overwrite');
  assert.deepEqual(readLock(fs.readFileSync(file, 'utf8')), { pid: 4242, at: 1000 });

  // A refused claim leaves nothing behind but the lock it lost to.
  assert.deepEqual(fs.readdirSync(dir), ['running.lock']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the loser of a claim can tell it lost, and from a readable lock', () => {
  // EEXIST now always means a *complete* lock, which is what lets the loser
  // trust what it reads: "cannot parse this" means corrupt, not "in flight".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-lock-'));
  const file = path.join(dir, 'running.lock');
  claimAtomically(file, writeLock(4242, 1000));

  assert.equal(holderOf(fs.readFileSync(file, 'utf8'), alive, 777), 4242);
  assert.equal(holderOf(fs.readFileSync(file, 'utf8'), dead, 777), 0, 'a dead holder is litter');
  fs.rmSync(dir, { recursive: true, force: true });
});
