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
    if (name) return { pid: current, name };
    current = entry.ppid;
  }
  return null;
}

/** AppleScript string literal (the only characters that matter are " and \). */
const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

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

/** The terminal emulator app that owns `pid`, via the live process table. */
async function appForPid(pid) {
  if (!pid) return null;
  try {
    const table = parseProcessTable(await run('/bin/ps', ['-Ao', 'pid=,ppid=,comm=']));
    return findAppAncestor(pid, table);
  } catch {
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

/** Raise a session's terminal window. Resolves with its bounds, or null. */
async function revealWindow(target) {
  return runWindowScript(target, { reveal: true });
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
  windowScript,
  parseBounds,
  dockPosition,
  promptPosition,
  resolveTarget,
  revealWindow,
  windowBounds,
  typeScript,
  typeAndSubmit,
  TERMINAL_APP,
  ITERM_APP,
};
