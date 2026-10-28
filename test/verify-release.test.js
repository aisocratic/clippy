'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertBuildVersion,
  assertChecksum,
  assertTagMatchesPackageVersion,
  detachVolume,
  sha256File,
  versionForTag,
} = require('../scripts/verify-release');

test('versionForTag requires a v-prefixed semver release tag', () => {
  assert.equal(versionForTag('v0.3.1'), '0.3.1');
  assert.equal(versionForTag('v1.0.0-rc.1'), '1.0.0-rc.1');
  assert.throws(() => versionForTag('0.3.1'), /v-prefixed semver/);
  assert.throws(() => versionForTag('v0.3'), /v-prefixed semver/);
});

test('assertTagMatchesPackageVersion rejects publishing mismatched source', () => {
  assert.doesNotThrow(() => assertTagMatchesPackageVersion('v0.3.1', '0.3.1'));
  assert.throws(
    () => assertTagMatchesPackageVersion('v0.3.2', '0.3.1'),
    /does not match package\.json version/
  );
});

test('assertChecksum validates both digest and expected artifact name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-release-verify-'));
  const dmg = path.join(dir, 'Clippy-for-Claude-Code.dmg');
  const checksum = `${dmg}.sha256`;
  fs.writeFileSync(dmg, 'not really a dmg');
  fs.writeFileSync(checksum, `${sha256File(dmg)}  ${path.basename(dmg)}\n`);
  assert.doesNotThrow(() => assertChecksum(dmg, checksum));
  fs.writeFileSync(checksum, `${'0'.repeat(64)}  ${path.basename(dmg)}\n`);
  assert.throws(() => assertChecksum(dmg, checksum), /checksum mismatch/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assertChecksum hashes a file larger than one read at a time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-release-big-'));
  const dmg = path.join(dir, 'Clippy-for-Claude-Code.dmg');
  // Bigger than the 1MB buffer the hash reads through, so a file that no longer
  // arrives in one gulp still produces the same digest.
  fs.writeFileSync(dmg, Buffer.alloc(3 * 1024 * 1024 + 7, 0xa5));
  const digest = sha256File(dmg);
  assert.match(digest, /^[a-f0-9]{64}$/);
  fs.writeFileSync(`${dmg}.sha256`, `${digest}  ${path.basename(dmg)}\n`);
  assert.doesNotThrow(() => assertChecksum(dmg));

  // One flipped byte is still caught.
  fs.writeFileSync(dmg, Buffer.alloc(3 * 1024 * 1024 + 7, 0xa6));
  assert.throws(() => assertChecksum(dmg), /checksum mismatch/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a stubborn DMG volume is forced off, and never masks the real failure', () => {
  const calls = [];
  // The happy path: one detach, no -force.
  assert.equal(
    detachVolume('/Volumes/Clippy', (args) => calls.push(args)),
    true
  );
  assert.deepEqual(calls, [['detach', '/Volumes/Clippy']]);

  // Busy: retried with -force rather than left mounted.
  const busy = [];
  assert.equal(
    detachVolume('/Volumes/Clippy', (args) => {
      busy.push(args);
      if (!args.includes('-force')) throw new Error('Resource busy');
    }),
    true
  );
  assert.deepEqual(busy, [['detach', '/Volumes/Clippy'], ['detach', '-force', '/Volumes/Clippy']]);

  // Hopeless: reported, but never thrown — it runs in a `finally`, and throwing
  // there would replace whichever verification check actually failed.
  const said = [];
  assert.equal(
    detachVolume(
      '/Volumes/Clippy',
      () => {
        throw new Error('nope');
      },
      { error: (m) => said.push(m) }
    ),
    false
  );
  assert.match(said.join(' '), /could not unmount/);
});

test('assertBuildVersion makes the tagged artifact match its package version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-build-version-'));
  const app = path.join(dir, 'Clippy for Claude Code.app');
  const buildDir = path.join(app, 'Contents', 'Resources', 'app');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(path.join(buildDir, 'build.json'), JSON.stringify({ version: '0.3.1' }));
  assert.doesNotThrow(() => assertBuildVersion(app, '0.3.1'));
  assert.throws(() => assertBuildVersion(app, '0.3.2'), /does not match/);
  fs.rmSync(dir, { recursive: true, force: true });
});
