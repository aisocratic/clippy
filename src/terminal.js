'use strict';

/**
 * Finding — and perching on — the window that a Claude Code session lives in.
 *
 * The hooks tell us three things about the terminal they ran in: `TERM_PROGRAM`,
 * the tty of the `claude` process, and its pid. From those we can:
 *
 *   - raise the exact tab (Terminal.app and iTerm2 expose `tty` in AppleScript)
 *   - or, for any other terminal, walk up the process tree to the owning
 *     `.app` bundle and raise/measure that process through System Events
 *
 * Everything here is a pure string/JS transform except `run()`, so the tricky
 * parts (parsing the process table, building the scripts) are testable without
 * a Mac in the loop.
 */

const { execFile } = require('node:child_process');

const OSASCRIPT_TIMEOUT_MS = 5000;

/** Pull the terminal context a hook shipped in its headers. */
function terminalFromHeaders(headers = {}) {
  const get = (k) => {
    const v = headers[k];
    return typeof v === 'string' ? v.trim() : '';
  };
  const program = get('x-clippy-term');
  const tty = get('x-clippy-tty');
  const pid = Number(get('x-clippy-pid')) || 0;
  if (!program && !tty && !pid) return null;
  // ps prints `s004`-style short names; AppleScript wants the device path.
  const device = tty && tty !== '??' ? (tty.startsWith('/dev/') ? tty : `/dev/tty${tty.replace(/^tty/, '')}`) : '';
  return { program, tty: device, pid };
}

/**
 * Parse `ps -Ao pid=,ppid=,comm=` output.
 * @returns {Map<number, {ppid: number, comm: string}>}
 */
function parseProcessTable(stdout = '') {
  const table = new Map();
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3].trim() });
  }
  return table;
}

/**
 * `/Applications/Ghostty.app/Contents/MacOS/ghostty` -> `Ghostty`.
 *
 * Electron-based editors run their terminals in a helper process nested under
 * `Contents/Frameworks` (VS Code's "Code Helper", Cursor's, …). Those own no
 * windows, so they don't count as the app — keep walking up to the real one.
 */
function appNameFromComm(comm = '') {
  const s = String(comm);
  if (s.includes('/Contents/Frameworks/')) return '';
  const m = s.match(/([^/]+)\.app\/Contents\/MacOS\//);
  return m ? m[1] : '';
}

/**
 * Walk up from a pid until we hit a process that belongs to a `.app` bundle —
 * that's the terminal emulator (Ghostty, WezTerm, VS Code, …) hosting the
 * session. Returns null if the chain is gone or never reaches an app.
 */
function findAppAncestor(pid, table, { maxHops = 12 } = {}) {
  let current = Number(pid) || 0;
  for (let i = 0; i < maxHops && current > 1; i++) {
    const entry = table.get(current);
    if (!entry) return null;
    const name = appNameFromComm(entry.comm);
    // The bundle path rides along: `open <bundle>` is how the app gets raised
    // without any Automation grant (see activateApp below).
    if (name) return { pid: current, name, bundle: entry.comm.split('.app/')[0] + '.app' };
    current = entry.ppid;
  }
  return null;
}

/**
 * Every pid from `pid` up to the root of the tree, `pid` itself included.
 *
 * The hooks report the agent's own pid; a session Clippy started knows the pid
 * of the shell tmux put in the pane. Walking up from one to look for the other
 * is how a hook gets matched to the pane it came from. `pid` is in the chain
 * because a pane whose command `exec`s has no intermediate shell at all, and
 * that case must match too.
 *
 * A walk, not an equality test, because the chain can legitimately grow a link:
 * an npm shim, a wrapper script, a `claude` that is really `node claude.js`.
 */
function ancestorsOf(pid, table, { maxHops = 12 } = {}) {
  const chain = [];
  let current = Number(pid) || 0;
  for (let i = 0; i < maxHops && current > 1; i++) {
    const entry = table.get(current);
    if (!entry) break;
    chain.push(current);
    current = entry.ppid;
  }
  return chain;
}

/**
 * An AppleScript string literal.
 *
 * `"` and `\` are the two characters that would end the literal or start an
 * escape, and a line break is the third: AppleScript has no multi-line string,
 * so a raw newline is a *syntax error* in the middle of the script, not a
 * character in the string. Folder names are allowed newlines on macOS
 * (`mkdir $'a\nb'`), and one reaching the window hint used to break the whole
 * script — every window lookup failing for as long as that project was open.
 * The three escapes AppleScript does understand (\n, \r, \t) cover it; any
 * other control character is dropped, since none of them can be typed at a
 * terminal usefully and none of them survive a script literal.
 */
const q = (s) =>
  `"${String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x1f\x7f]/g, '')}"`;

// Every script answers with "x,y,w,h" (screen coords, top-left origin) or the
// literal "none" so one parser handles them all.
const RETURN_BOUNDS = (l, t, w, h) =>
  `return ((${l}) as text) & "," & ((${t}) as text) & "," & ((${w}) as text) & "," & ((${h}) as text)`;

const TERMINAL_APP = 'Apple_Terminal';
const ITERM_APP = 'iTerm.app';

/** Raise the tab whose tty matches, then report the window's frame. */
function appleTerminalScript(tty, { reveal }) {
  return `tell application "Terminal"
  set targetWindow to missing value
  set targetTab to missing value
  repeat with w in windows
    repeat with t in tabs of w
      try
        if tty of t is ${q(tty)} then
          set targetWindow to w
          set targetTab to t
        end if
      end try
    end repeat
  end repeat
  if targetWindow is missing value then return "none"
  ${reveal ? 'set selected of targetTab to true\n  set index of targetWindow to 1\n  activate' : ''}
  set b to bounds of targetWindow
  ${RETURN_BOUNDS('item 1 of b', 'item 2 of b', '(item 3 of b) - (item 1 of b)', '(item 4 of b) - (item 2 of b)')}
end tell`;
}

function itermScript(tty, { reveal }) {
  return `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        try
          if tty of s is ${q(tty)} then
            ${reveal ? 'activate\n            select w\n            select t\n            select s' : ''}
            set b to bounds of w
            ${RETURN_BOUNDS('item 1 of b', 'item 2 of b', '(item 3 of b) - (item 1 of b)', '(item 4 of b) - (item 2 of b)')}
          end if
        end try
      end repeat
    end repeat
  end repeat
  return "none"
end tell`;
}

// An editor's "front window" is often a floating panel (VS Code's command
// palette host is 1800x39), so ignore anything too small to be a real window.
const MIN_WINDOW_W = 320;
const MIN_WINDOW_H = 200;
const WINDOW_LOOKUP_TRIES = 3;

/**
 * Anything else: drive the owning app through System Events by its pid.
 *
 * An editor usually has several project windows open, so the right one is the
 * one whose title carries the session's project name ("main.js — clippy —
 * Visual Studio Code"). Size only breaks ties, and is the fallback when no
 * title matches.
 */
function systemEventsScript(appPid, { reveal, hint = '' }) {
  const scoreByTitle = hint
    ? `try
            if (name of w) contains ${q(hint)} then set sc to 1
          end try`
    : '';
  return `tell application "System Events"
  set procs to (every process whose unix id is ${Number(appPid)})
  if (count of procs) is 0 then return "none"
  set proc to item 1 of procs
  ${
    reveal
      ? `-- Bring the app forward *before* looking: a window on another Space or
  -- in fullscreen isn't in the accessibility list until we switch to it.
  try
    set frontmost of proc to true
  end try
  delay 0.35`
      : ''
  }
  set best to missing value
  set bestArea to 0
  set bestScore to -1
  -- An app that is busy or redrawing can report an empty window list for a
  -- moment, so ask a few times before believing it has no windows.
  repeat ${WINDOW_LOOKUP_TRIES} times
    try
      repeat with w in windows of proc
        try
          set z to size of w
          if (item 1 of z) > ${MIN_WINDOW_W} and (item 2 of z) > ${MIN_WINDOW_H} then
            set a to (item 1 of z) * (item 2 of z)
            set sc to 0
            ${scoreByTitle}
            if (sc > bestScore) or (sc is bestScore and a > bestArea) then
              set bestScore to sc
              set bestArea to a
              set best to w
            end if
          end if
        end try
      end repeat
    end try
    if best is not missing value then exit repeat
    delay 0.15
  end repeat
  if best is missing value then return "none"
  ${reveal ? 'try\n    perform action "AXRaise" of best\n  end try' : ''}
  set p to position of best
  set z to size of best
  ${RETURN_BOUNDS('item 1 of p', 'item 2 of p', 'item 1 of z', 'item 2 of z')}
end tell`;
}

/**
 * The script that raises (reveal: true) or just measures (reveal: false) a
 * session's terminal window.
 * @param {{program: string, tty: string, app: {pid,name}|null, hint?: string}} target
 */
function windowScript(target, { reveal = false } = {}) {
  if (target?.tty && target.program === TERMINAL_APP) {
    return appleTerminalScript(target.tty, { reveal });
  }
  if (target?.tty && target.program === ITERM_APP) {
    return itermScript(target.tty, { reveal });
  }
  if (target?.app?.pid) {
    return systemEventsScript(target.app.pid, { reveal, hint: target.hint || '' });
  }
  return null;
}

/** "12,34,900,600" -> {x, y, width, height}; anything else -> null. */
function parseBounds(stdout = '') {
  const parts = String(stdout).trim().split(',').map((n) => Number(n.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, width, height] = parts;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Where Clippy perches: the top-right corner of the terminal window, kept
 * inside the display's work area so it can never sail off screen.
 *
 * @param {{x,y,width,height}} bounds   the terminal window
 * @param {number} w  @param {number} h  the Clippy window
 * @param {{x,y,width,height}} workArea the display to stay inside
 * @param {{inset?: number, top?: number}} [opts]
 */
function dockPosition(bounds, w, h, workArea, { inset = 10, top = 2 } = {}) {
  const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)));
  return {
    x: clamp(bounds.x + bounds.width - w - inset, workArea.x, workArea.x + workArea.width - w),
    y: clamp(bounds.y + top, workArea.y, workArea.y + workArea.height - h),
  };
}

/**
 * Where the buddy stands to point at the prompt.
 *
 * Claude Code's input box sits at the bottom of its terminal window, so the
 * spot is bottom-left of that window with the buddy standing just above the
 * box — close enough that an arrow under his feet lands on the line you're
 * meant to type in. We can't read the real cursor position (that's inside the
 * terminal's own text buffer), so this is the window geometry we *can* see.
 *
 * @param {object} bounds    the terminal window
 * @param {number} w         buddy window width
 * @param {number} h         buddy window height
 * @param {object} workArea  the display's usable area
 * @param {object} [opts]
 * @param {number} [opts.inset]   pixels in from the window's left edge
 * @param {number} [opts.prompt]  how tall the input box is, roughly
 */
function promptPosition(bounds, w, h, workArea, { inset = 18, prompt = 62 } = {}) {
  const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)));
  return {
    x: clamp(bounds.x + inset, workArea.x, workArea.x + workArea.width - w),
    y: clamp(
      bounds.y + bounds.height - prompt - h,
      workArea.y,
      workArea.y + workArea.height - h
    ),
  };
}

/* ---------------- The bits that actually touch the machine ---------------- */

function run(cmd, args, { timeout = OSASCRIPT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

/**
 * The bundle id of an app we found on disk, or '' if it won't say.
 *
 * An app's Info.plist is usually a *binary* plist, so this asks `defaults`
 * rather than reading the file — the same question the Finder asks. Best
 * effort by design: the callers that want it (naming ChatGPT, Claude and
 * friends in source-app.js) all fall back to the app's name, so a machine
 * where this fails still gets the right words, just less robustly.
 */
async function bundleIdFor(bundlePath) {
  if (!bundlePath) return '';
  try {
    const out = await run(
      '/usr/bin/defaults',
      ['read', `${bundlePath}/Contents/Info.plist`, 'CFBundleIdentifier'],
      { timeout: 2000 }
    );
    return out.trim();
  } catch {
    return '';
  }
}

/**
 * The app that owns `pid` — the terminal emulator hosting a session, or the
 * agent app hosting it directly — via the live process table.
 */
async function appForPid(pid) {
  if (!pid) return null;
  try {
    const table = parseProcessTable(await run('/bin/ps', ['-Ao', 'pid=,ppid=,comm=']));
    const app = findAppAncestor(pid, table);
    if (!app) return null;
    return { ...app, bundleId: await bundleIdFor(app.bundle) };
  } catch (err) {
    // Indistinguishable from "no terminal app" upstream, so leave a trace here.
    console.warn('clippy: could not read the process table:', err.message);
    return null;
  }
}

/**
 * Resolve everything we need to point at a session's window. Cheap enough to
 * redo on demand, and the app pid is only looked up when the tty route can't
 * work on its own.
 */
async function resolveTarget(term, hint = '') {
  if (!term) return null;
  const direct = term.tty && (term.program === TERMINAL_APP || term.program === ITERM_APP);
  const app = direct ? null : await appForPid(term.pid);
  if (!direct && !app) return null;
  return { program: term.program, tty: term.tty, app, hint };
}

/**
 * Bring the terminal's app to the front the way a Dock click would.
 *
 * The AppleScript route (`set frontmost of proc to true`) needs macOS's
 * Automation permission for System Events, and when that's missing it fails
 * *inside a try block* — the script still measures and returns bounds, so
 * Clippy perches on a window that never actually came forward. `/usr/bin/open`
 * on the app bundle needs no permission at all: it activates a running app
 * and launches a stopped one. It can't pick the exact window or tab — the
 * script still does that afterwards, where it's allowed to.
 */
async function activateApp(target) {
  const args = target?.app?.bundle
    ? [target.app.bundle]
    : target?.program === TERMINAL_APP
    ? ['-a', 'Terminal']
    : target?.program === ITERM_APP
    ? ['-a', 'iTerm']
    : null;
  if (!args) return false;
  try {
    await run('/usr/bin/open', args, { timeout: 3000 });
    return true;
  } catch {
    // best effort — the script's own frontmost/AXRaise still gets its turn
    return false;
  }
}

/**
 * Raise a session's window.
 *
 * Two answers, not one, because they fail apart: `open` on the bundle needs no
 * permission and brings the *app* forward, while picking its exact window needs
 * Accessibility. Without that grant — and for an agent app like ChatGPT or
 * Claude, which most people have never granted it to — the app really is in
 * front of the user now, and reporting "I couldn't find that window" would be
 * a lie about something that visibly just happened.
 *
 * @returns {Promise<{bounds: object|null, activated: boolean}>}
 */
async function revealWindow(target) {
  const activated = await activateApp(target);
  return { bounds: await runWindowScript(target, { reveal: true }), activated };
}

/**
 * Type text into whatever window is frontmost and press Return — the same
 * trick a human uses, simulated. Deliberately not app-specific: `keystroke`
 * goes to whichever window macOS considers key, so this works identically
 * whether the session lives in Terminal, iTerm, or an editor's integrated
 * terminal, without a separate script per app.
 *
 * Call `revealWindow(target)` first — this only sends keys, it does not
 * raise anything, so typing into a window that isn't actually frontmost yet
 * would go wherever focus already was.
 */
function typeScript(text) {
  // A CLI prompt submits on Return, so a newline typed mid-string would send
  // early and cut the rest off — one line is what a keystroke can honestly do.
  const oneLine = String(text).replace(/\s*\n+\s*/g, ' ').trim();
  return `tell application "System Events"
  keystroke ${q(oneLine)}
  key code 36
end tell`;
}

/** Type `text` into the frontmost window and submit it. */
async function typeAndSubmit(text) {
  await run('/usr/bin/osascript', ['-e', typeScript(text)]);
}

/** Where is that window right now? */
async function windowBounds(target) {
  return runWindowScript(target, { reveal: false });
}

// macOS's System Events helper occasionally wedges: it still answers, but
// reports *every* app as having zero windows. Quitting it (it relaunches on
// demand) clears that, so one empty answer is worth a single retry — rate
// limited, because restarting it on every poll would be its own bug.
const HELPER_RESET_EVERY_MS = 60 * 1000;
let lastHelperReset = 0;

async function resetWindowHelper() {
  lastHelperReset = Date.now();
  try {
    await run('/usr/bin/killall', ['System Events'], { timeout: 2000 });
  } catch {
    // not running / already gone — it comes back by itself either way
  }
  await new Promise((r) => setTimeout(r, 400));
}

async function runWindowScript(target, opts) {
  const script = windowScript(target, opts);
  if (!script) return null;

  const bounds = parseBounds(await run('/usr/bin/osascript', ['-e', script]));
  if (bounds) return bounds;
  if (Date.now() - lastHelperReset < HELPER_RESET_EVERY_MS) return null;

  await resetWindowHelper();
  return parseBounds(await run('/usr/bin/osascript', ['-e', script]));
}

module.exports = {
  terminalFromHeaders,
  parseProcessTable,
  appNameFromComm,
  findAppAncestor,
  ancestorsOf,
  windowScript,
  parseBounds,
  dockPosition,
  promptPosition,
  resolveTarget,
  revealWindow,
  windowBounds,
  typeScript,
  typeAndSubmit,
  appForPid,
  bundleIdFor,
  TERMINAL_APP,
  ITERM_APP,
};
