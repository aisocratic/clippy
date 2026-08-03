'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseTranscript, contextLimitFor, contextOf } = require('../src/usage');

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
  assert.equal(contextLimitFor('claude-sonnet-5'), 200_000);
  assert.equal(contextLimitFor(''), 200_000);
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
