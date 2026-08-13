'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  SOLO_KEY,
  normalize,
  sharesWindow,
  windowKeyFor,
  successorFor,
} = require('../src/buddy-mode');

test('a buddy each is what happens unless someone asked otherwise', () => {
  // Every unknown value has to land on today's behaviour: a settings file from
  // an older build, or a hand-edited one, must not collapse anyone's desk.
  for (const mode of ['each', undefined, null, '', 'ONE', 'both', 0, {}]) {
    assert.equal(normalize(mode), 'each', String(mode));
    assert.equal(sharesWindow(mode, 'abc-123'), false, String(mode));
    assert.equal(windowKeyFor(mode, 'abc-123'), 'abc-123', String(mode));
  }
});

test('one mode puts every session in the same window, without losing whose it is', () => {
  assert.equal(normalize('one'), 'one');
  assert.equal(windowKeyFor('one', 'abc-123'), SOLO_KEY);
  assert.equal(windowKeyFor('one', 'def-456'), SOLO_KEY);
  // The key still says which session an event is *about*; only the window it
  // arrives in changed.
  assert.notEqual(SOLO_KEY, 'abc-123');
});

test('a session Clippy started shares the window like any other', () => {
  for (const key of ['tmux:clippy-app-1', 'drive', 'abc-123']) {
    assert.equal(windowKeyFor('one', key), SOLO_KEY, key);
  }
});

test('the sandbox never collapses, because comparing buddies is what it is for', () => {
  assert.equal(sharesWindow('one', 'sandbox:idle'), false);
  assert.equal(windowKeyFor('one', 'sandbox:idle'), 'sandbox:idle');
  assert.equal(windowKeyFor('one', 'sandbox:approval-bash'), 'sandbox:approval-bash');
});

test('an empty key is nobody, in either mode', () => {
  assert.equal(sharesWindow('one', ''), false);
  assert.equal(sharesWindow('one', null), false);
  assert.equal(windowKeyFor('one', ''), '');
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
