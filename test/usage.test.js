'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseTranscript,
  contextLimitFor,
  contextOf,
  rollingWindow,
  tallyInto,
  agesOutAt,
  modelSlice,
  usageWindows,
  cleanLimits,
  planLimitsFor,
  OPUS,
  SESSION_WINDOW_MS,
  WEEK_WINDOW_MS,
} = require('../src/usage');

const assistant = (ts, usage, extra = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    ...extra,
    message: { model: 'claude-opus-5', usage },
  });

const usage = (input, output, cacheRead = 0, cacheCreate = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheCreate,
});

test('a transcript adds up to session totals and a live context size', () => {
  const text = [
    JSON.stringify({ type: 'user', timestamp: '2026-08-02T10:00:00Z' }),
    assistant('2026-08-02T10:00:01Z', usage(5, 100, 20_000, 1_000)),
    assistant('2026-08-02T10:05:00Z', usage(2, 300, 90_000, 500)),
    '', // trailing newline
  ].join('\n');

  const u = parseTranscript(text);
  assert.equal(u.model, 'claude-opus-5');
  assert.equal(u.turns, 2);
  assert.deepEqual(u.totals, { input: 7, output: 400, cacheRead: 110_000, cacheCreate: 1_500 });
  // The newest message is what the context currently holds.
  assert.equal(u.context, 2 + 90_000 + 500 + 300);
  assert.equal(u.contextLimit, 200_000);
});

test('subagent sidechains never masquerade as the main context', () => {
  const text = [
    assistant('2026-08-02T10:00:00Z', usage(1, 10, 150_000)),
    assistant('2026-08-02T10:01:00Z', usage(1, 10, 900), { isSidechain: true }),
  ].join('\n');

  const u = parseTranscript(text);
  assert.equal(u.context, contextOf(usage(1, 10, 150_000)));
  assert.equal(u.turns, 2); // its tokens still count towards what was spent
});

test('a half-written line (Claude mid-turn) is skipped, not fatal', () => {
  const text = `${assistant('2026-08-02T10:00:00Z', usage(1, 2))}\n{"type":"assis`;
  assert.equal(parseTranscript(text).turns, 1);
  assert.equal(parseTranscript('').turns, 0);
});

test('only lines inside the window count when one is given', () => {
  const text = [
    assistant('2026-08-01T23:00:00Z', usage(0, 1_000)),
    assistant('2026-08-02T09:00:00Z', usage(0, 7)),
  ].join('\n');

  const since = Date.parse('2026-08-02T00:00:00Z');
  assert.equal(parseTranscript(text, { sinceMs: since }).totals.output, 7);
  assert.equal(parseTranscript(text).totals.output, 1_007);
});

test('the long-context models get the bigger budget', () => {
  assert.equal(contextLimitFor('claude-opus-5[1m]'), 1_000_000);
  assert.equal(contextLimitFor('claude-fable-5'), 1_000_000);
  assert.equal(contextLimitFor('claude-sonnet-4-5'), 200_000);
  assert.equal(contextLimitFor(''), 200_000);
});

/* ---------- The windows /usage reports on ---------- */

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-03T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

/** An assistant line from a named model, `ms` milliseconds before NOW. */
const at = (ms, model, u) =>
  JSON.stringify({ type: 'assistant', timestamp: ago(ms), message: { model, usage: u } });

test('a rolling window takes the last message on its boundary and no earlier one', () => {
  const win = rollingWindow(SESSION_WINDOW_MS, NOW);
  const text = [
    at(SESSION_WINDOW_MS + 1, 'claude-opus-5', usage(0, 1_000)), // one ms too old
    at(SESSION_WINDOW_MS, 'claude-opus-5', usage(0, 7)), // exactly on the edge
    at(HOUR, 'claude-opus-5', usage(0, 30)),
  ].join('\n');

  tallyInto(text, [win]);
  assert.equal(win.totals.output, 37);
  assert.equal(win.since, NOW - SESSION_WINDOW_MS);
  assert.equal(win.firstAt, NOW - SESSION_WINDOW_MS);
  assert.equal(win.lastAt, NOW - HOUR);
});

test('one pass fills every window, each with its own per-model split', () => {
  const block = rollingWindow(SESSION_WINDOW_MS, NOW);
  const week = rollingWindow(WEEK_WINDOW_MS, NOW);
  const text = [
    at(3 * 24 * HOUR, 'claude-sonnet-5', usage(0, 500)), // this week only
    at(2 * HOUR, 'claude-opus-5', usage(0, 60)), // both windows
    at(30 * 60 * 1000, 'claude-sonnet-5', usage(0, 40)),
  ].join('\n');

  const touched = tallyInto(text, [block, week]);
  assert.equal(touched.length, 2); // one transcript, counted as a session in both
  assert.equal(block.totals.output, 100);
  assert.equal(week.totals.output, 600);
  assert.deepEqual(Object.keys(block.byModel), ['claude-opus-5', 'claude-sonnet-5']);
  assert.equal(block.byModel['claude-sonnet-5'].output, 40);
  assert.equal(week.byModel['claude-sonnet-5'].output, 540);
});

test("a window's oldest message ages out a span later, and an empty one says nothing", () => {
  const win = rollingWindow(SESSION_WINDOW_MS, NOW);
  tallyInto(at(2 * HOUR, 'claude-opus-5', usage(0, 1)), [win]);
  // Counted 2h ago, in a 5h window: 3h before it falls out of the far end.
  assert.equal(agesOutAt(win) - NOW, 3 * HOUR);

  const quiet = rollingWindow(SESSION_WINDOW_MS, NOW);
  assert.equal(agesOutAt(quiet), 0); // nothing spent, so nothing to say
  assert.equal(quiet.totals.output, 0);
  assert.equal(agesOutAt(null), 0);
});

test('a line with no readable timestamp sits where its neighbours do', () => {
  const block = rollingWindow(SESSION_WINDOW_MS, NOW);
  const week = rollingWindow(WEEK_WINDOW_MS, NOW);
  const undated = JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-5', usage: usage(0, 1_000) },
  });
  const text = [at(6 * 24 * HOUR, 'claude-opus-5', usage(0, 7)), undated].join('\n');

  tallyInto(text, [block, week]);
  // Six days old by the company it keeps, so the five-hour block never sees it.
  assert.equal(week.totals.output, 1_007);
  assert.equal(block.totals.output, 0);
  assert.equal(block.firstAt, 0);
});

test('a transcript with no timestamps at all counts once, in the widest window', () => {
  const block = rollingWindow(SESSION_WINDOW_MS, NOW);
  const week = rollingWindow(WEEK_WINDOW_MS, NOW);
  const undated = JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-5', usage: usage(0, 500) },
  });

  const touched = tallyInto(undated, [block, week]);
  // "Some time this week" is everything the file says, so that is all it claims.
  assert.deepEqual(touched, [week]);
  assert.equal(week.totals.output, 500);
  assert.equal(week.firstAt, 0); // and it still can't say when the week began
  assert.equal(block.totals.output, 0);
});

test('the Opus slice counts only Opus, and keeps the week it came from', () => {
  const week = rollingWindow(WEEK_WINDOW_MS, NOW);
  tallyInto(
    [
      at(4 * 24 * HOUR, 'claude-opus-5', usage(0, 900)),
      at(2 * 24 * HOUR, 'claude-opus-5[1m]', usage(0, 100)),
      at(HOUR, 'claude-sonnet-5', usage(0, 50)),
    ].join('\n'),
    [week]
  );

  const opus = modelSlice(week, OPUS);
  assert.equal(opus.totals.output, 1_000);
  assert.deepEqual(Object.keys(opus.byModel), ['claude-opus-5', 'claude-opus-5[1m]']);
  // The weekly allowances reset together, so the slice must not invent a clock.
  assert.equal(opus.firstAt, week.firstAt);
  assert.equal(agesOutAt(opus), agesOutAt(week));
  assert.equal(week.totals.output, 1_050); // the parent is left alone
});

test('the Opus slice counts Opus sessions, not the whole week of them', () => {
  const week = rollingWindow(WEEK_WINDOW_MS, NOW);
  tallyInto(at(2 * 24 * HOUR, 'claude-opus-5', usage(0, 900)), [week]);
  tallyInto(at(HOUR, 'claude-sonnet-5', usage(0, 50)), [week]); // a second transcript

  assert.equal(week.sessions, 2);
  assert.equal(modelSlice(week, OPUS).sessions, 1);
});

test('a sweep reads the projects tree once and answers all three windows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-usage-'));
  const project = path.join(dir, '-Users-someone-thing');
  fs.mkdirSync(project);
  fs.writeFileSync(
    path.join(project, 'a.jsonl'),
    [
      at(6 * 24 * HOUR, 'claude-opus-5', usage(0, 700)), // this week, not this block
      at(HOUR, 'claude-opus-5', usage(0, 200)),
      at(20 * 60 * 1000, 'claude-sonnet-5', usage(0, 100)),
    ].join('\n')
  );
  fs.writeFileSync(path.join(project, 'b.jsonl'), at(9 * 24 * HOUR, 'claude-opus-5', usage(0, 5)));
  fs.writeFileSync(path.join(project, 'notes.txt'), 'not a transcript');

  const { session, week, weekOpus } = await usageWindows(dir, NOW);
  assert.equal(session.totals.output, 300);
  assert.equal(session.sessions, 1);
  assert.equal(week.totals.output, 1_000); // the 9-day-old file is out of range
  assert.equal(weekOpus.totals.output, 900);
  assert.equal(weekOpus.agesOutAt, week.agesOutAt);
  assert.equal(week.truncated, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an empty projects tree is zeroes, not a crash', async () => {
  const { session, week, weekOpus } = await usageWindows(
    path.join(os.tmpdir(), 'clippy-nothing-here'),
    NOW
  );
  for (const win of [session, week, weekOpus]) {
    assert.equal(win.totals.output, 0);
    assert.equal(win.sessions, 0);
    assert.equal(win.agesOutAt, 0);
    assert.deepEqual(win.byModel, {});
  }
});

/* ---------- Allowances, which only the user can supply ---------- */

test('no plan means no allowance — the panel has to fall back, not guess', () => {
  assert.equal(planLimitsFor({}), null);
  assert.equal(planLimitsFor({ plan: 'unknown' }), null);
  assert.equal(planLimitsFor({ plan: 'custom', planLimits: {} }), null);
  // A tier nobody ships is not an excuse to make one up.
  assert.equal(planLimitsFor({ plan: 'max100' }), null);
});

test('a named tier hands over all three windows, and Max 5x is five Pros', () => {
  const pro = planLimitsFor({ plan: 'pro' });
  const max5 = planLimitsFor({ plan: 'max5' });
  assert.deepEqual(Object.keys(pro), ['session', 'week', 'weekOpus']);
  for (const key of Object.keys(pro)) assert.equal(max5[key], pro[key] * 5);
});

test('your own numbers survive; nonsense does not', () => {
  assert.deepEqual(cleanLimits({ session: 5_000_000, week: 'lots', weekOpus: -3 }), {
    session: 5_000_000,
  });
  assert.deepEqual(cleanLimits(null), {});
  // Knowing one window and not the others is allowed: the rest fall back.
  assert.deepEqual(planLimitsFor({ plan: 'custom', planLimits: { week: 42.6 } }), { week: 43 });
});

test('a context past the standard window means the 1M variant', () => {
  // Claude Code writes the plain model id even on the [1m] variant, so a
  // context of 257k is the only sign that the window is the bigger one.
  const text = assistant('2026-08-02T10:00:00Z', usage(2, 3_686, 252_617, 907));
  const u = parseTranscript(text);
  assert.equal(u.model, 'claude-opus-5');
  assert.equal(u.contextLimit, 1_000_000);
  assert.ok(u.context > 200_000);
});

test("Claude Code's own cached /usage percentages are read when present", async () => {
  const { readOfficialUsage } = require('../src/usage');
  const os = require('node:os');
  const fsSync = require('node:fs');
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'clippy-official-'));
  const file = path.join(dir, '.claude.json');

  // The shape Claude Code writes today — session, weekly_all, and a weekly
  // row scoped to a named model (Fable at the moment, whoever tomorrow).
  fsSync.writeFileSync(
    file,
    JSON.stringify({
      cachedUsageUtilization: {
        fetchedAtMs: 1_785_873_983_262,
        utilization: {
          limits: [
            { kind: 'session', group: 'session', percent: 0, severity: 'normal', resets_at: null },
            {
              kind: 'weekly_all',
              group: 'weekly',
              percent: 4,
              severity: 'normal',
              resets_at: '2026-08-11T07:00:00.256595+00:00',
            },
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 8,
              severity: 'normal',
              resets_at: '2026-08-11T07:00:00.256884+00:00',
              scope: { model: { id: null, display_name: 'Fable' } },
            },
          ],
        },
      },
    })
  );

  const official = await readOfficialUsage(file);
  assert.equal(official.fetchedAtMs, 1_785_873_983_262);
  assert.equal(official.limits.length, 3);
  assert.deepEqual(
    official.limits.map((l) => l.label),
    ['session · 5 hours', 'week · all models', 'week · Fable'],
    'the scoped row is named by the cache, never hard-coded'
  );
  assert.equal(official.limits[1].percent, 4);
  assert.ok(official.limits[1].resetsAt > 0, 'reset times come through as epoch ms');

  // No cache, or a config from an older Claude Code: null, and the panel
  // falls back to measured spend.
  fsSync.writeFileSync(file, JSON.stringify({ someOtherKey: true }));
  assert.equal(await readOfficialUsage(file), null);
  assert.equal(await readOfficialUsage(path.join(dir, 'missing.json')), null);
});
