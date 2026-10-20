'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { deedFor, reviewArrivalDeed, recordDeed, headlineOf } = require('../src/renderer/deeds');

const review = {
  id: 'review-1',
  type: 'review',
  name: 'clippy',
  title: 'Claude finished: “Parser fixed; tests pass.”',
  detail: 'Parser fixed; tests pass.\n\nI also tidied the error messages.',
};

test('signing off a finished-turn card replaces its arrival entry: one chip per turn', () => {
  // The card arriving wrote "finished: X"; signing it off used to add a second
  // chip, "signed off the last turn", about the very same turn.
  const arrived = reviewArrivalDeed({ requestId: 'review-1', name: 'clippy', message: review.title, detail: review.detail });
  let log = recordDeed([], { ...arrived, who: 'clippy', at: 1, count: 1 });
  const signed = deedFor('ok', review);
  log = recordDeed(log, { ...signed, who: 'clippy', at: 2, count: 1 });

  assert.equal(log.length, 1);
  assert.equal(log[0].text, 'signed off: “Parser fixed; tests pass.”');
  assert.equal(log[0].key, 'review:review-1');
});

test('the same words twice in a row fold into one entry with a count', () => {
  const one = { text: 'signed off a turn that ended without a message', who: 'clippy', at: 1, count: 1 };
  let log = recordDeed([], one);
  log = recordDeed(log, { ...one, at: 2 });
  assert.equal(log.length, 1);
  assert.equal(log[0].count, 2);
  assert.equal(log[0].at, 2);
  // …but not across a different agent: whose it was is part of what it says.
  log = recordDeed(log, { ...one, who: 'codex', at: 3 });
  assert.equal(log.length, 2);
});

test('different turns stay different entries', () => {
  let log = recordDeed([], { key: 'review:review-1', text: 'signed off: “X”', who: 'clippy', at: 1 });
  log = recordDeed(log, { key: 'review:review-2', text: 'signed off: “Y”', who: 'clippy', at: 2 });
  assert.deepEqual(
    log.map((d) => d.text),
    ['signed off: “Y”', 'signed off: “X”']
  );
});

test('the log never grows past what it keeps', () => {
  let log = [];
  for (let i = 0; i < 5; i++) log = recordDeed(log, { text: `allowed step ${i}`, who: '', at: i }, { kept: 3 });
  assert.equal(log.length, 3);
  assert.equal(log[0].text, 'allowed step 4');
});

test('a signed-off turn says what it ended with, and its page says what happened', () => {
  const deed = deedFor('ok', { ...review, prompt: 'fix the parser' });
  assert.equal(deed.text, 'signed off: “Parser fixed; tests pass.”');
  assert.equal(deed.key, 'review:review-1');
  assert.match(deed.detail, /clippy finished a turn and you signed it off/);
  assert.match(deed.detail, /You asked:\nfix the parser/);
  assert.match(deed.detail, /It said:\nParser fixed; tests pass\./);
  assert.match(deed.detail, /tidied the error messages/);
  // No prompt known: the page simply does not claim one.
  assert.doesNotMatch(deedFor('ok', review).detail, /You asked/);
});

test('a one-line recap arrives quoted in the card title; the headline reads it from there', () => {
  const short = { id: 'review-2', type: 'review', name: 'clippy', title: 'Claude finished: “Done.”', detail: '' };
  assert.equal(headlineOf(short), 'Done.');
  assert.equal(deedFor('ok', short).text, 'signed off: “Done.”');
  assert.equal(reviewArrivalDeed({ requestId: 'review-2', message: short.title }).text, 'finished: Done.');
});

test('a turn that ended on a tool call is named honestly rather than as an empty quote', () => {
  const bare = {
    id: 'review-3',
    type: 'review',
    name: 'clippy',
    title: 'Claude finished in “myproject”. Looks good, or should it keep going?',
    detail: '',
  };
  assert.equal(headlineOf(bare), '');
  const deed = deedFor('ok', bare);
  assert.equal(deed.text, 'signed off a turn that ended without a message');
  assert.match(deed.detail, /ended on a tool call/);
  assert.equal(reviewArrivalDeed({ requestId: 'review-3', message: bare.title }).text, 'finished a turn');
});

test('feedback on a turn keeps what you said on its page', () => {
  const deed = deedFor('feedback', review, 'also fix the tests');
  assert.equal(deed.text, 'sent feedback on: “Parser fixed; tests pass.”');
  assert.match(deed.detail, /You said:\nalso fix the tests/);
});

test('long headlines are clipped for the chip', () => {
  const long = 'x'.repeat(200);
  const text = deedFor('ok', { ...review, detail: long }).text;
  assert.ok(text.length < 90, text);
  assert.match(text, /…”$/);
});

test('every other card keeps its plain words', () => {
  assert.deepEqual(deedFor('allow', { type: 'approval', title: 'Bash: npm test' }), {
    key: '',
    text: 'allowed Bash: npm test',
    detail: '',
  });
  assert.equal(deedFor('deny', { type: 'approval' }).text, 'denied a request');
  assert.equal(deedFor('answer', { type: 'answer', title: 'Which one?' }).text, 'answered Which one?');
});
