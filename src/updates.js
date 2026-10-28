'use strict';

/**
 * Where this copy of Clippy came from, and whether GitHub has moved on.
 *
 * A checkout updates with `git pull`; the packaged app compares itself against
 * the newest signed release. The installer path lives in auto-update.js; this
 * module deliberately stays pure and only says which release is available.
 * Pure logic with the network call injectable, so all of it is testable
 * offline.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = 'AISocratic/clippy';
const LATEST_URL = `https://api.github.com/repos/${REPO}/commits/main`;
const RELEASE_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

/**
 * The commit this checkout is sitting on, read straight from .git — no `git`
 * binary needed, which matters inside the packaged app (where there is no
 * .git at all and this returns nulls: that's how we know it's the app).
 */
function localBuild(rootDir) {
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version || null;
  } catch {
    /* no package.json — nothing to report */
  }

  const git = path.join(rootDir, '.git');
  let sha = null;
  let branch = null;
  try {
    const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      branch = ref.split('/').pop();
      try {
        sha = fs.readFileSync(path.join(git, ref), 'utf8').trim();
      } catch {
        // A packed ref: one file of "sha ref" lines.
        const packed = fs.readFileSync(path.join(git, 'packed-refs'), 'utf8');
        for (const line of packed.split('\n')) {
          const [s, r] = line.split(' ');
          if (r && r.trim() === ref) sha = s.trim();
        }
      }
    } else if (/^[0-9a-f]{40}$/i.test(head)) {
      sha = head; // detached
    }
  } catch {
    /* not a checkout — the packaged app */
  }

  return { version, sha, branch, source: sha ? 'checkout' : 'packaged' };
}

/** The tip of main on GitHub: { sha, date, message }. */
async function fetchLatest(fetchImpl = fetch) {
  const res = await fetchImpl(LATEST_URL, {
    headers: { 'User-Agent': 'clippy-for-claude', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = await res.json();
  return {
    sha: body.sha,
    date: body.commit?.committer?.date || body.commit?.author?.date || null,
    message: (body.commit?.message || '').split('\n')[0],
  };
}

/** The newest published release: { version, tag, date, url, dmg, checksum }. */
async function fetchLatestRelease(fetchImpl = fetch) {
  const res = await fetchImpl(RELEASE_URL, {
    headers: { 'User-Agent': 'clippy-for-claude', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = await res.json();
  const tag = body.tag_name || '';
  const dmg = (body.assets || []).find((a) => (a.name || '').endsWith('.dmg'));
  // A downloaded installer is accepted only when the release also publishes
  // the checksum our release job writes beside every DMG.
  const checksum = dmg
    ? (body.assets || []).find((a) => a.name === `${dmg.name}.sha256`)
    : null;
  return {
    tag,
    version: tag.replace(/^v/, ''),
    date: body.published_at || null,
    url: body.html_url || `https://github.com/${REPO}/releases/latest`,
    dmg: dmg ? dmg.browser_download_url : null,
    checksum: checksum ? checksum.browser_download_url : null,
  };
}

/**
 * Is `candidate` a newer release than `current`? Plain dotted numbers, the
 * way package.json and the tags are written; anything unparseable is not newer.
 *
 * Newer, not merely different: a build ahead of the newest release — a local
 * package of main, or a tag whose release is still a draft — used to be told
 * it was out of date and offered the older DMG, which installed a downgrade.
 */
function isNewerVersion(candidate, current) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
    return m ? m.slice(1, 4).map(Number) : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/**
 * Put the two together into what the settings page shows. `upToDate` is only
 * ever true or false when we can actually compare, and each source is compared
 * against the thing it actually updates from: a checkout against the tip of
 * main (git pull), the packaged app against the newest release (a fresh DMG).
 */
async function checkForUpdates(rootDir, fetchImpl = fetch) {
  const build = localBuild(rootDir);
  if (!build.sha) {
    // The packaged app: no git, but it knows its version — the latest release
    // says whether a newer DMG exists and where to get it.
    try {
      const release = await fetchLatestRelease(fetchImpl);
      return {
        ...build,
        release,
        upToDate:
          build.version && release.version ? !isNewerVersion(release.version, build.version) : null,
      };
    } catch (err) {
      return { ...build, release: null, upToDate: null, error: err.message };
    }
  }
  try {
    const latest = await fetchLatest(fetchImpl);
    return {
      ...build,
      latest,
      upToDate: build.sha === latest.sha,
    };
  } catch (err) {
    return { ...build, latest: null, upToDate: null, error: err.message };
  }
}

module.exports = {
  localBuild,
  fetchLatest,
  fetchLatestRelease,
  checkForUpdates,
  isNewerVersion,
  REPO,
  LATEST_URL,
  RELEASE_URL,
};
