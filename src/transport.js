'use strict';

/**
 * Reading a transcript that lives on another machine.
 *
 * When the project is on an SSH host, the tmux session is still local — it runs
 * `ssh -t host …` — so typing at the agent and attaching a terminal both work
 * exactly as they do for a local session. What is *not* local is the JSONL file
 * the agent writes, and that is the only place its words are.
 *
 * Four ssh round trips per poll would be absurd, so a poll is one command:
 * resolve the transcript, stat it, and dump whatever arrived since our last
 * offset, framed so the local side can split it apart again.
 *
 *     #clippy path=… size=… mtime=… ino=…
 *     <raw JSONL bytes from offset to EOF>
 *
 * Nothing is assumed about the far side beyond a POSIX shell: `tail -c +N` is
 * the portable byte-range read (`dd bs=1` would be pathological), and `stat`
 * is tried in both its BSD and GNU spellings.
 */

const { execFile } = require('node:child_process');
const path = require('node:path');
const { shQuote, remoteDir, sshControlArgs } = require('./tmux');

const PROBE_TIMEOUT_MS = 20_000;
// One poll should never hand back more than this; the reader resyncs instead.
const MAX_DELTA = 2 * 1024 * 1024;

/**
 * Multiplexing is not optional. Without it every poll pays a full handshake —
 * and, worse, a re-authentication. With it the first connection sets up a
 * socket the tmux session's own ssh is already holding open, and each poll is
 * a few milliseconds down that same channel.
 *
 * BatchMode so a host that wants a passphrase fails fast rather than hanging
 * on a prompt nobody can see: there is no terminal attached to this ssh.
 */
function sshArgs(host, { controlPath, connectTimeout = 5 } = {}) {
  // BatchMode is ours alone: the pane's ssh has a terminal and may legitimately
  // prompt, while this one has nobody to answer.
  //
  // `--` because a host is not a trusted word: it is typed into the New agent
  // box and then kept in a settings file. Handing ssh `-oProxyCommand=…` as the
  // host would otherwise be read as a flag rather than a machine to reach, and
  // ProxyCommand runs a command. After `--` it can only be a hostname.
  return ['-o', 'BatchMode=yes', ...sshControlArgs(controlPath, { connectTimeout }), '--', host];
}

/**
 * Where the multiplexing socket lives — shared with the session's own ssh.
 *
 * It has to be *short*. A unix domain socket path is capped at around 104
 * bytes, and ssh refuses to connect at all past that ("ControlPath too long").
 * The app's own userData directory is nowhere near short enough once a
 * username and a hostname are appended to it, so the socket goes under /tmp
 * instead, in a directory only this user can open. `%C` is ssh's own hash of
 * the connection details: fixed length, whatever the host is called.
 */
const controlDir = () => `/tmp/clippy-ssh-${typeof process.getuid === 'function' ? process.getuid() : 0}`;
const controlPathFor = () => path.join(controlDir(), '%C');

/**
 * Make the socket directory, private to this user.
 *
 * 0700 is the point: /tmp is world-writable, and a control socket somewhere
 * anyone can reach is somewhere anyone can reach *the session*. If the
 * directory already exists as something else, ssh fails to connect — which is
 * the right outcome, and better than multiplexing through it.
 */
function ensureControlDir(mkdir) {
  const dir = controlDir();
  try {
    mkdir(dir, { recursive: true, mode: 0o700 });
  } catch {
    // Already there, or unwritable: ssh will say so far more precisely.
  }
  return dir;
}

/**
 * The `cwd.replace(/[/._]/g, '-')` that names a Claude project directory,
 * done in shell. `tr` maps each character of the first set to the second.
 */
const ENCODE_CWD = `tr './_' '---'`;

/**
 * One command that answers a whole poll.
 *
 * Claude is a straight lookup: we chose the session id, so once the remote cwd
 * is resolved (with `pwd -P`, because the agent records the path with symlinks
 * resolved) the transcript's name is known.
 *
 * Codex has to be searched for — its rollouts record their cwd on line one and
 * nowhere else — so `ls -t` orders every rollout by recency and the loop reads
 * only first lines, bounded to the newest handful.
 *
 * Every field the local side needs is in the header, printed *before* the
 * bytes: a trailer would be appended straight onto the last line whenever the
 * transcript has no final newline, which is most of the time.
 */
// Session ids are uuids. Anything else is not one, and must not reach a shell:
// this sits inside a double-quoted string, where shQuote's quotes would be
// literal characters rather than quoting.
const safeId = (id) => String(id || '').replace(/[^A-Za-z0-9._-]/g, '');

function remoteProbeScript({ agent = 'claude', cwd = '', sessionId = '', offset = 0 } = {}) {
  const start = Math.max(0, Number(offset) || 0);

  const find =
    agent === 'codex'
      ? `f=
for p in $(ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -40); do
  head -c 65536 "$p" | head -1 | grep -qF "\"cwd\":\"$cwd\"" && { f="$p"; break; }
done`
      : `enc=$(printf %s "$cwd" | ${ENCODE_CWD})
f="$HOME/.claude/projects/$enc/${safeId(sessionId)}.jsonl"
[ -f "$f" ] || f=`;

  return `cwd=$(cd ${remoteDir(cwd)} 2>/dev/null && pwd -P) || { echo '#clippy none'; exit 0; }
${find}
[ -n "$f" ] || { echo '#clippy none'; exit 0; }
set -- $(stat -f '%z %m %i' "$f" 2>/dev/null || stat -c '%s %Y %i' "$f" 2>/dev/null)
[ -n "$1" ] || { echo '#clippy none'; exit 0; }
start=${start}
[ "$1" -lt "$start" ] && start=0
[ $(( $1 - start )) -gt ${MAX_DELTA} ] && start=$(( $1 - ${MAX_DELTA} ))
echo "#clippy path=$f size=$1 mtime=$2 ino=$3 from=$start"
[ "$1" -gt "$start" ] && tail -c +$(( start + 1 )) "$f" || true`;
}

/**
 * Split the framed answer back into a header and the raw bytes.
 * @returns {{path, size, mtimeMs, ino, from, bytes: Buffer}|null}
 */
function parseProbe(stdout) {
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || ''));
  const firstBreak = buffer.indexOf(0x0a);
  if (firstBreak === -1) return null;
  const header = buffer.subarray(0, firstBreak).toString('utf8');
  if (!header.startsWith('#clippy ')) return null;
  if (header.startsWith('#clippy none')) return null;

  const field = (name) => {
    const m = header.match(new RegExp(`\\b${name}=(\\S+)`));
    return m ? m[1] : '';
  };
  // An absent field reads as '' and Number('') is 0, which is a perfectly
  // plausible size — so the header has to actually carry one.
  const rawSize = field('size');
  const size = Number(rawSize);
  if (!rawSize || !Number.isFinite(size) || size < 0) return null;

  return {
    path: field('path'),
    size,
    mtimeMs: (Number(field('mtime')) || 0) * 1000,
    ino: Number(field('ino')) || 0,
    // Where the body actually starts, which is not the offset we asked for
    // whenever the far side had to skip a gap.
    from: Number(field('from')) || 0,
    bytes: buffer.subarray(firstBreak + 1),
  };
}

/** Complete lines out of a delta, dropping a trailing partial one. */
function linesOf(bytes) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue;
    if (i > start) lines.push(bytes.subarray(start, i));
    start = i + 1;
  }
  return { lines, rest: bytes.length - start };
}

const defaultExec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/**
 * A reader with the same shape as transcript.js's `createReader`, but backed by
 * one ssh command per poll instead of a local file handle.
 */
function createRemoteReader({
  host,
  agent = 'claude',
  cwd = '',
  sessionId = '',
  controlPath,
  exec = defaultExec,
  turnsFrom,
  clip = (turn) => turn,
}) {
  let offset = 0;
  let size = 0;
  let mtimeMs = 0;
  let ino = 0;
  let cold = true;

  return {
    async poll() {
      // What we asked for, kept because `offset` moves on below and the far
      // side's answer has to be compared against the question.
      const asked = offset;
      const script = remoteProbeScript({ agent, cwd, sessionId, offset });
      const stdout = await exec('/usr/bin/ssh', [...sshArgs(host, { controlPath }), script], {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'buffer',
      });

      const probe = parseProbe(stdout);
      if (!probe) return { turns: [], changed: false, gone: true };

      // Truncated or replaced on the far side: what we knew about it is void.
      if (probe.size < offset || (ino && probe.ino && probe.ino !== ino)) {
        offset = 0;
        cold = true;
      }
      ino = probe.ino || ino;

      if (probe.size === size && probe.mtimeMs === mtimeMs) return { turns: [], changed: false };
      size = probe.size;
      mtimeMs = probe.mtimeMs;

      const { lines, rest } = linesOf(probe.bytes);
      // A partial trailing line is not consumed: next poll asks from its start.
      offset = probe.size - rest;

      // The far side skips ahead when we have fallen a long way behind. Only
      // then is the first line a fragment of one, and only then is it dropped.
      const skipped = probe.from > asked;
      const usable = skipped && lines.length ? lines.slice(1) : lines;
      const wasCold = cold;
      cold = false;
      return {
        turns: turnsFrom(usable, { agent }).map(clip),
        changed: true,
        ...(wasCold ? { cold: true } : {}),
      };
    },
    get offset() {
      return offset;
    },
    host,
    agent,
  };
}

module.exports = {
  sshArgs,
  controlDir,
  ensureControlDir,
  safeId,
  controlPathFor,
  remoteProbeScript,
  parseProbe,
  linesOf,
  createRemoteReader,
  MAX_DELTA,
};
