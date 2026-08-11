'use strict';

/**
 * What the agent actually said, read out of the transcript it writes anyway.
 *
 * Hooks tell Clippy that something happened; they carry almost none of the
 * words. The words are in the JSONL file every agent keeps — and for a session
 * Clippy spawned there may be no hooks at all for minutes (there is no
 * SessionStart hook, and an agent over ssh reports to its own machine), so this
 * is the only channel that always works.
 *
 * Two formats, one shape. Everything here normalizes to a `Turn`:
 *
 *   { role: 'user' | 'assistant',
 *     kind: 'prompt' | 'say' | 'final' | 'tool' | 'notice',
 *     text, at, id, tools[] }
 *
 * so nothing downstream has to know whose transcript it came from.
 *
 * File access goes through an `io` object rather than `fs` directly. Locally
 * that is a thin wrapper; over ssh it is a different implementation of the same
 * five calls, which is the whole reason the seam exists.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const { readBackward, readForward, parseLine, EMPTY } = require('./jsonl');

// Prose is never megabytes. A line that big is a tool result, and assembling it
// would defeat the point of never materializing a transcript.
const MAX_LINE_BYTES = 1024 * 1024;
// How far behind we let a reader fall before skipping ahead instead of catching
// up line by line — a slept machine or one enormous tool result.
const MAX_CATCHUP = 2 * 1024 * 1024;
// Lines scanned when cold-starting. Generous: one assistant turn can be five
// lines, and tool traffic sits between the turns worth showing.
const TAIL_LINES = 400;

const DAY_MS = 24 * 60 * 60 * 1000;
// Codex rollouts have no cwd index, so resolution reads the first line of
// candidate files. Bounded, and the answer is cached forever after.
const MAX_HEADS = 24;

/** Injected user turns that are machinery, not something a person typed. */
const INJECTED = /^\s*<(local-command-caveat|command-name|command-message|command-args|system-reminder|environment_context|user-prompt-submit-hook)/;

/* --------------------------------- the io seam -------------------------------- */

const localIo = {
  async stat(file) {
    try {
      const s = await fsp.stat(file);
      return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino };
    } catch {
      return null;
    }
  },
  async list(dir) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push({ name: entry.name, path: full, isDir: true, mtimeMs: 0 });
        continue;
      }
      const s = await fsp.stat(full).catch(() => null);
      if (s) out.push({ name: entry.name, path: full, isDir: false, mtimeMs: s.mtimeMs });
    }
    return out;
  },
  async readHead(file, bytes) {
    let handle;
    try {
      handle = await fsp.open(file, 'r');
      const buffer = Buffer.allocUnsafe(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } catch {
      return EMPTY;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  },
  readBackward,
  readForward,
};

/* -------------------------------- resolution -------------------------------- */

/**
 * `/Users/me/pro.ject` -> `-Users-me-pro-ject`, the way Claude Code names the
 * directory it keeps a project's sessions in.
 *
 * Lossy: '/a/b.c' and '/a/b/c' both encode to '-a-b-c'. Encoding forward (to
 * find a directory) is safe; reversing it is not, so nothing here does — the
 * `cwd` recorded inside the file is the authority when it matters.
 */
const encodeProjectDir = (cwd) => String(cwd).replace(/[/._]/g, '-');

/** Where Claude Code will write a session we named ourselves. */
const claudeTranscriptPath = (projectsDir, cwd, sessionId) =>
  path.join(projectsDir, encodeProjectDir(cwd), `${sessionId}.jsonl`);

/** Two paths pointing at the same directory, give or take a trailing slash. */
const sameDir = (a, b) =>
  String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');

/** `2026/08/10` for every day the window touches, newest first. */
function dayDirsBetween(fromMs, toMs) {
  const days = [];
  const start = Math.min(fromMs, toMs);
  for (let at = toMs; at >= start - DAY_MS; at -= DAY_MS) {
    const d = new Date(at);
    days.push(
      path.join(
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, '0'),
        String(d.getDate()).padStart(2, '0')
      )
    );
    if (days.length > 8) break;
  }
  return days;
}

/**
 * Codex records the working directory in `session_meta`, on line 1, and nowhere
 * else — there is no per-project directory and no cwd index. So resolution
 * reads first lines. It stays cheap because line 1 never changes (the answer is
 * cached forever), because only the day directories the window touches are
 * walked, and because a session Clippy spawned has a `sinceMs` of "just now".
 */
async function findCodexRollout({ cwd, sessionsRoot, sinceMs = 0, io = localIo, cache = new Map() }) {
  const files = [];
  for (const day of dayDirsBetween(sinceMs || Date.now() - DAY_MS, Date.now())) {
    for (const entry of await io.list(path.join(sessionsRoot, day))) {
      if (entry.isDir || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
      // The timestamp in the filename is local time and lies about ordering
      // across a DST boundary. mtime does not.
      if (entry.mtimeMs >= sinceMs) files.push(entry);
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of files.slice(0, MAX_HEADS)) {
    let meta = cache.get(file.path);
    if (!meta) {
      const head = await io.readHead(file.path, 64 * 1024);
      const end = head.indexOf(0x0a);
      const first = parseLine(end === -1 ? head : head.subarray(0, end));
      meta = first && first.type === 'session_meta' && first.payload ? first.payload : { bad: true };
      cache.set(file.path, meta);
    }
    if (meta.bad) continue;
    // A missing thread_source means a top-level session; only an explicit
    // 'subagent' is one of Codex's own helpers.
    if (meta.thread_source === 'subagent') continue;
    if (!sameDir(meta.cwd, cwd)) continue;
    return {
      agent: 'codex',
      sessionId: meta.session_id || meta.id || '',
      path: file.path,
      cwd: meta.cwd,
      source: 'meta',
    };
  }
  return null;
}

/**
 * Where is this session's transcript?
 *
 * Claude is a stat: we minted the session id at spawn, so the path is
 * determined. Codex has to be searched for.
 */
async function resolveSession({
  agent = 'claude',
  cwd,
  sessionId = '',
  roots = {},
  sinceMs = 0,
  io = localIo,
  cache,
}) {
  if (agent === 'codex') {
    if (!roots.codexSessions) return null;
    return findCodexRollout({ cwd, sessionsRoot: roots.codexSessions, sinceMs, io, cache });
  }
  if (!sessionId || !roots.claudeProjects) return null;
  const file = claudeTranscriptPath(roots.claudeProjects, cwd, sessionId);
  // Until the agent writes its first line the file does not exist yet, which is
  // not an error — it is the first minute of every spawned session.
  return (await io.stat(file)) ? { agent: 'claude', sessionId, path: file, cwd, source: 'minted' } : null;
}

/* ------------------------------- normalization ------------------------------ */

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n');
};

/**
 * Claude Code splits one API response across several JSONL lines that share a
 * `message.id` — the text block on one line, each tool_use on another. Grouping
 * by that id is the difference between one turn and five.
 */
function claudeTurns(entries, { includeNotices }) {
  const byId = new Map();
  const out = [];

  for (const entry of entries) {
    // Most lines in a transcript are neither: `mode`, `ai-title`, `last-prompt`,
    // `pr-link`, `file-history-delta`, `bridge-session`, `attachment`… none of
    // which have a `.message`, a `.timestamp` or a `.cwd`.
    if (!entry || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
    if (entry.isSidechain) continue; // a subagent, not this session
    const message = entry.message;
    if (!message) continue;
    const at = Date.parse(entry.timestamp) || 0;

    if (entry.type === 'user') {
      const text = textOf(message.content).trim();
      if (!text) continue; // a bare tool_result carries no words
      const injected =
        entry.isMeta === true ||
        INJECTED.test(text) ||
        (entry.promptSource && entry.promptSource !== 'typed');
      if (injected && !includeNotices) continue;
      out.push({
        role: 'user',
        kind: injected ? 'notice' : 'prompt',
        text,
        at,
        id: entry.uuid || `u:${out.length}`,
        tools: [],
      });
      continue;
    }

    const id = message.id || entry.uuid || `a:${out.length}`;
    let turn = byId.get(id);
    if (!turn) {
      turn = { role: 'assistant', kind: 'say', text: '', at, id, tools: [] };
      byId.set(id, turn);
      out.push(turn);
    }
    turn.at = Math.max(turn.at, at);
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block && block.type === 'text' && block.text) {
        turn.text += (turn.text ? '\n' : '') + block.text;
      } else if (block && block.type === 'tool_use' && block.name) {
        turn.tools.push(block.name);
      }
      // `thinking` blocks are deliberately dropped: not for a speech bubble.
    }
  }

  for (const turn of out) {
    if (turn.role === 'assistant') {
      turn.text = turn.text.trim();
      if (!turn.text) turn.kind = 'tool';
    }
  }
  return out;
}

/**
 * Codex writes everything twice: `response_item` is the raw model-facing
 * transcript (whose user turns are padded with injected environment blocks),
 * and `event_msg` is the friendly version. Only the friendly one is read.
 *
 * `task_complete` carries the finished answer, but it is not guaranteed — the
 * newest Codex builds omit it entirely. So `agent_message` is load-bearing and
 * `task_complete` is the upgrade when it shows up.
 */
function codexTurns(entries) {
  const out = [];
  for (const entry of entries) {
    if (!entry || entry.type !== 'event_msg' || !entry.payload) continue;
    const payload = entry.payload;
    const at = Date.parse(entry.timestamp) || 0;

    if (payload.type === 'user_message' && typeof payload.message === 'string') {
      const text = payload.message.trim();
      if (!text || INJECTED.test(text)) continue;
      out.push({ role: 'user', kind: 'prompt', text, at, id: `u:${out.length}`, tools: [] });
      continue;
    }
    if (payload.type === 'agent_message' && typeof payload.message === 'string') {
      const text = payload.message.trim();
      if (text) out.push({ role: 'assistant', kind: 'say', text, at, id: `a:${out.length}`, tools: [] });
      continue;
    }
    if (payload.type === 'task_complete' && typeof payload.last_agent_message === 'string') {
      const text = payload.last_agent_message.trim();
      if (!text) continue;
      const previous = out[out.length - 1];
      // The finished answer usually repeats the last thing it streamed. Replace
      // rather than append, or every turn shows its answer twice.
      if (previous && previous.role === 'assistant' && previous.text === text) {
        previous.kind = 'final';
        previous.at = at || previous.at;
        continue;
      }
      out.push({ role: 'assistant', kind: 'final', text, at, id: `f:${out.length}`, tools: [] });
    }
  }
  return out;
}

/**
 * Buffers of JSONL, oldest first, into turns.
 * @param {Buffer[]} lines
 */
function turnsFrom(lines, { agent = 'claude', includeNotices = false } = {}) {
  const entries = [];
  for (const line of lines) {
    const entry = parseLine(line);
    if (entry) entries.push(entry);
  }
  return agent === 'codex' ? codexTurns(entries) : claudeTurns(entries, { includeNotices });
}

const clipTurn = (turn, maxChars) =>
  turn.text.length > maxChars ? { ...turn, text: `${turn.text.slice(0, maxChars).trim()}…` } : turn;

/** The last thing the agent actually said — what belongs in a speech bubble. */
function lastSaid(turns) {
  for (let i = (turns || []).length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role === 'assistant' && (turn.kind === 'say' || turn.kind === 'final')) return turn.text;
  }
  return '';
}

/** A cold start: the last `limit` turns of a transcript, oldest first. */
async function readTail(
  file,
  { agent = 'claude', limit = 8, maxChars = 4000, maxLines = TAIL_LINES, io = localIo } = {}
) {
  const lines = [];
  await io.readBackward(
    file,
    (line) => {
      if (line.length) lines.push(line);
      return lines.length >= maxLines ? true : undefined;
    },
    { maxLineBytes: MAX_LINE_BYTES }
  );
  lines.reverse();
  return turnsFrom(lines, { agent })
    .slice(-limit)
    .map((turn) => clipTurn(turn, maxChars));
}

/* ------------------------------ the tailing reader ---------------------------- */

/**
 * A stateful reader over one transcript: each `poll()` returns whatever turns
 * appeared since the last one.
 *
 * The steady state is a single `stat` — no read, no parse — because a
 * transcript that has not grown has nothing to say. Growth is read as a byte
 * range from the last offset, so the cost is the delta rather than the file.
 */
function createReader({ path: file, agent = 'claude', io = localIo, limit = 8, maxChars = 4000 }) {
  let offset = 0;
  let size = 0;
  let mtimeMs = 0;
  let ino = 0;
  let carry = EMPTY;

  const reset = () => {
    offset = 0;
    size = 0;
    mtimeMs = 0;
    carry = EMPTY;
  };

  async function poll() {
    const stat = await io.stat(file);
    if (!stat) return { turns: [], changed: false, gone: true };

    // Truncated (a /clear rewrote the session) or replaced (same path, new
    // file). Either way the offset means nothing now.
    if (stat.size < offset || (ino && stat.ino && stat.ino !== ino)) reset();
    ino = stat.ino || ino;

    if (stat.size === size && stat.mtimeMs === mtimeMs) return { turns: [], changed: false };
    size = stat.size;
    mtimeMs = stat.mtimeMs;

    if (offset === 0) {
      const turns = await readTail(file, { agent, limit, maxChars, io });
      offset = stat.size;
      carry = EMPTY;
      return { turns, changed: true, cold: true };
    }

    // Fell far behind: skip the gap and resync at a line boundary rather than
    // materializing megabytes we would only throw away.
    let start = offset;
    let resync = false;
    if (stat.size - offset > MAX_CATCHUP) {
      start = stat.size - MAX_CATCHUP;
      carry = EMPTY;
      resync = true;
    }

    const batch = await io.readForward(file, {
      start,
      end: stat.size,
      carry,
      maxLineBytes: MAX_LINE_BYTES,
    });
    offset = start + batch.read;
    carry = batch.carry;

    const lines = resync ? batch.lines.slice(1) : batch.lines; // drop the half line we cut
    return { turns: turnsFrom(lines, { agent }).map((t) => clipTurn(t, maxChars)), changed: true };
  }

  return {
    poll,
    reset,
    get offset() {
      return offset;
    },
    path: file,
    agent,
  };
}

module.exports = {
  encodeProjectDir,
  claudeTranscriptPath,
  findCodexRollout,
  resolveSession,
  turnsFrom,
  readTail,
  lastSaid,
  createReader,
  dayDirsBetween,
  sameDir,
  localIo,
  MAX_CATCHUP,
  MAX_LINE_BYTES,
  INJECTED,
};
