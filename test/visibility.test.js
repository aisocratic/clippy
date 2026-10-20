'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { windowActionFor } = require('../src/visibility');

test('Clippy shows up when Claude is done or wants something', () => {
  for (const kind of ['attention', 'approval', 'answer', 'question', 'review']) {
    assert.equal(windowActionFor(kind), 'show', kind);
  }
});

test('ambient chatter puts Clippy away', () => {
  // 'failure' included: a failed tool is routine inside a session and only
  // colours the activity line — it must never bring the window up.
  for (const kind of ['activity', 'failure', 'clear', 'info']) {
    assert.equal(windowActionFor(kind), 'hide', kind);
  }
});

test('unknown kinds leave the window alone', () => {
  for (const kind of ['remove', 'drive-open', 'request-closed', '']) {
    assert.equal(windowActionFor(kind), null, kind);
  }
});
