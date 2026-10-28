'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { localBuild, checkForUpdates, isNewerVersion } = require('../src/updates');
const { checksumFrom, installerScript, verifiedDmg, BUNDLE_ID } = require('../src/auto-update');

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
  // The packaged path asks the releases endpoint; an answer that isn't a
  // release (no tag) gives no version to compare, and no verdict.
  const info = await checkForUpdates(dir, gh('b'.repeat(40)));
  assert.equal(info.source, 'packaged');
  assert.equal(info.upToDate, null, 'no version to compare means no verdict');
});

test('same sha is up to date, a different one is not', async () => {
  const sha = 'c'.repeat(40);
  assert.equal((await checkForUpdates(checkoutAt(sha), gh(sha))).upToDate, true);
  assert.equal((await checkForUpdates(checkoutAt(sha), gh('d'.repeat(40)))).upToDate, false);
});

const ghRelease = (tag, { dmg = true, checksum = true } = {}) => async () => ({
  ok: true,
  json: async () => ({
    tag_name: tag,
    published_at: '2026-08-06T00:00:00Z',
    html_url: `https://github.com/AISocratic/clippy/releases/tag/${tag}`,
    assets: dmg
      ? [
          { name: 'Clippy-for-Claude-Code.dmg', browser_download_url: `https://github.com/AISocratic/clippy/releases/download/${tag}/Clippy-for-Claude-Code.dmg` },
          ...(checksum
            ? [{ name: 'Clippy-for-Claude-Code.dmg.sha256', browser_download_url: `https://github.com/AISocratic/clippy/releases/download/${tag}/Clippy-for-Claude-Code.dmg.sha256` }]
            : []),
        ]
      : [],
  }),
});

test('the packaged app measures itself against the newest release', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.2.0' }));

  const current = await checkForUpdates(dir, ghRelease('v0.2.0'));
  assert.equal(current.source, 'packaged');
  assert.equal(current.upToDate, true);
  assert.equal(current.release.version, '0.2.0');

  const stale = await checkForUpdates(dir, ghRelease('v0.3.0'));
  assert.equal(stale.upToDate, false);
  assert.match(stale.release.dmg, /v0\.3\.0.*\.dmg$/);
  assert.match(stale.release.checksum, /v0\.3\.0.*\.dmg\.sha256$/);
});

test('a build ahead of the newest release is not offered a downgrade', async () => {
  // A local package of main, or a tagged version whose release is still a
  // draft, is newer than anything published. Telling it "out of date" put the
  // older DMG one click away — and that click really did install v0.3.1 over
  // a 0.3.2 build.
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.3.2' }));
  const ahead = await checkForUpdates(dir, ghRelease('v0.3.1'));
  assert.equal(ahead.upToDate, true);

  assert.equal(isNewerVersion('0.3.2', '0.3.1'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.9'), true, 'numeric, not lexical');
  assert.equal(isNewerVersion('1.0.0', '0.99.99'), true);
  assert.equal(isNewerVersion('0.3.1', '0.3.2'), false);
  assert.equal(isNewerVersion('0.3.1', '0.3.1'), false);
  assert.equal(isNewerVersion('v0.3.2', '0.3.1'), false, 'tags are stripped before they get here');
  assert.equal(isNewerVersion(undefined, '0.3.1'), false);
});

test('an installed update needs the exact DMG checksum and a safe replacement helper', () => {
  const digest = 'a'.repeat(64);
  assert.equal(checksumFrom(`${digest}  Clippy-for-Claude-Code.dmg\n`, 'Clippy-for-Claude-Code.dmg'), digest);
  assert.equal(checksumFrom(`${digest}  another.dmg`, 'Clippy-for-Claude-Code.dmg'), null);

  const script = installerScript({
    pid: 1234,
    source: '/private/tmp/new app/Clippy for Claude Code.app',
    destination: '/Applications/Clippy for Claude Code.app',
    work: '/private/tmp/update',
  });
  assert.match(script, /while \/bin\/kill -0 1234/);
  assert.match(script, /\/usr\/bin\/ditto --rsrc --extattr/);
  assert.match(script, /with administrator privileges/);
  assert.equal(BUNDLE_ID, 'dev.aisocratic.clippy');
});

test('a release without a DMG asset still reports, just without a download link', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  const info = await checkForUpdates(dir, ghRelease('v0.2.0', { dmg: false }));
  assert.equal(info.upToDate, false);
  assert.equal(info.release.dmg, null);
  assert.match(info.release.url, /releases\/tag\/v0\.2\.0$/);
});

test('an unreachable GitHub is an error message, not a crash', async () => {
  const info = await checkForUpdates(checkoutAt('e'.repeat(40)), async () => ({ ok: false, status: 403 }));
  assert.equal(info.upToDate, null);
  assert.match(info.error, /403/);
});

test('the replacement helper survives a path with an apostrophe in it', () => {
  // `'"'"'` is the POSIX way to put a quote inside single quotes. An earlier
  // version escaped the inner double quotes too, and produced a script `sh`
  // could not parse at all — so a user called O'Brien, or an app copied to a
  // folder with an apostrophe in its name, got an update that did nothing and
  // said nothing. Both branches are checked: the plain one runs under /bin/sh,
  // and the privileged one hands its command to AppleScript first.
  const script = installerScript({
    pid: 4321,
    source: "/private/tmp/new app/O'Brien.app",
    destination: "/Applications/O'Brien.app",
    work: '/private/tmp/update',
  });

  const dir = tmp();
  const file = path.join(dir, 'install.sh');
  fs.writeFileSync(file, script);
  // `sh -n` parses without running: no update is installed by this test.
  execFileSync('/bin/sh', ['-n', file]);

  // The apostrophe is quoted the one way that works, and never as `\"`.
  assert.match(script, /\/Applications\/O'"'"'Brien\.app/);
  assert.ok(!/O'\\"/.test(script), 'the inner quotes must not be backslash-escaped');
});

/** A fetch that answers with real Response bodies, so the byte caps apply. */
const releaseFetch = (files) => async (url) => {
  const body = files[String(url)];
  if (body === undefined) throw new Error(`nothing published at ${url}`);
  return new Response(Buffer.from(body));
};

const DMG_URL = 'https://github.com/AISocratic/clippy/releases/download/v9/Clippy.dmg';
const SUM_URL = `${DMG_URL}.sha256`;

test('a DMG is only kept when its published checksum matches, byte for byte', async () => {
  const bytes = 'not really a disk image, but it hashes the same way';
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const dir = tmp();

  const dmg = await verifiedDmg(
    { dmg: DMG_URL, checksum: SUM_URL },
    dir,
    releaseFetch({ [DMG_URL]: bytes, [SUM_URL]: `${digest}  Clippy.dmg\n` })
  );
  assert.equal(fs.readFileSync(dmg, 'utf8'), bytes);

  // A DMG that does not match what the release published is deleted, not left
  // on disk for something else to mount.
  const wrong = tmp();
  await assert.rejects(
    verifiedDmg(
      { dmg: DMG_URL, checksum: SUM_URL },
      wrong,
      releaseFetch({ [DMG_URL]: 'something else entirely', [SUM_URL]: `${digest}  Clippy.dmg\n` })
    ),
    /failed its checksum/
  );
  assert.deepEqual(fs.readdirSync(wrong), []);
});

test('an update is only ever fetched from GitHub, over https', async () => {
  // Both links arrive inside a JSON document off the network. Neither is
  // downloaded, hashed and mounted on the strength of what that document says.
  const digest = 'f'.repeat(64);
  const elsewhere = [
    { dmg: 'http://github.com/AISocratic/clippy/releases/download/v9/Clippy.dmg', checksum: SUM_URL },
    { dmg: 'https://evil.example/Clippy.dmg', checksum: SUM_URL },
    { dmg: 'file:///tmp/Clippy.dmg', checksum: SUM_URL },
    { dmg: DMG_URL, checksum: 'https://evil.example/Clippy.dmg.sha256' },
  ];
  for (const release of elsewhere) {
    await assert.rejects(
      verifiedDmg(release, tmp(), releaseFetch({ [DMG_URL]: 'x', [SUM_URL]: `${digest}  Clippy.dmg\n` })),
      /does not come from GitHub over https|is not a URL/,
      `${release.dmg} / ${release.checksum} should have been refused`
    );
  }
});

test('a checksum sidecar that never ends is dropped rather than buffered', async () => {
  // One line is all it can be. Reading whatever a host feels like sending is
  // how a small verification step becomes the memory the app runs out of.
  await assert.rejects(
    verifiedDmg(
      { dmg: DMG_URL, checksum: SUM_URL },
      tmp(),
      releaseFetch({ [DMG_URL]: 'x', [SUM_URL]: 'a'.repeat(64 * 1024) })
    ),
    /bigger than it should be/
  );
});
