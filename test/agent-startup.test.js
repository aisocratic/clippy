'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { paneStartupState, prepareAgentWorkspace } = require('../src/agent-startup');

test('Claude startup panes distinguish trust, input, and loading screens', () => {
  assert.equal(paneStartupState('1. Yes, I trust this folder'), 'trust');
  assert.equal(paneStartupState('header\n❯\u00a0\nfooter'), 'ready');
  assert.equal(paneStartupState('OpenAI Codex\n› Write tests for @filename'), 'ready');
  assert.equal(
    paneStartupState('Hooks need review\n3. Continue without trusting (hooks won\'t run)'),
    'hooks'
  );
  assert.equal(paneStartupState('How is Claude doing this session?\n1: Bad  0: Dismiss'), 'survey');
  assert.equal(paneStartupState('Starting Claude Code…'), 'starting');
});

test('a Clippy-owned workspace confirms trust once and waits for the real prompt', async () => {
  const panes = ['Starting…', 'Yes, I trust this folder', 'Yes, I trust this folder', 'Claude\n❯ \n'];
  let confirms = 0;
  let delays = 0;
  const result = await prepareAgentWorkspace({
    capture: async () => panes.shift(),
    confirmTrust: async () => confirms++,
    continueWithoutHooks: async () => assert.fail('Claude did not show a hook review'),
    dismissSurvey: async () => assert.fail('Claude did not show a survey'),
    delay: async () => delays++,
    attempts: 6,
  });

  assert.deepEqual(result, { ready: true, confirmed: true });
  assert.equal(confirms, 1);
  assert.equal(delays, 3);
});

test('startup readiness has a bounded wait when no prompt appears', async () => {
  let looks = 0;
  const result = await prepareAgentWorkspace({
    capture: async () => (looks++, ''),
    confirmTrust: async () => assert.fail('nothing asked for confirmation'),
    continueWithoutHooks: async () => assert.fail('nothing asked about hooks'),
    dismissSurvey: async () => assert.fail('nothing asked about a survey'),
    delay: async () => {},
    attempts: 3,
  });

  assert.deepEqual(result, { ready: false, confirmed: false });
  assert.equal(looks, 3);
});

test('Codex hook review continues without granting changed hooks', async () => {
  const panes = [
    'Do you trust the contents of this directory?\n1. Yes, continue',
    'Hooks need review\n3. Continue without trusting (hooks won\'t run)',
    'OpenAI Codex\n› Write tests for @filename',
  ];
  let confirms = 0;
  let skips = 0;
  const result = await prepareAgentWorkspace({
    capture: async () => panes.shift(),
    confirmTrust: async () => confirms++,
    continueWithoutHooks: async () => skips++,
    dismissSurvey: async () => assert.fail('Codex did not show a survey'),
    delay: async () => {},
    attempts: 5,
  });

  assert.deepEqual(result, { ready: true, confirmed: true });
  assert.equal(confirms, 1);
  assert.equal(skips, 1);
});

test('Claude feedback survey is dismissed before the composer is considered ready', async () => {
  const panes = [
    'How is Claude doing this session?\n1: Bad  2: Fine  3: Good  0: Dismiss\n────\n❯\u00a0\n────',
    'Claude\n────\n❯\u00a0\n────',
  ];
  let dismisses = 0;
  const result = await prepareAgentWorkspace({
    capture: async () => panes.shift(),
    confirmTrust: async () => assert.fail('already trusted'),
    continueWithoutHooks: async () => assert.fail('no hook review'),
    dismissSurvey: async () => dismisses++,
    delay: async () => {},
    attempts: 3,
  });

  assert.deepEqual(result, { ready: true, confirmed: false });
  assert.equal(dismisses, 1);
});
