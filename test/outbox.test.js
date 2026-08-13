'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createOutbox } = require('../src/outbox');

const spy = () => {
  const sent = [];
  const send = (channel, payload) => sent.push([channel, payload]);
  return { sent, send };
};

test('the first card of a session is not lost to a page that is still loading', () => {
  // The bug this exists for: a window is created and told about a held approval
  // in the same tick, the renderer has not run its ipcRenderer.on yet, and the
  // card simply never appears while the agent holds its hook open for minutes.
  const { sent, send } = spy();
  const out = createOutbox({ send });

  out.post('clippy-event', { kind: 'approval', id: 1 });
  assert.deepEqual(sent, [], 'nothing goes to a renderer that is not listening');
  assert.equal(out.waiting, 1);

  out.open();
  assert.deepEqual(sent, [['clippy-event', { kind: 'approval', id: 1 }]]);
  assert.equal(out.waiting, 0);
});

test('what was said first is heard first', () => {
  // Identity before artwork, colour before sprite: several pushes only make
  // sense in the order they were written.
  const { sent, send } = spy();
  const out = createOutbox({ send });
  out.post('clippy-identity', { name: 'a' });
  out.post('clippy-settings', { size: 'medium' });
  out.post('clippy-event', { kind: 'approval' });
  out.open();
  assert.deepEqual(sent.map(([, p]) => p.name || p.size || p.kind), ['a', 'medium', 'approval']);
});

test('once the page is listening, nothing is held back', () => {
  const { sent, send } = spy();
  const out = createOutbox({ send });
  out.open();
  out.post('clippy-event', { kind: 'review' });
  assert.equal(sent.length, 1);
  assert.equal(out.waiting, 0);
  assert.equal(out.isOpen, true);
});

test('a page that never loads is not a memory leak', () => {
  const { sent, send } = spy();
  const dropped = [];
  const out = createOutbox({ send, cap: 3, onDrop: (n) => dropped.push(n) });
  for (let i = 0; i < 6; i++) out.post('clippy-event', { i });

  assert.equal(out.waiting, 3);
  out.open();
  // The newest survive: the latest state is the one worth replaying, and
  // nobody wants six cards arriving at once anyway.
  assert.deepEqual(sent.map(([, p]) => p.i), [3, 4, 5]);
  assert.deepEqual(dropped, [1, 1, 1]);
});

test('a reload puts the queue back, rather than talking to a dying renderer', () => {
  const { sent, send } = spy();
  const out = createOutbox({ send });
  out.open();
  out.post('clippy-event', { kind: 'one' });

  out.close();
  out.post('clippy-event', { kind: 'two' });
  assert.equal(sent.length, 1, 'nothing goes to the page on its way out');

  out.open();
  assert.deepEqual(sent.map(([, p]) => p.kind), ['one', 'two']);
});

test('post says whether it went straight out', () => {
  // The caller sometimes needs to know: a sound played on arrival is worth
  // nothing if the arrival is replayed a second later.
  const { send } = spy();
  const out = createOutbox({ send });
  assert.equal(out.post('clippy-event', {}), false);
  out.open();
  assert.equal(out.post('clippy-event', {}), true);
});

test('opening twice does not send anything twice', () => {
  const { sent, send } = spy();
  const out = createOutbox({ send });
  out.post('clippy-event', { kind: 'once' });
  assert.equal(out.open(), 1);
  assert.equal(out.open(), 0);
  assert.equal(sent.length, 1);
});
