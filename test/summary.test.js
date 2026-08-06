'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { summaryState, summaryRecap, oneLine } = require('../src/renderer/summary');

test('every session state has plain words on the card', () => {
  assert.equal(summaryState('working'), 'running');
  assert.equal(summaryState('idle'), 'paused — waiting for a prompt');
  assert.equal(summaryState('waiting'), 'waiting for your answer');
  assert.equal(summaryState('needs_permission'), 'needs your permission');
});

test('unknown states pass through instead of vanishing', () => {
  assert.equal(summaryState('rebooting'), 'rebooting');
  assert.equal(summaryState(''), 'idle');
  assert.equal(summaryState(undefined), 'idle');
});

test('mid-turn the activity line wins; the recap covers for it', () => {
  const recap = 'I refactored the parser and the tests pass.';
  assert.equal(
    summaryRecap({ status: 'working', activity: '⚙ Bash: npm test', recap }),
    '⚙ Bash: npm test'
  );
  // A turn that has produced no tool activity yet still has last turn's words.
  assert.equal(summaryRecap({ status: 'working', activity: '', recap }), recap);
});

test('between turns the last thing Claude said wins', () => {
  const recap = 'All three bugs fixed; the flaky test was a timezone.';
  assert.equal(summaryRecap({ status: 'waiting', activity: '✓ Bash: npm test', recap }), recap);
  // …and a turn that ended on a bare tool call falls back to the activity.
  assert.equal(
    summaryRecap({ status: 'waiting', activity: '✓ Bash: npm test', recap: '' }),
    '✓ Bash: npm test'
  );
  assert.equal(summaryRecap({ status: 'idle' }), '');
});

test('a transcript recap is flattened to one line for the card', () => {
  assert.equal(
    summaryRecap({ status: 'waiting', recap: 'Done.\n\nNext up:\n- the tests' }),
    'Done. Next up: - the tests'
  );
});

test('oneLine trims, flattens, and cuts on an ellipsis', () => {
  assert.equal(oneLine('  spaced   out\ttext \n'), 'spaced out text');
  assert.equal(oneLine(null), '');
  const long = 'a'.repeat(500);
  const cut = oneLine(long);
  assert.equal(cut.length, 160);
  assert.ok(cut.endsWith('…'));
  // Under the cap nothing is touched.
  assert.equal(oneLine('short', 10), 'short');
});
