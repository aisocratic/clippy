'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { describeSource, guiHostFor } = require('../src/source-app');
const { TERMINAL_APP, ITERM_APP } = require('../src/terminal');

test('a terminal is called by its own name, not "terminal"', () => {
  const ghostty = describeSource({ program: 'ghostty', app: { name: 'Ghostty', pid: 1 } });
  assert.equal(ghostty.kind, 'terminal');
  assert.equal(ghostty.name, 'Ghostty');
  assert.equal(ghostty.goLabel, 'go to Ghostty ↗');
  assert.equal(ghostty.known, true);
});

test('the two terminals with no app ancestor are named from TERM_PROGRAM', () => {
  // terminal.js never resolves an app for these — it drives them by name — so
  // the only thing to name them from is the header the hook sent.
  assert.equal(describeSource({ program: TERMINAL_APP }).name, 'Terminal');
  assert.equal(describeSource({ program: ITERM_APP }).name, 'iTerm');
  assert.equal(describeSource({ program: ITERM_APP }).goLabel, 'go to iTerm ↗');
});

test('the ChatGPT app and the Codex app are one app, and it is not a terminal', () => {
  // ChatGPT.app ships as com.openai.codex. Treating them as two entries would
  // mean a session in the Dock's ChatGPT icon reads as an app nobody has.
  const byBundle = describeSource({ app: { name: 'ChatGPT', bundleId: 'com.openai.codex' } });
  assert.equal(byBundle.kind, 'app');
  assert.equal(byBundle.name, 'ChatGPT');
  assert.equal(byBundle.goLabel, 'go to ChatGPT ↗');
  assert.equal(byBundle.label, 'the ChatGPT app');

  // A build whose bundle id we have not seen still resolves by name.
  assert.equal(describeSource({ app: { name: 'Codex' } }).name, 'ChatGPT');
});

test('Claude Cowork is Claude, because that is the window it lives in', () => {
  // Cowork is not a separate app — it runs inside Claude.app, so "go to Claude"
  // is where the prompt actually is.
  for (const name of ['Claude', 'Cowork', 'Claude Cowork']) {
    assert.equal(describeSource({ app: { name } }).name, 'Claude', name);
  }
  assert.equal(
    describeSource({ app: { bundleId: 'com.anthropic.claudefordesktop', name: 'Claude' } }).kind,
    'app'
  );
});

test('ChatGPT Atlas is its own host', () => {
  assert.equal(describeSource({ app: { bundleId: 'com.openai.atlas', name: 'ChatGPT Atlas' } }).name, 'ChatGPT Atlas');
});

test('a session Clippy started has no window to go to — you attach one', () => {
  const local = describeSource({ tmux: { name: 'clippy-app-1' } });
  assert.equal(local.kind, 'tmux');
  assert.equal(local.goLabel, 'attach a terminal ↗');
  assert.match(local.label, /tmux/);

  const remote = describeSource({ tmux: { name: 'clippy-app-1', host: 'box' } });
  assert.match(remote.name, /box/);
  assert.match(remote.label, /on box/);
});

test('tmux wins over whatever app happens to be up the process tree', () => {
  // A pane Clippy started descends from whichever terminal Clippy itself was
  // launched from, and that window has nothing to do with the agent.
  const both = describeSource({
    tmux: { name: 'clippy-app-1' },
    app: { name: 'Ghostty', pid: 1 },
    program: 'ghostty',
  });
  assert.equal(both.kind, 'tmux');
});

test('knowing nothing still offers the button, in the old words', () => {
  // The raise path re-resolves from scratch, so it often works anyway — this is
  // wording, not a capability check.
  const unknown = describeSource();
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.goLabel, 'go to terminal ↗');
  assert.equal(unknown.known, false);
  assert.equal(unknown.name, '');
});

test('an app that is only a terminal is never mistaken for an agent host', () => {
  assert.equal(guiHostFor({ name: 'Ghostty' }), null);
  assert.equal(guiHostFor({ name: 'Terminal' }), null);
  assert.equal(guiHostFor(null), null);
  assert.equal(guiHostFor({}), null);
});
