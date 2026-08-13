'use strict';

/**
 * One Clippy in the menu bar, ever.
 *
 * Electron's own `requestSingleInstanceLock` is scoped to the user-data
 * directory, so a second copy started with `--user-data-dir` — a dev build, a
 * sandbox, a test run — sails past it and puts a second paperclip in the menu
 * bar. Two Clippys watching the same sessions is not a mode anyone wants: they
 * both answer hooks, both pop up, and there is no way to tell which is which.
 *
 * So the lock lives at a fixed path instead of a per-profile one, and holds a
 * pid rather than a flag: a machine that lost power mid-session should not need
 * a stale file deleting by hand before Clippy will start again.
 *
 * The decisions here are pure so they can be tested without a second Electron:
 * `readLock` parses, `holderOf` decides.
 */

const path = require('node:path');

/** Where the lock lives, whatever `--user-data-dir` says. */
const lockPath = (home) =>
  path.join(home, 'Library', 'Application Support', 'clippy-for-claude', 'running.lock');

/** An explicit "yes, I really do want two" — for dev, and nothing else. */
const allowsMultiple = (env = process.env) =>
  env.CLIPPY_ALLOW_MULTIPLE === '1' || env.CLIPPY_SANDBOX === '1';

/**
 * @param {string} raw contents of the lock file
 * @returns {{pid: number, at: number}|null}
 */
function readLock(raw) {
  try {
    const parsed = JSON.parse(String(raw));
    const pid = Number(parsed && parsed.pid);
    if (!Number.isInteger(pid) || pid <= 1) return null;
    return { pid, at: Number(parsed.at) || 0 };
  } catch {
    return null;
  }
}

const writeLock = (pid = process.pid, at = Date.now()) => JSON.stringify({ pid, at });

/**
 * Who, if anyone, is already running?
 *
 * Returns the holder's pid, or 0 when the way is clear. A lock naming a pid
 * that is gone is not a holder — it is litter from a crash, and treating it as
 * one would mean Clippy never starts again.
 *
 * @param {string|null} raw      lock contents, or null when there is no file
 * @param {(pid: number) => boolean} isAlive
 * @param {number} self          this process's pid
 */
function holderOf(raw, isAlive, self = process.pid) {
  const lock = raw == null ? null : readLock(raw);
  if (!lock) return 0;
  if (lock.pid === self) return 0; // our own, from a previous run of this pid
  return isAlive(lock.pid) ? lock.pid : 0;
}

/**
 * What a running Clippy should do about whatever the lock says now.
 *
 * Claiming the menu bar once, at startup, turned out not to be enough. The
 * lock is a file, and a file can go missing — a copy quitting late, a crash
 * between the read and the write, someone clearing Application Support. Once
 * it is gone the running Clippy is no longer defending anything, and the next
 * start walks straight in. That is the "sometimes I get two" case, and it can
 * only be fixed by looking more than once.
 *
 * Pure, so the three-way decision can be tested without two Electrons:
 *
 *   'keep'   the lock is ours and correct — nothing to do
 *   'retake' it is missing, litter, or a newcomer's — write ours again
 *   'yield'  somebody else was here first — this copy is the one to go
 *
 * Ties are broken by claim time, not by pid, so the two copies cannot both
 * decide to yield (leaving none) or both decide to stay (leaving two). The
 * older claim wins, which is the one the user has had on screen for longer.
 *
 * @param {string|null} raw   lock contents, or null when there is no file
 * @param {(pid: number) => boolean} isAlive
 * @param {{pid: number, at: number}} self  our pid and when we first claimed
 */
function defend(raw, isAlive, self) {
  const lock = raw == null ? null : readLock(raw);
  if (!lock) return 'retake'; // missing or unreadable: ours to hold again
  if (lock.pid === self.pid) return 'keep';
  if (!isAlive(lock.pid)) return 'retake'; // litter from a copy that crashed

  // A live rival. Whoever claimed first keeps the menu bar; an identical
  // timestamp is broken by pid so the two never disagree about who goes.
  if (lock.at < self.at) return 'yield';
  if (lock.at === self.at && lock.pid < self.pid) return 'yield';
  return 'retake';
}

module.exports = { lockPath, allowsMultiple, readLock, writeLock, holderOf, defend };
