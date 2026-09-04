'use strict';

/**
 * Clippy stays until you have dealt with it.
 *
 * Two halves, neither of which a unit can hold alone. In main, an ambient
 * event from one agent must not put away what another agent is asking on the
 * shared window. In the renderer, a click somewhere else on the screen only
 * hides Clippy once the user has clicked Clippy — before that, it is them
 * doing something else, not a dismissal. Source assertions, in the style of
 * main-hardening.test.js: they fail on the line that undoes the behaviour.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const main = read('src', 'main.js');
const renderer = read('src', 'renderer', 'clippy.js');
const preload = read('src', 'preload.js');

test('ambient chatter cannot hide a window that still has business on it', () => {
  const hide = main.slice(main.indexOf('function hideBuddy('));
  const body = hide.slice(0, hide.indexOf('\n}\n'));
  // The old check asked only about this session's held hooks; every session
  // shares the window, so the question is about the window.
  assert.doesNotMatch(body, /broker\.hasPending\(key\)/);
  assert.match(body, /if \(!lookedAway && windowHasBusiness\(key\)\) return;/);

  const business = main.slice(main.indexOf('function windowHasBusiness('));
  const businessBody = business.slice(0, business.indexOf('\n}\n'));
  assert.match(businessBody, /buddyStillHasCards\(sessionId\)/, 'held cards and reviews');
  assert.match(businessBody, /item\.state === 'clippy'/, 'nudges shown here, not ones handed to the terminal');
});

test('looking away hides only after a click on Clippy, and never a held decision', () => {
  // The blur handler is the one place a click elsewhere reaches the renderer.
  const blur = renderer.slice(renderer.indexOf("window.addEventListener('blur'"));
  const handler = blur.slice(0, blur.indexOf('});') + 3);
  assert.match(handler, /parkPanels\(\)/, 'panels still step aside');
  assert.match(handler, /if \(!engaged \|\| document\.hidden \|\| holdingDecision\(\)\) return;/);
  assert.match(handler, /window\.clippyAPI\.hide\(\{ lookedAway: true \}\)/);

  // Engagement is any press on the window, and is forgotten each time Clippy
  // has something new to show or is shown again.
  assert.match(renderer, /engaged = true;/);
  assert.match(renderer, /if \(APPEARS_FOR\.has\(evt\.kind\)\) engaged = false;/);
  assert.match(renderer, /if \(!document\.hidden\) engaged = false;/);

  const holding = renderer.slice(renderer.indexOf('const holdingDecision = '));
  assert.match(holding.slice(0, 200), /req\.type === 'approval' \|\| req\.type === 'answer'/);
});

test('a look-away hide keeps a perch or pin; the Hide button drops them', () => {
  assert.match(preload, /hide: \(opts\) => ipcRenderer\.send\('clippy-hide', opts && opts\.lookedAway \? \{ lookedAway: true \} : null\)/);
  const ipc = main.slice(main.indexOf("ipcMain.on('clippy-hide'"));
  const handler = ipc.slice(0, ipc.indexOf('\n  });') + 6);
  assert.match(handler, /opts\.lookedAway === true\) hideBuddy\(buddy\.sessionId, \{ lookedAway: true \}\)/);
  assert.match(handler, /else hideBuddy\(buddy\.sessionId, \{ unpin: true \}\)/);
  // With lookedAway the normal path runs: pinned or hand-perched shrinks to
  // compact rather than vanishing, exactly as before.
  const hide = main.slice(main.indexOf('function hideBuddy('));
  assert.match(hide.slice(0, 1200), /if \(buddy\.pinned\) \{\s*placeBuddy\(buddy, 'compact'\)/);
});
