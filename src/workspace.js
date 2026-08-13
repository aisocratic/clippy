'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CHAT_WORKSPACE_NAME = 'Clippy';

/** A quiet, persistent place for conversations that are not about a project. */
function chatWorkspace(home) {
  return path.join(home, CHAT_WORKSPACE_NAME);
}

/** Create the chat workspace on demand, keeping a fresh one private to its user. */
function ensureChatWorkspace(home, { mkdirSync = fs.mkdirSync } = {}) {
  const dir = chatWorkspace(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

module.exports = { CHAT_WORKSPACE_NAME, chatWorkspace, ensureChatWorkspace };
