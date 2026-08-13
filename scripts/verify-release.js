'use strict';

/**
 * Fail closed when a release DMG is missing any of the trust signals macOS
 * needs. The package script creates these artifacts; this script proves the
 * exact bytes about to be published are signed, stapled, and internally
 * consistent. It is deliberately dependency-free so it can run on a clean
 * GitHub Actions macOS runner as well as the release Mac.
 */

const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PRODUCT = 'Clippy-for-Claude-Code';
const APP_NAME = 'Clippy for Claude Code.app';

function packageVersion(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

function versionForTag(tag) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag || '')) {
    throw new Error(`release tag must be a v-prefixed semver version, got ${JSON.stringify(tag)}`);
  }
  return tag.slice(1);
}

function assertTagMatchesPackageVersion(tag, version = packageVersion()) {
  const tagVersion = versionForTag(tag);
  if (tagVersion !== version) {
    throw new Error(`release tag ${tag} does not match package.json version ${version}`);
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertChecksum(dmgFile, checksumFile = `${dmgFile}.sha256`) {
  const contents = fs.readFileSync(checksumFile, 'utf8').trim();
  const match = /^([a-f0-9]{64})  (.+)$/.exec(contents);
  if (!match) throw new Error(`invalid SHA-256 checksum file: ${checksumFile}`);
  if (match[2] !== path.basename(dmgFile)) {
    throw new Error(`checksum file names ${match[2]}, expected ${path.basename(dmgFile)}`);
  }
  const actual = sha256File(dmgFile);
  if (match[1] !== actual) throw new Error(`checksum mismatch for ${path.basename(dmgFile)}`);
}

function assertBuildVersion(appBundle, expectedVersion) {
  const buildFile = path.join(appBundle, 'Contents', 'Resources', 'app', 'build.json');
  let build;
  try {
    build = JSON.parse(fs.readFileSync(buildFile, 'utf8'));
  } catch {
    throw new Error(`packaged app is missing a readable build manifest: ${buildFile}`);
  }
  if (build.version !== expectedVersion) {
    throw new Error(`packaged app version ${JSON.stringify(build.version)} does not match ${expectedVersion}`);
  }
}

function command(command, args, { capture = false } = {}) {
  return execFileSync(command, args, {
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
}

function signingDetails(file) {
  // `codesign -d` deliberately writes its successful report to stderr.
  const result = spawnSync('codesign', ['-dv', '--verbose=4', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`could not read code-signing details for ${file}: ${result.stderr || result.stdout}`);
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function assertDeveloperIdAndTicket(file) {
  const details = signingDetails(file);
  if (!/^Authority=Developer ID Application:/m.test(details)) {
    throw new Error(`${file} is not signed with a Developer ID Application certificate`);
  }
  if (/^TeamIdentifier=not set$/m.test(details) || !/^TeamIdentifier=.+$/m.test(details)) {
    throw new Error(`${file} has no Developer ID team identifier`);
  }
  if (!/^Notarization Ticket=stapled$/m.test(details)) {
    throw new Error(`${file} has no stapled notarization ticket`);
  }
}

function mountedVolumeFor(dmgFile) {
  const result = command('hdiutil', ['attach', '-nobrowse', '-readonly', dmgFile], { capture: true });
  const lines = result.split('\n');
  const volume = lines
    .map((line) => line.split('\t').pop())
    .find((candidate) => candidate && candidate.startsWith('/Volumes/'));
  if (!volume) throw new Error(`could not find mounted volume for ${dmgFile}`);
  return volume;
}

function verifyRelease({
  dmgFile = path.join(ROOT, 'dist', `${PRODUCT}.dmg`),
  checksumFile = `${dmgFile}.sha256`,
  tag = process.env.GITHUB_REF_NAME || null,
} = {}) {
  if (process.platform !== 'darwin') throw new Error('release verification requires macOS');
  if (tag) assertTagMatchesPackageVersion(tag);
  if (!fs.existsSync(dmgFile)) throw new Error(`release DMG not found: ${dmgFile}`);
  if (!fs.existsSync(checksumFile)) throw new Error(`release checksum not found: ${checksumFile}`);

  assertChecksum(dmgFile, checksumFile);
  command('codesign', ['--verify', '--strict', '--verbose=2', dmgFile]);
  assertDeveloperIdAndTicket(dmgFile);
  command('xcrun', ['stapler', 'validate', dmgFile]);

  let volume = null;
  try {
    volume = mountedVolumeFor(dmgFile);
    const appBundle = path.join(volume, APP_NAME);
    if (!fs.existsSync(appBundle)) throw new Error(`DMG does not contain ${APP_NAME}`);
    if (tag) assertBuildVersion(appBundle, versionForTag(tag));
    command('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle]);
    assertDeveloperIdAndTicket(appBundle);
    command('xcrun', ['stapler', 'validate', appBundle]);
    // This is the Gatekeeper assessment that matters after drag-to-Applications.
    command('spctl', ['--assess', '--type', 'execute', '--verbose=4', appBundle]);
  } finally {
    if (volume) command('hdiutil', ['detach', volume]);
  }

  return { dmgFile, checksumFile, tag };
}

if (require.main === module) {
  const dmgIndex = process.argv.indexOf('--dmg');
  const dmgFile = dmgIndex === -1 ? undefined : process.argv[dmgIndex + 1];
  if (dmgIndex !== -1 && !dmgFile) throw new Error('--dmg requires a file path');
  const result = verifyRelease({ dmgFile });
  console.log(`verified release artifact: ${result.dmgFile}`);
}

module.exports = {
  assertChecksum,
  assertBuildVersion,
  assertTagMatchesPackageVersion,
  packageVersion,
  sha256File,
  verifyRelease,
  versionForTag,
};
