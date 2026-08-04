'use strict';

/**
 * Where this copy of Clippy came from, and whether GitHub has moved on.
 *
 * There is no update server and no auto-updater — deliberately. A checkout
 * updates with `git pull`, the packaged app by rebuilding, and this module's
 * whole job is to tell you *honestly* which of those you're holding and
 * whether there's anything newer to pull. Pure logic with the network call
 * injectable, so all of it is testable offline.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO = 'AISocratic/clippy';
const LATEST_URL = `https://api.github.com/repos/${REPO}/commits/main`;

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

/**
 * Put the two together into what the settings page shows. `upToDate` is only
 * ever true or false when we can actually compare — a packaged app has no sha
 * to compare with, and pretending would be the kind of lie this app avoids.
 */
async function checkForUpdates(rootDir, fetchImpl = fetch) {
  const build = localBuild(rootDir);
  try {
    const latest = await fetchLatest(fetchImpl);
    return {
      ...build,
      latest,
      upToDate: build.sha ? build.sha === latest.sha : null,
    };
  } catch (err) {
    return { ...build, latest: null, upToDate: null, error: err.message };
  }
}

module.exports = { localBuild, fetchLatest, checkForUpdates, REPO, LATEST_URL };
