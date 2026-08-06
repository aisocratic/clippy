'use strict';

/**
 * Token usage, read from Claude Code and Codex's own transcripts.
 *
 * Every hook payload carries `transcript_path`, and each assistant line in that
 * JSONL file records the exact `usage` the API reported. That gives us the two
 * numbers worth showing: how full this session's context is right now (the last
 * message's input + cache tokens), and what every session has spent inside the
 * windows `/usage` reports against — the rolling five-hour block, the week, and
 * Opus counted again on its own.
 *
 * And the real allowance: newer Claude Code caches the `/usage` percentages
 * in ~/.claude.json (see readOfficialUsage), which the panel shows first. The
 * transcript sweep and the PLANS estimates below are the fallback for older
 * installs, or a machine where /usage has never been opened.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

// Reading a week of transcripts must never stall the app; these caps keep a
// right-click cheap even for someone with hundreds of sessions.
const MAX_FILES = 400;
const MAX_BYTES = 80 * 1024 * 1024;
// Stop reviews normally find the final assistant turn in one read. Keeping the
// block modest also means a very large transcript never has to be materialized
// just to inspect its last few JSONL records.
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;

const DEFAULT_CONTEXT = 200_000;
const LONG_CONTEXT = 1_000_000;

const HOUR_MS = 60 * 60 * 1000;

// The two spans `/usage` reports on. The weekly allowance is really two — all
// models, and Opus again by itself — but they reset together, so one week-long
// sweep feeds both rows.
const SESSION_WINDOW_MS = 5 * HOUR_MS;
const WEEK_WINDOW_MS = 7 * 24 * HOUR_MS;

// The model id is the only thing in a transcript that says who answered, and
// every Opus id has said "opus" in it so far.
const OPUS = /opus/i;

/**
 * Models with the long-context variant carry it in the id: `claude-opus-5[1m]`.
 * The Fable family is 1M natively — transcripts record the plain id
 * (`claude-fable-5`) with no marker, so match the family name itself.
 */
function contextLimitFor(model = '') {
  const id = String(model);
  return /\[1m\]|-1m\b/i.test(id) || /fable/i.test(id) ? LONG_CONTEXT : DEFAULT_CONTEXT;
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
 * Walk the assistant lines of a transcript, handing each reported `usage` over
 * with the bits of context that decide where it counts.
 *
 * One place parses a transcript, because one sweep has to feed every window on
 * the panel and reading these files twice would show in the right-click.
 */
function eachUsage(text, visit) {
  let codexModel = '';
  let codexTotalSignature = '';
  for (const line of String(text).split('\n')) {
    if (
      !line ||
      (line.indexOf('"usage"') === -1 &&
        line.indexOf('"turn_context"') === -1 &&
        line.indexOf('"token_count"') === -1)
    ) continue; // cheap pre-filter for both transcript formats
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a half-written last line while Claude is mid-turn
    }
    const message = entry.type === 'assistant' ? entry.message : null;
    if (message && message.usage) {
      visit(message.usage, {
        at: Date.parse(entry.timestamp || '') || 0,
        model: message.model || '',
        sidechain: Boolean(entry.isSidechain),
      });
      continue;
    }

    // Codex rollout JSONL keeps the current model on turn_context and emits a
    // token_count event after model work. last_token_usage is the increment for
    // this call; total_token_usage is cumulative and must not be added again.
    if (entry.type === 'turn_context' && entry.payload?.model) codexModel = entry.payload.model;
    const info = entry.type === 'event_msg' && entry.payload?.type === 'token_count'
      ? entry.payload.info
      : null;
    const raw = info?.last_token_usage;
    if (!raw) continue;
    const cached = raw.cached_input_tokens || 0;
    const cumulative = info.total_token_usage;
    const signature = cumulative
      ? [
          cumulative.input_tokens,
          cumulative.cached_input_tokens,
          cumulative.output_tokens,
          cumulative.reasoning_output_tokens,
          cumulative.total_tokens,
        ].join(':')
      : '';
    const count = !signature || signature !== codexTotalSignature;
    if (signature) codexTotalSignature = signature;
    visit(
      {
        input_tokens: Math.max(0, (raw.input_tokens || 0) - cached),
        output_tokens: raw.output_tokens || 0,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
      },
      {
        at: Date.parse(entry.timestamp || '') || 0,
        model: codexModel,
        sidechain: false,
        contextLimit: Number(info.model_context_window) || 0,
        context: Number(raw.total_tokens) || 0,
        count,
      }
    );
  }
}

/**
 * The latest model named by either transcript format, even before the first
 * token-count event arrives. Claude writes it on assistant messages; Codex
 * writes it on turn_context. Keeping this independent from usage is what lets
 * a brand-new or idle session identify itself instead of saying "unknown".
 */
function modelFromTranscript(text) {
  let model = '';
  for (const line of String(text).split('\n')) {
    if (!line || line.indexOf('"model"') === -1) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === 'assistant' && typeof entry.message?.model === 'string') {
      model = entry.message.model;
    } else if (entry.type === 'turn_context' && typeof entry.payload?.model === 'string') {
      model = entry.payload.model;
    }
  }
  return model;
}

/**
 * Summarize one transcript.
 *
 * @param {string} text  JSONL contents
 * @param {number} [sinceMs]  only count lines at/after this time
 */
function parseTranscript(text, { sinceMs = 0 } = {}) {
  const totals = emptyTotals();
  const byModel = new Map(); // model id -> totals, for "where did it all go?"
  let model = modelFromTranscript(text);
  let context = 0;
  let biggest = 0;
  let turns = 0;
  let lastAt = 0;
  let reportedContextLimit = 0;

  eachUsage(text, (usage, line) => {
    if (sinceMs && line.at && line.at < sinceMs) return;

    if (line.count !== false) {
      addUsage(totals, usage);
      turns++;
    }
    if (line.model) {
      model = line.model;
      if (line.count !== false) {
        if (!byModel.has(model)) byModel.set(model, emptyTotals());
        addUsage(byModel.get(model), usage);
      }
    }
    reportedContextLimit = Math.max(reportedContextLimit, line.contextLimit || 0);
    const liveContext = line.context || contextOf(usage);
    biggest = Math.max(biggest, liveContext);
    // The newest message is the live context; sidechains (subagents) run their
    // own smaller contexts, so they must not shrink the number we report.
    if (line.at >= lastAt && !line.sidechain) {
      lastAt = line.at;
      context = liveContext;
    }
  });

  // The transcript records the plain model id even on the 1M-context variant,
  // so a context that has already run past the standard window is the only
  // evidence that this session has the bigger one.
  const contextLimit = Math.max(
    reportedContextLimit || contextLimitFor(model),
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

/**
 * The plain-text tail of the last assistant turn — what Claude actually said
 * right before finishing, if it said anything. A turn that ends on a bare
 * tool call has no recap to show, so this can come back empty.
 *
 * Read fresh rather than cached: the review card needs the exact words from
 * the turn that just ended, not whatever the last sweep happened to see.
 */
async function lastAssistantText(transcriptPath, { maxChars = 600 } = {}) {
  if (!transcriptPath) return '';
  let handle;
  try {
    handle = await fs.open(transcriptPath, 'r');
    const { size } = await handle.stat();
    let position = size;
    // Segments of the one line that crosses a block boundary, encountered from
    // right to left. This stays empty for the overwhelmingly common case.
    let lineParts = [];

    const recapFrom = (line) => {
      if (!line.length) return '';
      if (line.indexOf('"assistant"') === -1 && line.indexOf('"agent_message"') === -1) return '';
      let entry;
      try {
        entry = JSON.parse(line.toString('utf8'));
      } catch {
        return ''; // including a half-written final line
      }
      // Codex records model-facing response items as well as a convenient
      // agent_message event — the event carries the words.
      if (entry.type === 'event_msg' && entry.payload?.type === 'agent_message') {
        const message = entry.payload.message;
        return typeof message === 'string' ? message.trim() : '';
      }
      if (entry.type !== 'assistant' || entry.isSidechain) return '';
      const content = entry.message && entry.message.content;
      if (!Array.isArray(content)) return '';
      return content
        .filter((c) => c && c.type === 'text' && c.text)
        .map((c) => c.text)
        .join('\n')
        .trim();
    };

    const clipped = (recap) =>
      recap.length > maxChars ? `${recap.slice(0, maxChars).trim()}…` : recap;

    while (position > 0) {
      const start = Math.max(0, position - TRANSCRIPT_TAIL_BYTES);
      const block = Buffer.allocUnsafe(position - start);
      let filled = 0;
      // Positional reads can legally be short, even for a regular file.
      while (filled < block.length) {
        const result = await handle.read(block, filled, block.length - filled, start + filled);
        if (!result.bytesRead) break;
        filled += result.bytesRead;
      }
      position = start;
      const bytes = filled === block.length ? block : block.subarray(0, filled);
      let lineEnd = bytes.length;

      for (let i = bytes.length - 1; i >= 0; i--) {
        if (bytes[i] !== 0x0a) continue; // JSONL is delimited by LF
        const segments = [bytes.subarray(i + 1, lineEnd)];
        for (let j = lineParts.length - 1; j >= 0; j--) segments.push(lineParts[j]);
        const line = segments.length === 1 ? segments[0] : Buffer.concat(segments);
        lineParts = [];
        lineEnd = i;
        const recap = recapFrom(line);
        if (recap) return clipped(recap);
      }

      if (lineEnd) lineParts.push(bytes.subarray(0, lineEnd));
      if (!filled) break; // the file was truncated while it was being read
    }

    // A JSONL file need not have a leading or trailing newline. Once offset 0
    // is reached, the accumulated fragments are its first complete record.
    if (lineParts.length) {
      const line = Buffer.concat(lineParts.reverse());
      const recap = recapFrom(line);
      if (recap) return clipped(recap);
    }
  } catch {
    return '';
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  return '';
}

/** Every `*.jsonl` under `~/.claude/projects`, newest first. */
async function recentTranscripts(projectsDir, sinceMs) {
  const found = [];
  const walk = async (dir, depth = 0) => {
    if (depth > 8 || found.length > MAX_FILES * 3) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(file, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const stat = await fs.stat(file);
        if (stat.mtimeMs >= sinceMs) found.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // vanished between readdir and stat
      }
    }
  };
  await walk(projectsDir);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** An empty tally for everything at or after `since`, spanning `spanMs`. */
function emptyWindow(since, spanMs) {
  return {
    since,
    spanMs,
    totals: emptyTotals(),
    byModel: {},
    sessions: 0,
    // Which models each counted transcript used, so a slice of this window can
    // say how many sessions were actually *its* sessions rather than inheriting
    // a count that includes everyone else's.
    sessionModels: [],
    firstAt: 0, // oldest message counted here
    lastAt: 0,
    truncated: false,
  };
}

/**
 * A window that ends now and reaches `spanMs` back.
 *
 * Claude Code's five-hour block starts at your first message and runs from
 * there rather than trailing behind the clock, so this is a trailing window and
 * not that block — the totals agree (a message older than the span has aged out
 * either way) but the clock does not, which is why nothing here counts down.
 */
const rollingWindow = (spanMs, now = Date.now()) => emptyWindow(now - spanMs, spanMs);

/**
 * When this window's oldest counted message drops out of it.
 *
 * Deliberately not called a reset: when this moment arrives one message leaves
 * a trailing window and the total barely moves, whereas a real reset empties
 * the allowance. That one lives on the server, and only `/usage` can ask.
 */
const agesOutAt = (win) => (win && win.firstAt ? win.firstAt + win.spanMs : 0);

/**
 * Add one transcript to every window it falls inside, count it as a session
 * there, and hand back the windows it touched.
 *
 * Transcripts are written in order, so a line whose timestamp is missing or
 * unreadable is placed where its neighbours are — much better evidence than the
 * old rule, which counted it in every window and so let week-old spend swell
 * the five-hour block. A line with no neighbour to borrow from counts only in
 * the widest window on offer, because "some time this week" is all we know.
 */
function tallyInto(text, windows) {
  const seen = new Map(); // window -> the models this transcript put in it
  const widest = windows.reduce((wide, win) => (!wide || win.spanMs > wide.spanMs ? win : wide), null);
  let carried = 0; // the last timestamp we could read, in file order

  eachUsage(text, (usage, line) => {
    if (line.count === false) return;
    const at = line.at || carried;
    if (line.at) carried = line.at;
    for (const win of windows) {
      if (at ? at < win.since : win !== widest) continue;
      addUsage(win.totals, usage);
      const models = seen.get(win) || seen.set(win, new Set()).get(win);
      if (line.model) {
        addUsage((win.byModel[line.model] ||= emptyTotals()), usage);
        models.add(line.model);
      }
      if (at) {
        if (!win.firstAt || at < win.firstAt) win.firstAt = at;
        if (at > win.lastAt) win.lastAt = at;
      }
    }
  });

  for (const [win, models] of seen) {
    win.sessions++;
    (win.sessionModels ||= []).push([...models]);
  }
  return [...seen.keys()];
}

/**
 * One pass over the recent transcripts, added up into every window at once.
 *
 * Capped, and every window says so when the cap bit, so a number is never
 * quietly wrong. Three bars must not cost three sweeps, which is why the
 * windows are filled together rather than one call each.
 */
async function sweepInto(projectsDir, windows) {
  const oldest = Math.min(...windows.map((w) => w.since));
  const files = await recentTranscripts(projectsDir, oldest);
  const allowed = files.slice(0, MAX_FILES);
  let bytes = 0;
  let read = 0;

  for (const entry of allowed) {
    if (bytes + entry.size > MAX_BYTES) break;
    bytes += entry.size;
    read++;
    let text = '';
    try {
      text = await fs.readFile(entry.file, 'utf8');
    } catch {
      continue;
    }
    tallyInto(text, windows); // which counts the transcript as a session too
  }

  // Newest first, so the caps only ever bite at the old end: a window is
  // short-changed only if something we skipped was new enough to be in it.
  // The five-hour block almost never is, and shouldn't wear the week's warning.
  for (const skipped of files.slice(read)) {
    for (const win of windows) {
      if (skipped.mtimeMs >= win.since) win.truncated = true;
    }
  }
  return windows;
}

/**
 * The same window, counting only the models whose id matches.
 *
 * The slice keeps its parent's clock on purpose: the weekly allowances — all
 * models, and Opus — reset together, so the Opus row must not invent a reset
 * of its own out of whenever Opus last happened to answer.
 */
function modelSlice(win, pattern) {
  const totals = emptyTotals();
  const byModel = {};
  for (const [model, modelTotals] of Object.entries(win.byModel)) {
    if (!pattern.test(model)) continue;
    byModel[model] = { ...modelTotals };
    for (const key of Object.keys(totals)) totals[key] += modelTotals[key];
  }
  // The session count has to be sliced as well: a week of 22 sessions where two
  // of them touched Opus is not "22 Opus sessions", however tempting the copy.
  const sessionModels = (win.sessionModels || []).filter((models) => models.some((m) => pattern.test(m)));
  return { ...win, totals, byModel, sessionModels, sessions: sessionModels.length };
}

/**
 * What every session on this machine has spent inside the windows `/usage`
 * reports on: the five-hour block, the week, and the Opus share of that week.
 */
async function usageWindows(projectsDir, now = Date.now()) {
  const session = rollingWindow(SESSION_WINDOW_MS, now);
  const week = rollingWindow(WEEK_WINDOW_MS, now);
  await sweepInto(projectsDir, [session, week]);
  // The per-session model lists have done their work in `modelSlice`; there is
  // no reason to walk them across the IPC boundary to a panel of three bars.
  const stamp = ({ sessionModels, ...win }) => ({ ...win, agesOutAt: agesOutAt(win) });
  return {
    session: stamp(session),
    week: stamp(week),
    weekOpus: stamp(modelSlice(week, OPUS)),
  };
}

/* ---------------- The real allowance, cached by Claude Code itself ---------------- */

/**
 * Claude Code keeps the last `/usage` answer in ~/.claude.json under
 * `cachedUsageUtilization` — the actual percentages of the actual limits,
 * with reset times, refreshed whenever `/usage` loads them. That is the
 * ground truth this module's transcript-sweeping can only approximate, so
 * when it's there, the panel shows it first.
 *
 * It is a cache, not a feed: `fetchedAtMs` says how old it is, and the panel
 * says so too. Absent (older Claude Code, `/usage` never opened), everything
 * falls back to measured spend exactly as before.
 *
 * @param {string} [file]  override for tests
 * @returns {{fetchedAtMs: number, limits: Array<{kind, group, percent, severity,
 *            resetsAt, label}>}|null}
 */
async function readOfficialUsage(file = path.join(require('node:os').homedir(), '.claude.json')) {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null; // no config, or mid-write — try again next open
  }
  const cached = raw && raw.cachedUsageUtilization;
  const limits = cached && cached.utilization && cached.utilization.limits;
  if (!Array.isArray(limits) || limits.length === 0) return null;

  const rows = [];
  for (const limit of limits) {
    if (!limit || typeof limit.percent !== 'number') continue;
    // The scoped weekly row names its model ("Fable" today) — carry the name
    // rather than hard-coding one, so Clippy follows whatever the plan counts.
    const scopedTo = limit.scope && limit.scope.model && limit.scope.model.display_name;
    const label =
      limit.kind === 'session'
        ? 'session · 5 hours'
        : limit.kind === 'weekly_all'
        ? 'week · all models'
        : scopedTo
        ? `week · ${scopedTo}`
        : `${limit.group || limit.kind}`;
    rows.push({
      kind: limit.kind,
      group: limit.group || '',
      percent: Math.max(0, limit.percent),
      severity: limit.severity || 'normal',
      resetsAt: limit.resets_at ? Date.parse(limit.resets_at) || 0 : 0,
      label,
    });
  }
  if (rows.length === 0) return null;
  return { fetchedAtMs: Number(cached.fetchedAtMs) || 0, limits: rows };
}

/* ---------------- Allowances, which only you can tell us ---------------- */

// A plan's allowance in each window, counted in total tokens — input, output
// and cache, because cache is what Clippy can actually measure.
//
// These are ESTIMATES and are labelled as such everywhere they are shown.
// Anthropic doesn't publish the numbers and Claude Code never writes them to
// disk, so the honest way to use one is as a starting scale: run `/usage` in
// Claude Code, compare its percentage with Clippy's, and type the corrected
// number in as "Custom". The one solid thing here is the 5×/20× steps, which
// is what the plan names mean — so all three tiers are a single anchor
// multiplied out rather than three separate guesses.
const PRO_ESTIMATE = { session: 30_000_000, week: 360_000_000, weekOpus: 120_000_000 };

const scaled = (factor) => ({
  session: PRO_ESTIMATE.session * factor,
  week: PRO_ESTIMATE.week * factor,
  weekOpus: PRO_ESTIMATE.weekOpus * factor,
});

/** The windows an allowance can be set for — also the shape of a custom one. */
const PLAN_WINDOWS = ['session', 'week', 'weekOpus'];

const PLANS = [
  {
    id: 'unknown',
    label: 'Not set',
    note: 'Bars show each window as a share of the last 7 days — spend, with nothing to compare it to.',
    limits: null,
  },
  { id: 'pro', label: 'Pro', note: 'Rough estimate — calibrate it.', limits: PRO_ESTIMATE, estimated: true },
  { id: 'max5', label: 'Max 5×', note: 'Rough estimate — calibrate it.', limits: scaled(5), estimated: true },
  { id: 'max20', label: 'Max 20×', note: 'Rough estimate — calibrate it.', limits: scaled(20), estimated: true },
  {
    id: 'custom',
    label: 'Custom',
    note: 'Your own numbers, worked out from what `/usage` says.',
    limits: null,
  },
];

/** Keep only allowances that are real, positive token counts. */
function cleanLimits(value) {
  const limits = {};
  for (const key of PLAN_WINDOWS) {
    const n = Math.round(Number((value || {})[key]));
    if (Number.isFinite(n) && n > 0) limits[key] = n;
  }
  return limits;
}

/**
 * The allowances to draw bars against, or null when nobody has said.
 *
 * A custom plan may know one window and not the others — someone who has only
 * bothered to work out their weekly number gets a real weekly bar and an
 * honest share-of-the-week for the rest.
 */
function planLimitsFor({ plan = 'unknown', planLimits = {} } = {}) {
  if (plan === 'custom') {
    const limits = cleanLimits(planLimits);
    return Object.keys(limits).length ? limits : null;
  }
  const named = PLANS.find((p) => p.id === plan);
  return named && named.limits ? { ...named.limits } : null;
}

module.exports = {
  parseTranscript,
  modelFromTranscript,
  contextLimitFor,
  contextOf,
  sessionUsage,
  lastAssistantText,
  recentTranscripts,
  rollingWindow,
  emptyWindow,
  tallyInto,
  sweepInto,
  modelSlice,
  agesOutAt,
  usageWindows,
  readOfficialUsage,
  cleanLimits,
  planLimitsFor,
  PLANS,
  PLAN_WINDOWS,
  OPUS,
  SESSION_WINDOW_MS,
  WEEK_WINDOW_MS,
  DEFAULT_CONTEXT,
  LONG_CONTEXT,
};
