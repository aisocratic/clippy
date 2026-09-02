'use strict';

/**
 * Properties of the main process that no unit can hold on its own.
 *
 * main.js is the one file that cannot be required outside Electron, and the
 * things worth defending in it are arrangements rather than functions: what a
 * window is allowed to become, how the settings file is written, which map a
 * key is looked up in. Source assertions are blunt, but they fail on the line
 * that undoes the fix, which is what these are for.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

test('a Clippy window can never become somewhere else', () => {
  // Every window is a local file behind a preload that can approve a
  // permission request, type into a terminal or open a link — and a preload is
  // re-attached on every navigation. A renderer talked into leaving its page
  // (a link in text an agent wrote, a meta refresh in a tool result) would hand
  // that bridge to whatever it landed on. The per-file CSP stops remote
  // sub-resources; it says nothing about the document itself moving.
  const lock = main.slice(main.indexOf('function lockDownNavigation('));
  const body = lock.slice(0, lock.indexOf('\n}\n') + 3);

  assert.match(main, /^lockDownNavigation\(\);$/m, 'the lock has to actually be installed');
  assert.match(body, /app\.on\('web-contents-created'/, 'every window, not the ones we remember');
  assert.match(body, /contents\.on\('will-navigate'/);
  assert.match(body, /contents\.on\('will-frame-navigate'/);
  assert.match(body, /event\.preventDefault\(\)/);
  assert.match(body, /contents\.on\('will-attach-webview', \(event\) => event\.preventDefault\(\)\)/);
  // A window may not open another window; a genuine link goes to the browser
  // through the same https-only path every other link takes.
  assert.match(body, /setWindowOpenHandler/);
  assert.match(body, /action: 'deny'/);
  assert.match(body, /startsWith\('https:\/\/'\)\) shell\.openExternal\(url\)/);
});

test('links only ever leave through https', () => {
  // shell.openExternal hands a string to the OS, which will happily act on
  // file:, x-apple.systempreferences: or anything else registered on the
  // machine. The one place a renderer-supplied URL reaches it is guarded.
  const handler = main.slice(main.indexOf("ipcMain.on('clippy-open-external'"));
  assert.match(handler.slice(0, 500), /typeof url === 'string' && url\.startsWith\('https:\/\/'\)/);

  // …and a sprite pack, which is unpacked into the app's own assets folder.
  const pet = main.slice(main.indexOf("ipcMain.handle('clippy-settings-install-pet'"));
  assert.match(pet.slice(0, 700), /\/\^https:\\\/\\\/\/i\.test\(src\)/);
});

test('the settings file is replaced whole, never written into', () => {
  // A crash or a full disk mid-write left half a JSON document behind, and half
  // a document is unreadable — so the next start silently reverted to defaults
  // and every pet, size and recent project was gone.
  const save = main.slice(main.indexOf('function saveSettings('));
  const body = save.slice(0, save.indexOf('\n}\n') + 3);
  assert.match(body, /const scratch = /);
  assert.match(body, /fs\.writeFileSync\(scratch,/);
  assert.match(body, /fs\.renameSync\(scratch, file\)/);
  assert.ok(
    !/fs\.writeFileSync\(file,/.test(body),
    'the settings file itself is only ever arrived at by rename'
  );
});

test('a session is looked up in the map that is keyed by session', () => {
  // `buddies` is keyed by *window*, and every watched session shares one — so
  // `buddies.has(sessionId)` is false for every real session. Two branches were
  // dead because of it: the retry after Accessibility is granted, and the
  // warning that a spawned agent is sitting on its trust prompt.
  for (const fn of ['function watchForAccess(', 'async function warnIfAwaitingTrust(']) {
    const body = main.slice(main.indexOf(fn), main.indexOf(fn) + 1400);
    assert.ok(
      !/buddies\.has\(key\)/.test(body),
      `${fn} asks the window map for a session key, which never holds one`
    );
    assert.match(body, /buddyOf\(key\)/);
  }
});

test('a session that gets its real id takes its transcript watcher with it', () => {
  // A spawned Codex session lives under `tmux:<name>` until a hook says what it
  // is really called. The watcher is keyed by that name, so one left behind is
  // one nothing can poke and nothing will ever stop — an ssh poll running for
  // the life of the app against a session that has finished.
  const rekey = main.slice(main.indexOf('function rekeyBuddy('));
  const body = rekey.slice(0, rekey.indexOf('\n}\n') + 3);
  const watcherMove = body.indexOf('watchers.set(to, entry)');
  const windowMove = body.indexOf('buddies.get(from)');
  assert.ok(watcherMove > 0 && windowMove > 0);
  assert.ok(
    watcherMove < windowMove,
    'the watcher moves first, and without asking whether a window changed hands'
  );
});

test('a renderer sending nothing does not take the main process with it', () => {
  // An ipcMain.on handler that throws is an uncaught exception in main, and a
  // destructured payload throws on undefined. Every `on` handler that unpacks
  // an object defaults it.
  const handlers = [...main.matchAll(/ipcMain\.on\('([\w-]+)', \([^)]*\{[^)]*\)/g)];
  assert.ok(handlers.length >= 3, 'expected several destructuring on-handlers to check');
  for (const [signature, channel] of handlers) {
    assert.match(signature, /\} = \{\}\)/, `${channel} destructures a payload without a default`);
  }
});

test('the cast is read from disk once, not on every hook event', () => {
  // allCharacters() is a readdir plus a JSON parse per installed pack, and main
  // asked for it on every session switch, every settings payload and every chat
  // turn. The folder only changes when a pack is added, drawn or removed.
  assert.match(main, /const cast = \(\) => \(castCache \|\|= allCharacters\(\)\)/);
  assert.ok(
    !/\ballCharacters\(\)/.test(main.slice(main.indexOf('const characterIds'))),
    'nothing after the cache should call allCharacters() directly'
  );
  // …and every path that changes the folder has to drop it, or a new pet never
  // appears in the menus until the app is restarted.
  for (const channel of ['install-pet', 'create-pet', 'remove-pet']) {
    const handler = main.slice(main.indexOf(`ipcMain.handle('clippy-settings-${channel}'`));
    assert.match(handler.slice(0, 900), /forgetFaces\(\)/, `${channel} should forget the cast`);
  }
});

test('the shared buddy keeps one face, and drops it whenever it could change', () => {
  // The face does not depend on which session the window is speaking for, but
  // wearIdentity asked for it on every switch — and working it out walks the
  // cast, which reads the themes folder. Holding it is only safe while every
  // way it could change clears it.
  assert.match(main, /let soloFace = ''/);
  assert.match(main, /const forgetFaces = \(\) => \{\s*castCache = null;\s*soloFace = '';/);
  const setting = main.slice(main.indexOf("if (key === 'soloCharacter')"));
  assert.match(setting.slice(0, 200), /soloFace = ''/, 'a new choice is picked again');
  const assign = main.slice(main.indexOf('function assignCharacter('));
  assert.match(assign.slice(0, 1400), /soloFace = ''/, 'an assignment is picked again');
});
