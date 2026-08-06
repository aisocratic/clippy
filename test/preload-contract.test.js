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
