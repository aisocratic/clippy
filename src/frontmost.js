'use strict';

/**
 * Is the user already looking at the window that wants them?
 *
 * Clippy exists because the thing asking for you is behind something else. When
 * it isn't — when the terminal Claude is asking in is the window you are
 * already typing in — a paperclip popping up over it is noise, and an OS
 * notification about a prompt three inches from the cursor is worse. So before
 * showing anything, ask who is in front.
 *
 * `lsappinfo` answers that in about five milliseconds and needs **no
 * permission at all**, which is the whole reason it is used here rather than
 * the obvious `tell application "System Events" to get name of first process
 * whose frontmost is true`. That one needs the Automation grant, fails *inside
 * a try block* when it is missing, and would put a consent dialog in front of
 * someone at the exact moment a hook fired. This runs on every hook; it cannot
 * be something that prompts.
 *
 * The one thing being in front does not tell you is *which tab*. Terminal.app
 * and iTerm2 both hold a dozen sessions in one window, so for those two the
 * answer is refined by asking which tty is selected — the same AppleScript
 * route perching already uses, so it is not a new kind of permission, only a
 * new caller.
 *
 * Everything here is pure except `frontmostApp` and `focusedTty`, so the
 * decision is testable without a Mac in front of it.
 */

const { execFile } = require('node:child_process');
const { TERMINAL_APP, ITERM_APP } = require('./terminal');

const LSAPPINFO = '/usr/bin/lsappinfo';
const OSASCRIPT = '/usr/bin/osascript';

// Short: this sits in front of every hook, and a hook that has to wait on it is
// a hook that made the agent wait. Better to answer "don't know" quickly.
const PROBE_TIMEOUT_MS = 1500;

/**
 * The two terminals whose tabs we can actually read, by bundle id.
 *
 * These are matched by bundle rather than by process, because the tty route in
 * terminal.js never resolves an app pid for them — it talks to the app by name
 * and finds the tab itself, so there is no pid here to compare against.
 */
const PROGRAM_BUNDLES = {
  [TERMINAL_APP]: 'com.apple.Terminal',
  [ITERM_APP]: 'com.googlecode.iterm2',
};

const bundleForProgram = (program) => PROGRAM_BUNDLES[program] || '';

/** `ASN:0x0-0x23797774:` out of whatever else lsappinfo prints. */
function parseAsn(stdout = '') {
  const m = String(stdout).match(/ASN:[^\s"]+/);
  return m ? m[0] : '';
}

/**
 * `"pid"=123` / `"CFBundleIdentifier"="com.foo"` -> {pid, bundleId, name}.
 *
 * Returns null when there is no pid, because a front app we cannot identify is
 * the same as not knowing — and not knowing must never suppress anything.
 */
function parseAppInfo(stdout = '') {
  const text = String(stdout);
  const field = (key) => {
    const m = text.match(new RegExp(`"${key}"\\s*=\\s*"?([^"\\n]*)"?`));
    return m ? m[1].trim() : '';
  };
  const pid = Number(field('pid')) || 0;
  if (!pid) return null;
  return { pid, bundleId: field('CFBundleIdentifier'), name: field('LSDisplayName') };
}

/**
 * Which tty is showing in the front window of a terminal we can ask.
 *
 * Both scripts answer "none" rather than failing, so a terminal with no windows
 * open reads as "cannot tell" instead of throwing into the caller's lap.
 */
function focusedTtyScript(program) {
  if (program === TERMINAL_APP) {
    return `tell application "Terminal"
  if (count of windows) is 0 then return "none"
  try
    return tty of selected tab of front window
  end try
  return "none"
end tell`;
  }
  if (program === ITERM_APP) {
    return `tell application "iTerm2"
  try
    return tty of current session of current tab of current window
  end try
  return "none"
end tell`;
  }
  return null;
}

const parseTty = (stdout = '') => {
  const value = String(stdout).trim();
  return !value || value === 'none' ? '' : value;
};

/**
 * The decision: is this session's window the one in front?
 *
 * Deliberately biased towards "no". Being wrong in this direction means Clippy
 * pops up when it did not strictly need to, which is the behaviour it has
 * always had; being wrong the other way means a message the user never sees.
 * So every kind of not-knowing — no front app, no way to identify this
 * session's app, a terminal whose tabs we cannot read — answers false.
 *
 * @param {object} front        {pid, bundleId, name} from frontmostApp
 * @param {object|null} app     the session's owning .app, if we resolved one
 * @param {string} program      TERM_PROGRAM as the hook reported it
 * @param {string} tty          the session's tty, when we know it
 * @param {string|null} focusedTty  which tty that app is showing, if we asked
 */
function looksFocused({ front, app = null, program = '', tty = '', focusedTty = null } = {}) {
  if (!front || !front.pid) return false;

  const bundle = bundleForProgram(program);
  const sameApp =
    (app && Number(app.pid) > 0 && Number(app.pid) === Number(front.pid)) ||
    Boolean(bundle && bundle === front.bundleId);
  if (!sameApp) return false;

  // Terminal.app and iTerm2 keep a dozen sessions in one window: the app being
  // frontmost says nothing about whether *this* one is the tab on screen.
  if (bundle && tty) return Boolean(focusedTty) && focusedTty === tty;

  return true;
}

/* ---------------- The bits that actually touch the machine ---------------- */

function run(cmd, args, { timeout = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/**
 * Who is in front right now, or null if we could not tell.
 *
 * Two execs rather than one: `lsappinfo` will not take `front` as an argument
 * to `info`, so the ASN has to be fetched first. Together they cost a few
 * milliseconds, which is why this is not cached at this level — the caller
 * caches, because only the caller knows what a burst of hooks looks like.
 */
async function frontmostApp({ exec = run } = {}) {
  try {
    const asn = parseAsn(await exec(LSAPPINFO, ['front']));
    if (!asn) return null;
    return parseAppInfo(await exec(LSAPPINFO, ['info', '-only', 'pid,bundleid,name', asn]));
  } catch {
    // No lsappinfo, a timeout, a machine that is not a Mac: all of them mean
    // "don't know", and not knowing never suppresses anything.
    return null;
  }
}

/** Which tty the given terminal is showing, '' when it cannot be asked. */
async function focusedTty(program, { exec = run } = {}) {
  const script = focusedTtyScript(program);
  if (!script) return '';
  try {
    return parseTty(await exec(OSASCRIPT, ['-e', script]));
  } catch {
    // Automation not granted, or the app is busy — either way, unknown.
    return '';
  }
}

/**
 * A focus check with a short memory.
 *
 * One agent turn can fire several hooks inside a second, and each one asking
 * the window server the same question is waste — but a memory any longer than
 * that would answer for a desktop the user has since switched away from. The
 * window is deliberately shorter than the time it takes a person to alt-tab.
 */
function createFocusProbe({ exec = run, ttlMs = 400, now = Date.now } = {}) {
  let cachedAt = 0;
  let cached = null;
  let inFlight = null;

  async function look() {
    const front = await frontmostApp({ exec });
    // Only ask about tabs when the app in front is one whose tabs we can read;
    // anything else is an osascript we would run for no answer.
    const program = Object.keys(PROGRAM_BUNDLES).find(
      (p) => PROGRAM_BUNDLES[p] === front?.bundleId
    );
    const tty = program ? await focusedTty(program, { exec }) : '';
    return { front, focusedTty: tty };
  }

  return {
    /** @returns {Promise<{front: object|null, focusedTty: string}>} */
    async current() {
      if (cached && now() - cachedAt < ttlMs) return cached;
      // Share one probe between everything that asks during the same burst.
      inFlight ||= look()
        .then((result) => {
          cached = result;
          cachedAt = now();
          return result;
        })
        .catch(() => ({ front: null, focusedTty: '' }))
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
    /** Forget what we saw — used when something has certainly changed. */
    forget() {
      cached = null;
      cachedAt = 0;
    },
  };
}

module.exports = {
  parseAsn,
  parseAppInfo,
  bundleForProgram,
  focusedTtyScript,
  parseTty,
  looksFocused,
  frontmostApp,
  focusedTty,
  createFocusProbe,
  PROGRAM_BUNDLES,
};
