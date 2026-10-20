'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { SOLO_KEY, sharesWindow, windowKeyFor, successorFor } = require('../src/buddy-mode');

test('every session lands in the same window, without losing whose it is', () => {
  assert.equal(sharesWindow('abc-123'), true);
  assert.equal(windowKeyFor('abc-123'), SOLO_KEY);
  assert.equal(windowKeyFor('def-456'), SOLO_KEY);
  // The key still says which session an event is *about*; only the window it
  // arrives in changed.
  assert.notEqual(SOLO_KEY, 'abc-123');
});

test('a session Clippy started shares the window like any other', () => {
  for (const key of ['tmux:clippy-app-1', 'drive', 'abc-123']) {
    assert.equal(windowKeyFor(key), SOLO_KEY, key);
  }
});

test('the sandbox never collapses, because comparing buddies is what it is for', () => {
  assert.equal(sharesWindow('sandbox:idle'), false);
  assert.equal(windowKeyFor('sandbox:idle'), 'sandbox:idle');
  assert.equal(windowKeyFor('sandbox:approval-bash'), 'sandbox:approval-bash');
});

test('an empty key is nobody', () => {
  assert.equal(sharesWindow(''), false);
  assert.equal(sharesWindow(null), false);
  assert.equal(sharesWindow(undefined), false);
  assert.equal(windowKeyFor(''), '');
});

const session = (sessionId, status = 'idle') => ({ sessionId, status, name: sessionId });

test('when a session ends, the shared window moves to whoever still needs you', () => {
  const sessions = [session('a', 'idle'), session('b', 'needs_permission'), session('c', 'working')];

  // Not simply "the next one": a window that can only show one agent should
  // show the one that is blocked.
  assert.equal(successorFor(sessions, 'a').sessionId, 'b');
  assert.equal(successorFor([session('a'), session('c', 'working')], 'a').sessionId, 'c');
  assert.equal(successorFor([session('a'), session('b', 'waiting')], 'a').sessionId, 'b');
});

test('the window only goes when the last session does', () => {
  assert.equal(successorFor([session('a')], 'a'), null);
  assert.equal(successorFor([], 'a'), null);
  assert.equal(successorFor(null, 'a'), null);
  // The one that ended is never its own successor, even if the tracker is slow
  // to forget it.
  assert.equal(successorFor([session('a'), session('a')], 'a'), null);
});

test('junk in the session list cannot become the face on screen', () => {
  assert.equal(successorFor([null, undefined, {}, session('b')], 'a').sessionId, 'b');
  assert.equal(successorFor([null, {}], 'a'), null);
});
