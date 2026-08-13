'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { routingPrompt, parseChoice, routable, proposalText } = require('../src/delegate');

const ROSTER = [
  { sessionId: 'a', name: 'billing-api', agent: 'claude', cwd: '/Users/me/work/billing-api', status: 'working', reachable: true },
  { sessionId: 'b', name: 'api', agent: 'codex', cwd: '/Users/me/side/api', status: 'idle', reachable: true },
  { sessionId: 'c', name: 'ghost', agent: 'claude', cwd: '/Users/me/old/ghost', reachable: false },
];

test('an agent with nowhere to type is never a candidate', () => {
  // "Sent" would be a lie: no window, no tmux pane, nothing to type into.
  assert.deepEqual(routable(ROSTER).map((a) => a.sessionId), ['a', 'b']);
  assert.ok(!routingPrompt(ROSTER, 'anything').includes('ghost'));
});

test('the roster is offered as numbers, with what tells two of them apart', () => {
  const prompt = routingPrompt(ROSTER, 'the tests are failing');
  // Numbered, not named: "api" matches two sessions, "2" matches one row.
  assert.match(prompt, /1\. billing-api — claude in ~\/work\/billing-api, currently working/);
  assert.match(prompt, /2\. api — codex in ~\/side\/api/);
  assert.match(prompt, /the tests are failing/);
  // "none" has to be offered, and described as safe, or a model handed only
  // good options will always pick one of them.
  assert.match(prompt, /or the word none/);
  assert.match(prompt, /cannot be taken back/);
});

test('a chosen row becomes that agent', () => {
  assert.equal(parseChoice('1. it mentions billing', ROSTER).agent.sessionId, 'a');
  assert.equal(parseChoice('2', ROSTER).agent.sessionId, 'b');
  assert.equal(parseChoice('#2 the side project', ROSTER).agent.sessionId, 'b');
  assert.match(parseChoice('1 it mentions billing', ROSTER).why, /it mentions billing/);
});

test('anything but a plain choice means "ask them"', () => {
  // The cheap failure is a question. The expensive one is a prompt landing in
  // somebody else's repository, so everything unclear takes the cheap one.
  for (const reply of [
    'none — this is small talk',
    'none',
    '',
    'I think maybe billing-api?',
    'it could be either 1 or 2',
    'Sure! Let me help you with that.',
  ]) {
    assert.equal(parseChoice(reply, ROSTER).agent, null, reply);
  }
});

test('a row that does not exist is not a choice', () => {
  // The model inventing a fourth agent must not index past the end, and must
  // not wrap round to a real one.
  assert.equal(parseChoice('4', ROSTER).agent, null);
  assert.equal(parseChoice('0', ROSTER).agent, null);
  assert.equal(parseChoice('99 the other one', ROSTER).agent, null);
  // Numbering follows the *routable* list, so an unreachable agent can never
  // be reached by counting.
  assert.equal(parseChoice('3', ROSTER).agent, null);
});

test('a number buried in a sentence is not a choice either', () => {
  // "2" in the middle of prose is as likely to be a count or a version.
  assert.equal(parseChoice('this looks like a job for python 2 honestly', ROSTER).agent, null);
});

test('with nobody to route to, nothing can be chosen', () => {
  assert.equal(parseChoice('1', []).agent, null);
  assert.equal(parseChoice('1', [{ sessionId: 'x', name: 'x', reachable: false }]).agent, null);
});

test('the proposal names who, and why when there is a why', () => {
  assert.equal(proposalText({ name: 'billing-api' }, 'it mentions billing'), 'Sounds like billing-api — it mentions billing');
  assert.equal(proposalText({ name: 'billing-api' }, ''), 'Sounds like billing-api.');
});
