'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { SessionTracker, noteStatus, HISTORY_MS } = require('../src/sessions');
const { stripSpans, describeStrip, stripPlace, stripDuration, STRIP_DAY_MS } = require('../src/renderer/activity-strip');

const H = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 27, 12);
const at = (hoursAgo) => NOW - hoursAgo * H;

test('a session keeps a history of its status, one entry per change', () => {
  const t = new SessionTracker();
  const p = { session_id: 's1', cwd: '/tmp/app' };
  t.handle('SessionStart', null, p);
  t.handle('UserPromptSubmit', null, p);
  t.handle('PreToolUse', null, { ...p, tool_name: 'Bash', tool_input: { command: 'ls' } });
  t.handle('PostToolUse', null, { ...p, tool_name: 'Bash' });
  t.handle('PermissionRequest', null, p);
  t.setStatus('s1', 'working'); // the user answered from Clippy
  t.handle('Stop', null, p);
  assert.deepEqual(
    t.list()[0].history.map((h) => h.status),
    ['idle', 'working', 'needs_permission', 'working', 'waiting']
  );
  // A copy: what a window holds cannot change the tracker's.
  t.list()[0].history.pop();
  assert.equal(t.list()[0].history.length, 5);
  t.handle('SessionEnd', null, p);
  assert.equal(t.list().length, 0);
});

test('history older than a day goes, but what the day began with stays', () => {
  const history = [];
  noteStatus(history, 'working', at(30));
  noteStatus(history, 'waiting', at(26));
  noteStatus(history, 'working', at(10));
  noteStatus(history, 'working', at(9)); // no change, no entry
  noteStatus(history, 'waiting', NOW);
  // 30h ago is gone; 26h ago stays, because it says the window opened on "waiting".
  assert.deepEqual(history, [
    { status: 'waiting', at: at(26) },
    { status: 'working', at: at(10) },
    { status: 'waiting', at: NOW },
  ]);
  assert.equal(HISTORY_MS, STRIP_DAY_MS);
});

test('spans are clipped to the day, idle is left out, and a run of one state is one span', () => {
  const spans = stripSpans(
    [
      { status: 'waiting', at: at(26) },
      { status: 'idle', at: at(20) },
      { status: 'working', at: at(10) },
      { status: 'needs_permission', at: at(9) },
      { status: 'working', at: at(8.5) },
      { status: 'working', at: at(8) }, // the same state again: drawn once
      { status: 'waiting', at: at(2) },
    ],
    NOW
  );
  assert.deepEqual(spans, [
    { state: 'done', from: at(24), to: at(20), open: false },
    { state: 'working', from: at(10), to: at(9), open: false },
    { state: 'waiting', from: at(9), to: at(8.5), open: false },
    { state: 'working', from: at(8.5), to: at(2), open: false },
    { state: 'done', from: at(2), to: NOW, open: true },
  ]);
  assert.equal(describeStrip(spans), '7h 30m working · 30m waiting on you · 6h 00m done');
  assert.equal(describeStrip(stripSpans([], NOW)), '');
  assert.equal(describeStrip(stripSpans([{ status: 'idle', at: at(3) }], NOW)), '');
});

test('what a session is doing now shows, even if it only just began', () => {
  const spans = stripSpans([{ status: 'idle', at: at(1) }, { status: 'working', at: NOW }], NOW);
  assert.deepEqual(spans, [{ state: 'working', from: NOW, to: NOW, open: true }]);
  // …a sliver wide, drawn back from the right edge rather than off it.
  const { left, width } = stripPlace(spans[0], NOW);
  assert.ok(width > 0);
  assert.equal(left + width, 100);
});

test('a span sits where its hours are on the strip', () => {
  const { left, width } = stripPlace({ from: at(12), to: at(6) }, NOW);
  assert.equal(left, 50);
  assert.equal(width, 25);
  assert.equal(stripDuration(59 * 1000), '<1m');
  assert.equal(stripDuration(125 * 60 * 1000), '2h 05m');
});
