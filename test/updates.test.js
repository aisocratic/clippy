'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { localBuild, checkForUpdates } = require('../src/updates');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-updates-'));

function checkoutAt(sha, { packed = false } = {}) {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  fs.mkdirSync(path.join(dir, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  if (packed) fs.writeFileSync(path.join(dir, '.git', 'packed-refs'), `${sha} refs/heads/main\n`);
  else fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), `${sha}\n`);
  return dir;
}

const gh = (sha) => async () => ({
  ok: true,
  json: async () => ({ sha, commit: { message: 'Newest thing\n\nBody', committer: { date: '2026-08-04T00:00:00Z' } } }),
});

test('a checkout knows its version, branch and sha — loose or packed refs', () => {
  for (const packed of [false, true]) {
    const build = localBuild(checkoutAt('a'.repeat(40), { packed }));
    assert.equal(build.version, '0.1.0');
    assert.equal(build.branch, 'main');
    assert.equal(build.sha, 'a'.repeat(40));
    assert.equal(build.source, 'checkout');
  }
});

test('the packaged app has no git and says so instead of guessing', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  const info = await checkForUpdates(dir, gh('b'.repeat(40)));
  assert.equal(info.source, 'packaged');
  assert.equal(info.upToDate, null, 'no sha to compare means no verdict');
  assert.equal(info.latest.message, 'Newest thing');
});

test('same sha is up to date, a different one is not', async () => {
  const sha = 'c'.repeat(40);
  assert.equal((await checkForUpdates(checkoutAt(sha), gh(sha))).upToDate, true);
  assert.equal((await checkForUpdates(checkoutAt(sha), gh('d'.repeat(40)))).upToDate, false);
});

test('an unreachable GitHub is an error message, not a crash', async () => {
  const info = await checkForUpdates(checkoutAt('e'.repeat(40)), async () => ({ ok: false, status: 403 }));
  assert.equal(info.upToDate, null);
  assert.match(info.error, /403/);
});
