'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { avatarForCharacter, sessionBanner, sessionBannerOutput } = require('../src/session-banner');

test('the session banner identifies the exact buddy, project, agent, and model', () => {
  const message = sessionBanner({
    character: 'fox',
    label: 'Fox',
    project: 'clippy',
    agent: 'Codex',
    model: 'gpt-5.6-codex',
  });

  assert.equal(
    message,
    '🦊 Connected to Fox — look for Fox watching “clippy” — Codex · gpt-5.6-codex'
  );
  assert.deepEqual(sessionBannerOutput({ character: 'clip', label: 'Clippy' }), {
    systemMessage: '📎 Connected to Clippy — look for Clippy',
  });
});

test('custom buddy names get a recognizable terminal avatar', () => {
  assert.equal(avatarForCharacter('foxbow', 'Foxbow'), '🦊');
  assert.equal(avatarForCharacter('miso', 'Miso'), '🐈');
  assert.equal(avatarForCharacter('unknown', 'Anything'), '📎');
});
