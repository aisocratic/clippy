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
