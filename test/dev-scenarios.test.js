'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { DEV_SCENARIOS, eventsFor, stampEvent, storyList } = require('../src/dev-scenarios');

// The storybook is only worth anything if every button does something, and a
// story that quietly loses its events looks exactly like a state that works.
test('every story is complete enough to fire', () => {
  const ids = new Set();
  for (const story of DEV_SCENARIOS) {
    const where = story.id || '(no id)';
    assert.ok(story.id && !ids.has(story.id), `${where}: ids must exist and be unique`);
    ids.add(story.id);
    assert.ok(story.label, `${where}: needs a label for its button`);
    assert.ok(Array.isArray(story.events) && story.events.length > 0, `${where}: needs events`);
    for (const event of story.events) {
      assert.ok(event.kind, `${where}: every event needs a kind the renderer switches on`);
      assert.ok(event.sessionId, `${where}: every event needs a session to arrive at`);
    }
  }
});

test('a held card is stamped with a deadline at fire time', () => {
  const now = 1_700_000_000_000;
  const [card] = eventsFor('approval', now);
  assert.equal(card.kind, 'approval');
  assert.ok(card.requestId, 'a held card needs an id to answer against');
  assert.equal(card.expiresAt, now + 60_000);
  assert.ok(!('holdSecs' in card), 'holdSecs is the recipe, expiresAt is what is sent');
});

test('an ambient event is sent as-is', () => {
  const event = stampEvent({ kind: 'activity', sessionId: 'dev:story' }, 1);
  assert.deepEqual(event, { kind: 'activity', sessionId: 'dev:story' });
});

test('an unknown story fires nothing', () => {
  assert.deepEqual(eventsFor('no-such-story'), []);
});

test('the button list carries what the window draws', () => {
  assert.equal(storyList().length, DEV_SCENARIOS.length);
  for (const story of storyList()) {
    assert.ok(story.id && story.label && story.group);
  }
});
