'use strict';

/**
 * Starting — and talking to — an agent session that Clippy owns.
 *
 * Watch mode finds the terminal a session already lives in and types into it
 * with AppleScript (see terminal.js). That needs an Accessibility grant, a
 * visible window, and a lot of luck about which window is frontmost. When
 * Clippy starts the agent itself there is a better option: put it in a tmux
 * session, which is a real control surface. Prompts go in with `paste-buffer`,
 * the pane can be attached from any terminal, and the session outlives both the
 * agent and Clippy.
 *
 * Everything here is a pure string/argv transform except `run()` and the thin
 * async wrappers at the bottom, so the fiddly parts — quoting, the launch line,
 * the parsers — are testable without tmux in the loop.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');

const TMUX_TIMEOUT_MS = 5000;

// A detached session is 80x24 unless told otherwise, and the agent's TUI will
// render (and capture-pane will read back) at that width until someone
// attaches. Wide enough that nothing wraps into nonsense.
const DETACHED_SIZE = { width: 200, height: 50 };

/** The agents Clippy knows how to start. */
const SPAWNABLE = {
  claude: { bin: 'claude', label: 'Claude Code' },
  codex: { bin: 'codex', label: 'Codex' },
};

/**
 * POSIX single-quoting: the only safe way to put a path, a host or a prompt
 * into a shell line. Everything inside '…' is literal, and the '\'' dance is
 * how you get a quote past the quoting.
 */
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * A CLI prompt submits on Return, so a newline sent as a keystroke would send
 * early and cut the rest off. Same bargain terminal.js's typeScript makes —
 * and only ever the fallback, since paste-buffer handles newlines properly.
 */
const oneLine = (s) => String(s).replace(/\s*\n+\s*/g, ' ').trim();

/**
 * tmux's own parser reads a trailing ';' as the end of one command in a
 * sequence, so a prompt ending in "run make;" would silently lose its last
 * character. Only matters on the send-keys fallback path.
 */
const escapeSemicolon = (s) => (String(s).endsWith(';') ? `${String(s).slice(0, -1)}\\;` : String(s));

/**
 * A directory on another machine, as a shell word.
 *
 * Quoting is what keeps a path with a space or a quote in it from turning into
 * shell syntax — but quoting a leading `~` also stops it expanding, and `~` is
 * exactly what people type for a path over there. So the tilde becomes $HOME
 * and only the rest is quoted.
 */
/**
 * The ssh options that make a connection reusable.
 *
 * Defined here because both users need to agree on them: the pane's own ssh
 * opens the master connection, and the transcript probe rides it. Sharing the
 * ControlPath is what turns each poll from a handshake-and-authenticate into a
 * few milliseconds down a socket that is already open.
 */
function sshControlArgs(controlPath, { connectTimeout = 5 } = {}) {
  if (!controlPath) return [];
  return [
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${controlPath}`,
    '-o',
    'ControlPersist=120',
    '-o',
    `ConnectTimeout=${connectTimeout}`,
  ];
}

function remoteDir(p) {
  const raw = String(p || '').trim();
  if (!raw || raw === '~') return '"$HOME"';
  if (raw.startsWith('~/')) return `"$HOME"/${shQuote(raw.slice(2))}`;
  return shQuote(raw);
}

/** `-t =name` is an exact match. Without the '=', `clippy-app` also hits `clippy-app-2`. */
const exact = (name) => `=${name}`;

/**
 * A tmux session name Clippy owns: `clippy-<project>-<suffix>`.
 *
 * tmux does not reject a bad name — `session_check_name` silently rewrites ':'
 * and '.' to '_', leaving us holding a name tmux never stored. So the name is
 * sanitized here, down to characters nothing downstream argues about.
 */
function sessionName(label, { seq = 0, now = Date.now() } = {}) {
  const slug =
    String(label || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'agent';
  return `clippy-${slug}-${(now % 46656).toString(36)}${seq ? seq.toString(36) : ''}`;
}

const isValidSessionName = (name) => /^[A-Za-z0-9_-]{1,60}$/.test(String(name));

/** The user's shell, sanity-checked. It is both the pane's shell and our PATH oracle. */
function loginShell(env = process.env) {
  const shell = env && typeof env.SHELL === 'string' ? env.SHELL.trim() : '';
  return shell.startsWith('/') && !/\s/.test(shell) ? shell : '/bin/zsh';
}

/**
 * The single shell command handed to `tmux new-session`.
 *
 * Two things are load-bearing:
 *
 * The `-ilc` wrapper. tmux runs a shell-command through its default shell with
 * `-c`, which reads no rc files — and the tmux server inherited *Clippy's*
 * environment, which for a Finder-launched Electron app is a bare
 * /usr/bin:/bin:/usr/sbin:/sbin. `claude` lives in ~/.local/bin, a brew prefix,
 * or an nvm shim, none of which are on it. An interactive login shell resolves
 * the agent exactly the way the user's own terminal does, which is the only
 * definition of "where claude comes from" that cannot drift — it survives nvm,
 * mise, asdf, and a `claude` that is really a shell function.
 *
 * The trailing `exec <shell> -il`. The pane outlives the agent: sessions are
 * meant to persist, so quitting the agent drops you to a shell in the same tmux
 * session instead of destroying it. The pane pid is unchanged by that exec,
 * which is what lets a re-run agent be recognised again.
 */
function launchCommand({
  agent = 'claude',
  cwd = '',
  sessionId = '',
  host = '',
  remotePath = '',
  prompt = '',
  controlPath = '',
  shell = loginShell(),
} = {}) {
  const bin = (SPAWNABLE[agent] || SPAWNABLE.claude).bin;
  // Only Claude can be told which session id to use; that makes its transcript
  // path deterministic and its buddy key right from the first moment.
  const flags = agent === 'claude' && sessionId ? ` --session-id ${shQuote(sessionId)}` : '';
  const args = prompt ? ` ${shQuote(prompt)}` : '';

  // "$SHELL" is left unexpanded on purpose — it is the *remote* user's shell,
  // resolved on the far side for the same PATH reason as the local one.
  const start = host
    ? `ssh -t ${sshControlArgs(controlPath).map(shQuote).join(' ')}${controlPath ? ' ' : ''}${shQuote(host)} ${shQuote(
        `exec "$SHELL" -ilc ${shQuote(`cd ${remoteDir(remotePath)} && exec ${bin}${flags}${args}`)}`
      )}`
    : `${bin}${flags}${args}`;

  return `exec ${shQuote(shell)} -ilc ${shQuote(`${start}; exec ${shQuote(shell)} -il`)}`;
}

/* ------------------------------- argv builders ------------------------------ */

/**
 * `-P -F` reports the pane id and pane pid from the same call that creates the
 * session: the id is immune to window renumbering, and the pid is the whole
 * story for recognising which hook belongs to which pane.
 */
function newSessionArgs({
  name,
  cwd,
  command,
  width = DETACHED_SIZE.width,
  height = DETACHED_SIZE.height,
}) {
  return [
    'new-session',
    '-d',
    '-s',
    String(name),
    '-c',
    String(cwd),
    '-x',
    String(width),
    '-y',
    String(height),
    '-P',
    '-F',
    '#{pane_id} #{pane_pid}',
    String(command),
  ];
}

const hasSessionArgs = (name) => ['has-session', '-t', exact(name)];
const listSessionsArgs = () => ['list-sessions', '-F', '#{session_name}'];
const listPanesArgs = (name) => ['list-panes', '-t', exact(name), '-F', '#{pane_id} #{pane_pid}'];
const killSessionArgs = (name) => ['kill-session', '-t', exact(name)];

/** What is actually running in the pane — the only honest "is the agent still there". */
const paneInfoArgs = (target) => [
  'display-message',
  '-p',
  '-t',
  String(target),
  '#{pane_current_command}\t#{pane_dead}',
];

const capturePaneArgs = (target, { lines = 200 } = {}) => [
  'capture-pane',
  '-p',
  '-J',
  '-S',
  `-${lines}`,
  '-t',
  String(target),
];

/** `load-buffer -` reads from stdin, so the prompt never reaches tmux's parser. */
const loadBufferArgs = (buffer) => ['load-buffer', '-b', String(buffer), '-'];
const pasteBufferArgs = (target, buffer) => [
  'paste-buffer',
  '-d',
  '-p',
  '-b',
  String(buffer),
  '-t',
  String(target),
];
const sendKeysArgs = (target, ...keys) => ['send-keys', '-t', String(target), ...keys.map(String)];
const sendKeysLiteralArgs = (target, text) => [
  'send-keys',
  '-t',
  String(target),
  '-l',
  '--',
  escapeSemicolon(text),
];

/** What the user's terminal has to run. Quoted: zsh EQUALS-expands a bare `=name`. */
const attachCommand = (bin, name) => `${shQuote(bin)} attach -t ${shQuote(exact(name))}`;

/* --------------------------------- parsers --------------------------------- */

/** `'%12 34567\n'` -> `{ paneId: '%12', panePid: 34567 }` */
function parseNewSession(stdout = '') {
  const m = String(stdout).trim().match(/^(%\d+)\s+(\d+)$/m);
  return m ? { paneId: m[1], panePid: Number(m[2]) } : null;
}

const parseSessionList = (stdout = '') =>
  String(stdout)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

function parsePaneList(stdout = '') {
  const panes = [];
  for (const line of String(stdout).split('\n')) {
    const m = line.trim().match(/^(%\d+)\s+(\d+)$/);
    if (m) panes.push({ paneId: m[1], panePid: Number(m[2]) });
  }
  return panes;
}

/** `'claude\t0'` -> `{ command: 'claude', dead: false }` */
function parsePaneInfo(stdout = '') {
  const [command, dead] = String(stdout).trim().split('\t');
  if (!command) return null;
  return { command: command.trim(), dead: String(dead).trim() === '1' };
}

/* ---------------------------- the impure remainder --------------------------- */

// Where tmux actually is. Clippy execs it directly, so unlike the agent binary
// this one we do have to resolve — and Clippy's own PATH cannot be trusted.
const TMUX_CANDIDATES = [
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  '/opt/local/bin/tmux',
];

const tmuxCandidates = (env = process.env) =>
  [env && env.CLIPPY_TMUX_BIN, ...TMUX_CANDIDATES].filter(Boolean);

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{input?: string, timeout?: number}} [options] `input` is written to
 *   stdin, which is how `load-buffer -` gets a prompt without quoting it.
 */
function run(bin, args, { input = null, timeout = TMUX_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
    if (input === null) return;
    child.stdin.on('error', () => {}); // the child can exit before we finish writing
    child.stdin.end(input);
  });
}

let tmuxBin = null;

/** The tmux binary, resolved once. Rejects if there isn't one. */
async function findTmux(env = process.env) {
  if (tmuxBin) return tmuxBin;
  for (const candidate of tmuxCandidates(env)) {
    if (fs.existsSync(candidate)) return (tmuxBin = candidate);
  }
  // Nothing where it usually lives: ask the user's own shell, which is the same
  // question the pane command answers for the agent binary.
  const found = (await run(loginShell(env), ['-lc', 'command -v tmux'], { timeout: 4000 }).catch(
    () => ''
  ))
    .trim()
    .split('\n')[0];
  if (!found) throw new Error('tmux not found');
  return (tmuxBin = found);
}

const newSession = async (bin, options) => parseNewSession(await run(bin, newSessionArgs(options)));
const listSessions = async (bin) => parseSessionList(await run(bin, listSessionsArgs()));
const listPanes = async (bin, name) => parsePaneList(await run(bin, listPanesArgs(name)));
const paneInfo = async (bin, target) => parsePaneInfo(await run(bin, paneInfoArgs(target)));
const capturePane = (bin, target, options) => run(bin, capturePaneArgs(target, options));
const killSession = (bin, name) => run(bin, killSessionArgs(name));

async function hasSession(bin, name) {
  try {
    await run(bin, hasSessionArgs(name));
    return true;
  } catch {
    return false; // tmux exits non-zero for "no such session"
  }
}

/**
 * Programs that read a line at a time, where a newline means "submit now".
 *
 * A denial list rather than an allow list, because an agent's process name is
 * not something we can predict: Claude Code renames itself to its own version
 * number (`pane_current_command` reads `2.1.227`), and an agent installed
 * through a shim shows up as whatever the shim is. What we *can* recognise is
 * the handful of line-oriented programs a pane falls back to — the shell it
 * drops to when the agent exits, and the pagers an agent might open.
 */
const LINE_ORIENTED = new Set([
  'zsh', 'bash', 'sh', 'fish', 'dash', 'tcsh', 'csh', 'ksh',
  'less', 'more', 'man', 'cat', 'head', 'tail', 'vi',
]);

/**
 * Must this prompt be flattened onto one line before it is sent?
 *
 * Only when the pane is running something known to submit on newline. An
 * unrecognised command is assumed to be a TUI, which is the normal case for an
 * agent and the case where multi-line prompts matter most.
 */
const needsFlattening = (paneCommand, text) =>
  String(text).includes('\n') && LINE_ORIENTED.has(String(paneCommand));
// Let the TUI finish inserting the paste before Return lands on it.
const PASTE_SETTLE_MS = 120;

let bufferSeq = 0;

/**
 * Type a prompt into a pane and submit it.
 *
 * `load-buffer` + `paste-buffer -p` rather than `send-keys -l`, for three
 * reasons in order of how much they hurt: `send-keys -l` sends a literal LF,
 * which every TUI reads as Return, so a multi-line prompt submits after its
 * first line and the rest lands in the next turn; `load-buffer -` takes the
 * text on stdin, so tmux's command parser never sees it at all; and Return is
 * a separate call, which makes submitting a decision rather than a side effect
 * of the text.
 *
 * `paste-buffer -p` only brackets the payload if the program asked for
 * bracketed paste, and tmux exposes no format to ask whether it did — so a
 * pane sitting at a shell would take the newlines literally and submit early.
 * Hence LINE_ORIENTED: those panes get one line instead. The worst case is a
 * prompt flattened onto a single line, never a half-submitted one.
 */
async function sendPrompt(bin, target, text) {
  const prompt = String(text || '');
  if (!prompt.trim()) return false;

  const info = await paneInfo(bin, target).catch(() => null);
  const body = needsFlattening(info && info.command, prompt) ? oneLine(prompt) : prompt;
  const buffer = `clippy-${(bufferSeq = (bufferSeq + 1) % 1000)}`;

  try {
    await run(bin, loadBufferArgs(buffer), { input: body });
    await run(bin, pasteBufferArgs(target, buffer));
  } catch {
    // An old tmux, or a buffer that would not load: one line is better than none.
    await run(bin, sendKeysLiteralArgs(target, oneLine(body)));
  }
  await new Promise((r) => setTimeout(r, PASTE_SETTLE_MS));
  await run(bin, sendKeysArgs(target, 'Enter'));
  return true;
}

module.exports = {
  // pure
  shQuote,
  oneLine,
  escapeSemicolon,
  remoteDir,
  sshControlArgs,
  needsFlattening,
  LINE_ORIENTED,
  sessionName,
  isValidSessionName,
  loginShell,
  launchCommand,
  newSessionArgs,
  hasSessionArgs,
  listSessionsArgs,
  listPanesArgs,
  killSessionArgs,
  paneInfoArgs,
  capturePaneArgs,
  loadBufferArgs,
  pasteBufferArgs,
  sendKeysArgs,
  sendKeysLiteralArgs,
  attachCommand,
  parseNewSession,
  parseSessionList,
  parsePaneList,
  parsePaneInfo,
  tmuxCandidates,
  SPAWNABLE,
  DETACHED_SIZE,
  // impure
  run,
  findTmux,
  newSession,
  hasSession,
  listSessions,
  listPanes,
  paneInfo,
  capturePane,
  killSession,
  sendPrompt,
};
