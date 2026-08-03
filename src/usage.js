'use strict';

/**
 * Token usage, read from Claude Code's own transcripts.
 *
 * Every hook payload carries `transcript_path`, and each assistant line in that
 * JSONL file records the exact `usage` the API reported. That gives us the two
 * numbers worth showing: how full this session's context is right now (the last
 * message's input + cache tokens), and what it has spent in total.
 *
 * What we *can't* get: how much of your plan's 5-hour or weekly allowance is
 * left. Claude Code never writes that to disk — `/usage` asks the API for it —
 * so Clippy reports what it burned, not what remains.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

// Reading a week of transcripts must never stall the app; these caps keep a
// right-click cheap even for someone with hundreds of sessions.
const MAX_FILES = 400;
const MAX_BYTES = 80 * 1024 * 1024;

const DEFAULT_CONTEXT = 200_000;
const LONG_CONTEXT = 1_000_000;

/** Models with the long-context variant carry it in the id: `claude-opus-5[1m]`. */
function contextLimitFor(model = '') {
  return /\[1m\]|-1m\b/i.test(String(model)) ? LONG_CONTEXT : DEFAULT_CONTEXT;
}

const emptyTotals = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });

function addUsage(totals, usage) {
  totals.input += usage.input_tokens || 0;
  totals.output += usage.output_tokens || 0;
  totals.cacheRead += usage.cache_read_input_tokens || 0;
  totals.cacheCreate += usage.cache_creation_input_tokens || 0;
  return totals;
}

/** Everything sent + generated for one API call — i.e. how big the context was. */
function contextOf(usage = {}) {
  return (
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.output_tokens || 0)
  );
}

/**
 * Summarize one transcript.
 *
 * @param {string} text  JSONL contents
 * @param {number} [sinceMs]  only count lines at/after this time (day/week views)
 */
function parseTranscript(text, { sinceMs = 0 } = {}) {
  const totals = emptyTotals();
  const byModel = new Map(); // model id -> totals, for "where did it all go?"
  let model = '';
  let context = 0;
  let biggest = 0;
  let turns = 0;
  let lastAt = 0;

  for (const line of String(text).split('\n')) {
    if (!line || line.indexOf('"usage"') === -1) continue; // cheap pre-filter
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a half-written last line while Claude is mid-turn
    }
    const message = entry.type === 'assistant' ? entry.message : null;
    const usage = message && message.usage;
    if (!usage) continue;

    const at = Date.parse(entry.timestamp || '') || 0;
    if (sinceMs && at && at < sinceMs) continue;

    addUsage(totals, usage);
    turns++;
    if (message.model) {
      model = message.model;
      if (!byModel.has(model)) byModel.set(model, emptyTotals());
      addUsage(byModel.get(model), usage);
    }
    biggest = Math.max(biggest, contextOf(usage));
    // The newest message is the live context; sidechains (subagents) run their
    // own smaller contexts, so they must not shrink the number we report.
    if (at >= lastAt && !entry.isSidechain) {
      lastAt = at;
      context = contextOf(usage);
    }
  }

  // The transcript records the plain model id even on the 1M-context variant,
  // so a context that has already run past the standard window is the only
  // evidence that this session has the bigger one.
  const contextLimit = Math.max(
    contextLimitFor(model),
    biggest > DEFAULT_CONTEXT ? LONG_CONTEXT : 0
  );
  return { model, context, contextLimit, totals, turns, lastAt, byModel: Object.fromEntries(byModel) };
}

/** Read and summarize a single session's transcript. */
async function sessionUsage(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    const text = await fs.readFile(transcriptPath, 'utf8');
    return parseTranscript(text);
  } catch {
    return null; // no transcript yet, or it moved
  }
}

/** Every `*.jsonl` under `~/.claude/projects`, newest first. */
async function recentTranscripts(projectsDir, sinceMs) {
  const found = [];
  let dirs = [];
  try {
    dirs = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const full = path.join(projectsDir, dir.name);
    let files = [];
    try {
      files = await fs.readdir(full);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(full, name);
      try {
        const stat = await fs.stat(file);
        if (stat.mtimeMs >= sinceMs) found.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * What every session on this machine has spent since `sinceMs`. Capped, and
 * says so when the cap bit, so the number is never quietly wrong.
 */
async function usageSince(projectsDir, sinceMs) {
  const files = await recentTranscripts(projectsDir, sinceMs);
  const totals = emptyTotals();
  const byModel = {};
  let sessions = 0;
  let bytes = 0;
  let truncated = files.length > MAX_FILES;

  for (const entry of files.slice(0, MAX_FILES)) {
    if (bytes + entry.size > MAX_BYTES) {
      truncated = true;
      break;
    }
    bytes += entry.size;
    let text = '';
    try {
      text = await fs.readFile(entry.file, 'utf8');
    } catch {
      continue;
    }
    const summary = parseTranscript(text, { sinceMs });
    if (summary.turns === 0) continue;
    sessions++;
    for (const [model, modelTotals] of Object.entries(summary.byModel)) {
      const into = (byModel[model] ||= emptyTotals());
      for (const key of Object.keys(into)) into[key] += modelTotals[key];
    }
    addUsage(totals, {
      input_tokens: summary.totals.input,
      output_tokens: summary.totals.output,
      cache_read_input_tokens: summary.totals.cacheRead,
      cache_creation_input_tokens: summary.totals.cacheCreate,
    });
  }
  return { totals, sessions, truncated, byModel };
}

/** Local midnight / start of the last 7 days, as epoch ms. */
function startOfDay(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const startOfWeek = (now = Date.now()) => startOfDay(now) - 6 * 24 * 60 * 60 * 1000;

module.exports = {
  parseTranscript,
  contextLimitFor,
  contextOf,
  sessionUsage,
  usageSince,
  recentTranscripts,
  startOfDay,
  startOfWeek,
  DEFAULT_CONTEXT,
  LONG_CONTEXT,
};
