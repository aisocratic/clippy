'use strict';

/**
 * Clippy stays until you put it away.
 *
 * Two halves, neither of which a unit can hold alone. In main, an ambient
 * event from one agent must not put away what another agent is asking on the
 * shared window. In the renderer, a click somewhere else on the screen never
 * hides Clippy: losing focus only folds an open panel. Only the card's ✕, the
 * menu's Hide, the tray, or an answered card puts him away. Source assertions,
 * in the style of main-hardening.test.js: they fail on the line that undoes
 * the behaviour.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const main = read('src', 'main.js');
const renderer = read('src', 'renderer', 'clippy.js');
const preload = read('src', 'preload.js');
const demo = read('demo', 'stub-api.js');

test('ambient chatter cannot hide a window that still has business on it', () => {
  const hide = main.slice(main.indexOf('function hideBuddy('));
  const body = hide.slice(0, hide.indexOf('\n}\n'));
  // The old check asked only about this session's held hooks; every session
  // shares the window, so the question is about the window.
  assert.doesNotMatch(body, /broker\.hasPending\(key\)/);
  assert.match(body, /if \(windowHasBusiness\(key\)\) return;/);
  // No back door around that guard for a click elsewhere.
  assert.doesNotMatch(body, /lookedAway/);

  const business = main.slice(main.indexOf('function windowHasBusiness('));
  const businessBody = business.slice(0, business.indexOf('\n}\n'));
  assert.match(businessBody, /buddyStillHasCards\(sessionId\)/, 'held cards and reviews');
  assert.match(businessBody, /item\.state === 'clippy'/, 'nudges shown here, not ones handed to the terminal');
});

test('a click somewhere else never hides Clippy', () => {
  // The blur handler is the one place a click elsewhere reaches the renderer,
  // and all it may do is park an open panel.
  const blur = renderer.slice(renderer.indexOf("window.addEventListener('blur'"));
  const handler = blur.slice(0, blur.indexOf(';') + 1);
  assert.strictEqual(handler, "window.addEventListener('blur', parkPanels);");
  assert.doesNotMatch(renderer, /clippyAPI\.hide\(\{ lookedAway/);
  assert.doesNotMatch(renderer, /\bengaged\b/);
  assert.doesNotMatch(renderer, /holdingDecision/);

  // The explicit closers are what remain: the menu's Hide and the card's ✕.
  // The ✕ answers every card through a decision — main resolves it and puts
  // the buddy away — rather than hiding the window from the renderer itself.
  assert.match(renderer, /onAction\('btn-hide', \(\) => window\.clippyAPI\.hide\(\)\)/);
  const cardX = renderer.slice(renderer.indexOf("btnCardX.addEventListener('click'"));
  const cardXBody = cardX.slice(0, cardX.indexOf('\n});') + 4);
  assert.match(cardXBody, /if \(req\.type === 'review'\) return decide\('ok'\);/);
  assert.match(cardXBody, /decide\(req\.type === 'answer' \? 'dismiss' : 'pass'\);/);
  assert.doesNotMatch(cardXBody, /clippyAPI\.hide\(/);
});

test('the Hide button drops a perch or pin', () => {
  assert.match(preload, /hide: \(\) => ipcRenderer\.send\('clippy-hide'\)/);
  assert.doesNotMatch(preload, /lookedAway/);
  assert.doesNotMatch(demo, /lookedAway/);
  const ipc = main.slice(main.indexOf("ipcMain.on('clippy-hide'"));
  const handler = ipc.slice(0, ipc.indexOf('\n  });') + 6);
  assert.match(handler, /hideBuddy\(buddy\.sessionId, \{ unpin: true \}\)/);
  assert.doesNotMatch(handler, /lookedAway/);
  // The ambient path still shrinks a pinned or hand-perched buddy to compact
  // rather than making him vanish.
  const hide = main.slice(main.indexOf('function hideBuddy('));
  assert.match(hide.slice(0, 1200), /if \(buddy\.pinned\) \{\s*placeBuddy\(buddy, 'compact'\)/);
});
