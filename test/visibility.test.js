'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { windowActionFor, resurfaces } = require('../src/visibility');

test('Clippy shows up when Claude is done or wants something', () => {
  for (const kind of ['attention', 'approval', 'answer', 'question', 'review']) {
    assert.equal(windowActionFor(kind), 'show', kind);
  }
});

test('ambient chatter puts Clippy away', () => {
  for (const kind of ['activity', 'clear', 'info']) {
    assert.equal(windowActionFor(kind), 'hide', kind);
  }
});

test('unknown kinds leave the window alone', () => {
  for (const kind of ['remove', 'drive-open', 'request-closed', '']) {
    assert.equal(windowActionFor(kind), null, kind);
  }
});

test('a buddy hidden by hand stays down for repeat reminders', () => {
  // Claude re-sends idle prompts while a session waits; each is an ordinary
  // 'attention'. Once you closed the popup, those must not reopen it.
  assert.equal(resurfaces('attention', 'normal', true), false);
  assert.equal(resurfaces('attention', 'low', true), false);
});

test('a dismissed buddy still comes back for anything new or urgent', () => {
  // A permission request is urgent even mid-dismissal…
  assert.equal(resurfaces('attention', 'urgent', true), true);
  // …and the interactive cards carry new work, not a repeat of the wait.
  for (const kind of ['approval', 'answer', 'question', 'review']) {
    assert.equal(resurfaces(kind, 'normal', true), true, kind);
  }
});

test('without a dismissal everything surfaces as before', () => {
  for (const kind of ['attention', 'approval', 'answer', 'question', 'review']) {
    assert.equal(resurfaces(kind, 'normal', false), true, kind);
  }
});
