'use strict';

/**
 * The renderer is a row of plain <script> tags sharing one global scope, so a
 * top-level `const` in one file collides with the same name in the next — and
 * the browser answers with a SyntaxError that stops clippy.js from running at
 * all. Nothing else here loads those files together, which is how a duplicate
 * `DEEDS_KEPT` in deeds.js and clippy.js once slipped through: each module's
 * own test passed, and the app was dead.
 *
 * Two checks, both cheap: every script parses as one concatenated scope (the
 * same duplicate-declaration rule a browser applies across scripts), and every
 * `ClippyX` global clippy.js reaches for is actually defined by the scripts
 * that load before it — as a bare name or on window, whichever it reads.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');

function scriptOrder() {
  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const names = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.ok(names.length > 1, 'index.html should load several renderer scripts');
  assert.equal(names.at(-1), 'clippy.js', 'clippy.js is the last script loaded');
  return names;
}

const read = (name) => fs.readFileSync(path.join(RENDERER, name), 'utf8');

test('renderer scripts parse as one shared scope, in index.html order', () => {
  const joined = scriptOrder()
    .map((name) => `// ---- ${name}\n${read(name)}`)
    .join('\n;\n');
  // A duplicate top-level let/const/class is a SyntaxError at parse time —
  // no DOM needed to catch it.
  assert.doesNotThrow(() => new vm.Script(joined, { filename: 'renderer-scripts.js' }));
});

test('every Clippy* global clippy.js reads is defined by an earlier script', () => {
  const names = scriptOrder();
  const renderer = read('clippy.js');

  // As in a browser, `window` is the global object itself: a module may hang
  // itself on either name (or on globalThis) and clippy.js must find it.
  const window = { document: { addEventListener() {} }, console };
  window.window = window;
  const context = vm.createContext(window);
  // The scripts before clippy.js need nothing but a window to hang things on.
  for (const name of names.slice(0, -1)) {
    vm.runInContext(read(name), context, { filename: name });
  }

  const reads = new Map();
  for (const m of renderer.matchAll(/(window\.)?\b(Clippy[A-Z]\w*)\b/g)) {
    const [, viaWindow, ident] = m;
    if (!reads.has(ident)) reads.set(ident, new Set());
    reads.get(ident).add(viaWindow ? 'window' : 'bare');
  }
  assert.ok(reads.size > 0, 'clippy.js reads at least one Clippy* module');

  for (const [ident, hows] of reads) {
    for (const how of hows) {
      const defined =
        how === 'window'
          ? window[ident] !== undefined
          : vm.runInContext(`typeof ${ident} !== 'undefined'`, context);
      assert.ok(
        defined,
        `clippy.js reads ${how === 'window' ? 'window.' : ''}${ident}, which no earlier script defines that way`
      );
    }
  }
});

test('the settings window’s scripts parse as one shared scope, and it has the strip', () => {
  const html = read('settings.html');
  const names = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.equal(names.at(-1), 'settings.js');
  assert.ok(names.indexOf('activity-strip.js') >= 0 && names.indexOf('activity-strip.js') < names.indexOf('settings.js'));
  const joined = names.map((name) => `// ---- ${name}\n${read(name)}`).join('\n;\n');
  assert.doesNotThrow(() => new vm.Script(joined, { filename: 'settings-scripts.js' }));
});
