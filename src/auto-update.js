'use strict';

/**
 * The small, deliberately boring macOS updater for the DMG build.
 *
 * GitHub releases a notarized DMG and its SHA-256 sidecar. We download both,
 * verify the bytes before mounting anything, copy the signed app out to a
 * private staging directory, then leave a tiny shell helper behind. The helper
 * waits for Electron to exit, replaces the bundle, and reopens it. An app in
 * /Applications may need macOS administrator approval; a user-writable app
 * replaces itself without a prompt.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { Readable } = require('node:stream');

const execFileAsync = promisify(execFile);
const BUNDLE_ID = 'dev.aisocratic.clippy';
const PRODUCT = 'Clippy for Claude Code.app';

function checksumFrom(text, filename) {
  const match = new RegExp(`^([a-f0-9]{64})\\s{2}${escapeRegExp(filename)}$`, 'im').exec(String(text || '').trim());
  return match ? match[1].toLowerCase() : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One shell word, whatever is in it.
 *
 * `'"'"'` is the POSIX way to put a single quote inside single quotes: close,
 * an escaped quote of its own, reopen. An earlier version escaped the inner
 * double quotes as well, which produced a script `sh` could not even parse
 * once an app or a home directory had an apostrophe in its name.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/**
 * Where an update is allowed to come from.
 *
 * The two links arrive in a JSON document off the network, and the DMG one is
 * followed through GitHub's redirect onto its asset host — so "https" alone is
 * not enough, and neither is trusting whatever the release record says. Both
 * links, and the host each redirect lands on, have to be GitHub's.
 */
const RELEASE_HOSTS = /(^|\.)(github\.com|githubusercontent\.com)$/;

function releaseUrl(value, what) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`the release ${what} link is not a URL`);
  }
  if (url.protocol !== 'https:' || !RELEASE_HOSTS.test(url.hostname)) {
    throw new Error(`the release ${what} does not come from GitHub over https`);
  }
  return url.href;
}

// A checksum sidecar is one line and an installer is a few hundred megabytes.
// Both are fetched before anything has been verified, so both are capped: a
// host that answers either with an endless stream costs us the cap and no more.
const MAX_CHECKSUM_BYTES = 8 * 1024;
const MAX_DMG_BYTES = 512 * 1024 * 1024;

/** The body, chunk by chunk, giving up the moment it goes past `maxBytes`. */
async function* capped(response, maxBytes, what) {
  let total = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`the release ${what} is bigger than it should be`);
    yield chunk;
  }
}

/** Refuse a redirect that left GitHub, whatever the release record said. */
function checkLanding(response, what) {
  if (response.url) releaseUrl(response.url, what);
}

async function download(url, destination, fetchImpl = fetch) {
  const response = await fetchImpl(releaseUrl(url, 'installer'), {
    headers: { 'User-Agent': 'clippy-for-claude' },
  });
  if (!response.ok) throw new Error(`download answered ${response.status}`);
  checkLanding(response, 'installer');
  const hash = crypto.createHash('sha256');
  const output = fs.createWriteStream(destination, { mode: 0o600 });
  try {
    for await (const chunk of capped(response, MAX_DMG_BYTES, 'installer')) {
      hash.update(chunk);
      if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
    }
    await new Promise((resolve, reject) => output.end((err) => (err ? reject(err) : resolve())));
    return hash.digest('hex');
  } catch (err) {
    output.destroy();
    await fsp.rm(destination, { force: true }).catch(() => {});
    throw err;
  }
}

async function verifiedDmg(release, directory, fetchImpl = fetch) {
  if (!release?.dmg || !release?.checksum) {
    throw new Error('this release has no verified DMG update');
  }
  const dmgUrl = releaseUrl(release.dmg, 'installer');
  const filename = path.basename(new URL(dmgUrl).pathname) || 'Clippy-for-Claude-Code.dmg';
  const checksumResponse = await fetchImpl(releaseUrl(release.checksum, 'checksum'), {
    headers: { 'User-Agent': 'clippy-for-claude' },
  });
  if (!checksumResponse.ok) throw new Error(`checksum download answered ${checksumResponse.status}`);
  checkLanding(checksumResponse, 'checksum');
  const parts = [];
  for await (const chunk of capped(checksumResponse, MAX_CHECKSUM_BYTES, 'checksum')) parts.push(chunk);
  const expected = checksumFrom(Buffer.concat(parts).toString('utf8'), filename);
  if (!expected) throw new Error('release checksum is missing or malformed');
  const dmg = path.join(directory, filename);
  const actual = await download(dmgUrl, dmg, fetchImpl);
  if (actual !== expected) {
    await fsp.rm(dmg, { force: true });
    throw new Error('downloaded update failed its checksum');
  }
  return dmg;
}

async function command(file, args) {
  return execFileAsync(file, args, { maxBuffer: 1024 * 1024 });
}

async function stagedApp(dmg, directory) {
  const mount = path.join(directory, 'mount');
  const stage = path.join(directory, PRODUCT);
  await fsp.mkdir(mount, { mode: 0o700 });
  await command('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]);
  try {
    const app = path.join(mount, PRODUCT);
    await fsp.access(app, fs.constants.R_OK);
    // Verify the app's signature and make sure a different signed bundle cannot
    // use Clippy's release feed as its delivery mechanism.
    const { stderr } = await command('/usr/bin/codesign', ['-dv', '--verbose=4', app]);
    if (!String(stderr).includes(`Identifier=${BUNDLE_ID}`)) throw new Error('update has the wrong app identity');
    await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    await command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
    await command('/usr/bin/ditto', ['--rsrc', '--extattr', app, stage]);
  } finally {
    await command('/usr/bin/hdiutil', ['detach', mount]).catch(() => {});
  }
  return stage;
}

function installerScript({ pid, source, destination, work }) {
  const replace = `/bin/rm -rf ${shellQuote(destination)} && /usr/bin/ditto --rsrc --extattr ${shellQuote(source)} ${shellQuote(destination)}`;
  const privilegedReplace = `do shell script ${JSON.stringify(replace)} with administrator privileges`;
  // If the parent is protected (normally /Applications), hand only this fixed,
  // fully-quoted replacement command to macOS for authorization.
  return `#!/bin/sh\nset -eu\nwhile /bin/kill -0 ${Number(pid)} 2>/dev/null; do /bin/sleep 0.2; done\nif [ -w ${shellQuote(path.dirname(destination))} ]; then\n  ${replace}\nelse\n  /usr/bin/osascript -e ${shellQuote(privilegedReplace)}\nfi\n/usr/bin/open ${shellQuote(destination)}\n/bin/rm -rf ${shellQuote(work)}\n`;
}

async function prepareInstall({ release, destination, fetchImpl = fetch, pid = process.pid }) {
  if (process.platform !== 'darwin') throw new Error('automatic updates are currently available on macOS only');
  if (!destination || !destination.endsWith('.app')) throw new Error('Clippy is not running from an app bundle');
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'clippy-update-'));
  try {
    const dmg = await verifiedDmg(release, work, fetchImpl);
    const source = await stagedApp(dmg, work);
    const helper = path.join(work, 'install-and-relaunch.sh');
    await fsp.writeFile(helper, installerScript({ pid, source, destination, work }), { mode: 0o700 });
    return { helper, work };
  } catch (err) {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

function launchInstall(helper) {
  const child = spawn('/bin/sh', [helper], { detached: true, stdio: 'ignore' });
  child.unref();
}

module.exports = { checksumFrom, installerScript, verifiedDmg, prepareInstall, launchInstall, BUNDLE_ID, PRODUCT };
