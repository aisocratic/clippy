'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { chatWorkspace, ensureChatWorkspace } = require('../src/workspace');

test('chat sessions use a dedicated folder directly under home', () => {
  assert.equal(chatWorkspace('/Users/me'), '/Users/me/Clippy');
});

test('the chat folder is created privately and only when it is needed', () => {
  const calls = [];
  const dir = ensureChatWorkspace('/Users/me', {
    mkdirSync: (...args) => calls.push(args),
  });

  assert.equal(dir, '/Users/me/Clippy');
  assert.deepEqual(calls, [['/Users/me/Clippy', { recursive: true, mode: 0o700 }]]);
});
