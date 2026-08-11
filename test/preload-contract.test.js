'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadProductionApi() {
  let api;
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, exposed) {
        assert.equal(name, 'clippyAPI');
        api = exposed;
      },
    },
    ipcRenderer: {
      on() {},
      send() {},
      invoke() {},
    },
  };
  const source = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  vm.runInNewContext(source, {
    require(name) {
      assert.equal(name, 'electron');
      return electron;
    },
  });
  return api;
}

function loadDemoApi() {
  const window = {
    parent: { postMessage() {} },
    addEventListener() {},
  };
  const document = {
    readyState: 'complete',
    addEventListener() {},
    getElementById() {
      return null;
    },
  };
  const source = fs.readFileSync(path.join(ROOT, 'demo', 'stub-api.js'), 'utf8');
  vm.runInNewContext(source, { window, document, MouseEvent: class MouseEvent {} });
  return window.clippyAPI;
}

test('the production preload and browser demo expose the same renderer API', () => {
  const productionMethods = Object.keys(loadProductionApi()).sort();
  const demoMethods = Object.keys(loadDemoApi()).sort();

  assert.deepEqual(demoMethods, productionMethods);
});

test('the browser control panel handles every command posted by its preload stub', () => {
  const stub = fs.readFileSync(path.join(ROOT, 'demo', 'stub-api.js'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'demo', 'demo.js'), 'utf8');
  const posted = new Set([...stub.matchAll(/\bpost\('([^']+)'/g)].map((match) => match[1]));
  const handled = new Set([...panel.matchAll(/case '([^']+)'/g)].map((match) => match[1]));
  const missing = [...posted].filter((command) => !handled.has(command));

  assert.deepEqual(missing, []);
});

test('the browser bench can center and move its buddy inside the sandbox', () => {
  const html = fs.readFileSync(path.join(ROOT, 'demo', 'index.html'), 'utf8');
  const panel = fs.readFileSync(path.join(ROOT, 'demo', 'demo.js'), 'utf8');

  assert.match(html, /id="btn-center"/);
  assert.match(panel, /function centerFrame/);
  assert.match(panel, /function moveFrameBy/);
  assert.match(panel, /case 'move-by':\s+moveFrameBy\(p\.dx, p\.dy\)/);
  assert.doesNotMatch(panel, /moveBy.*stays put here/);
  assert.match(html, /Clippy workshop/);
  assert.match(html, /<details class="workbench">/);
  assert.match(panel, /document\.createElement\('details'\)/);
});

test('settings expose appearance sounds and buddy management', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.html'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.js'), 'utf8');
  const buddy = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'clippy.js'), 'utf8');

  assert.match(html, /id="appearance-sound"/);
  assert.match(html, /id="btn-add-buddy"/);
  assert.match(html, /id="buddy-canvas"/);
  assert.match(settings, /previewPose\.set/);
  assert.match(settings, /clippySettings\.createPet/);
  assert.match(settings, /clippySettings\.removePet/);
  assert.match(buddy, /case 'appearance'/);
});
