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
  const styles = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings.css'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload-settings.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const buddy = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'clippy.js'), 'utf8');

  assert.match(html, /id="appearance-sound"/);
  assert.match(html, /id="btn-new-agent"/);
  assert.match(html, /id="btn-add-buddy"/);
  assert.match(html, /id="buddy-canvas"/);
  assert.match(settings, /previewPose\.set/);
  assert.match(settings, /clippySettings\.createPet/);
  assert.match(settings, /clippySettings\.removePet/);
  assert.match(settings, /clippySettings\.newAgent/);
  assert.match(preload, /newAgent:.*clippy-settings-new-agent/);
  assert.match(main, /ipcMain\.on\('clippy-settings-new-agent'.*openNewAgentWindow/s);
  assert.match(settings, /function syncRailSelection/);
  assert.match(settings, /let current = panels\[0\]/);
  assert.doesNotMatch(settings, /new IntersectionObserver/);
  assert.doesNotMatch(styles, /\.panel\s*{[^}]*display:\s*none/s);
  assert.match(buddy, /case 'appearance'/);
});

test('a buddy can show what the session Clippy started has been saying', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const buddy = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'clippy.js'), 'utf8');
  const styles = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'clippy.css'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

  assert.match(html, /id="feed-log"/);
  assert.match(html, /id="menu-feed"/);
  // The panel has to be in PANELS, or syncMode never measures it and the
  // window stays buddy-sized around it.
  assert.match(buddy, /const PANELS = \[[^\]]*'feed'/);
  // Reachable in one click from the action bar, not only by knowing to
  // right-click. (This used to assert `CONTROL_HOSTS` contained 'feed' — the
  // row was re-parented into whichever panel was open, and the feed was one of
  // the panels that adopted it. The bar has one home now and adopts nothing.)
  assert.match(html, /id="btn-messages"/);
  assert.match(buddy, /onAction\('btn-messages'/);
  assert.match(buddy, /case 'transcript'/);
  assert.match(buddy, /case 'transcript-status'/);
  assert.match(buddy, /case 'ownership'/);
  assert.match(buddy, /evt\.directReply/);
  assert.match(main, /DIRECT_REPLY_REVIEW_GRACE_MS/);
  assert.match(main, /owned\.awaitingReply/);
  assert.match(main, /CHAT_SEND_READY_ATTEMPTS/);
  assert.match(main, /record\.sendQueue/);
  assert.match(main, /clearFirst: isChat/);

  // Terminal output scraped off a pane is not markdown; rendering it as such
  // would mangle it. It goes in a <pre> as text.
  assert.match(buddy, /pre\.textContent = turn\.text/);
  // The ring goes on the wrapper: #buddy is an <img>, which has no ::after.
  assert.match(styles, /body\.owned[^{]*#clippy::after/);
  assert.doesNotMatch(styles, /body\.owned[^{]*#buddy::after/);
  // …and the buddy that speaks for everybody wears a crown instead, never both.
  assert.match(styles, /body\.solo #clippy::after\s*\{\s*content:\s*none/);
});

test('new agents default to a persistent chat workspace without hiding project and SSH choices', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'new-agent.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'new-agent.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

  assert.match(html, /name="place" value="chat" checked/);
  assert.match(html, /id="recent-folders"/);
  assert.match(html, /Start chatting/);
  assert.match(renderer, /\{ agent, mode: 'chat' \}/);
  assert.match(main, /ensureChatWorkspace\(os\.homedir\(\)\)/);
  assert.match(main, /label: `Chat with \$\{label\}`/);
  assert.match(main, /remember: false/);
});
