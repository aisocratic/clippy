'use strict';

/**
 * Drives the real Clippy UI through a staged Claude Code session story and
 * captures screenshots of each state. Used for docs/demos and for verifying
 * the renderer headlessly (run under xvfb on Linux):
 *
 *   npx electron scripts/demo-screenshots.js
 *
 * Screenshots land in shots/. Uses a solid background color (instead of the
 * app's transparent window) so the captures are viewable.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { SessionTracker } = require('../src/sessions');

const OUT_DIR = path.join(__dirname, '..', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const win = new BrowserWindow({
    width: 280,
    height: 360,
    frame: false,
    show: true,
    backgroundColor: '#27313d', // stand-in for the user's desktop
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));

  const tracker = new SessionTracker();
  const event = (name, kind, payload) => {
    const reaction = tracker.handle(name, kind, payload);
    if (reaction) {
      win.webContents.send('clippy-event', { ...reaction, counts: tracker.counts() });
    }
  };
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT_DIR, name), img.toPNG());
    console.log('captured', name);
  };

  const myApp = { session_id: 'demo-1', cwd: '/Users/fred/projects/my-app' };
  const api = { session_id: 'demo-2', cwd: '/Users/fred/projects/billing-api' };

  await sleep(800);
  await shot('1-idle.png');

  event('SessionStart', null, myApp);
  await sleep(600);
  await shot('2-session-started.png');

  event('UserPromptSubmit', null, myApp);
  event('SessionStart', null, api);
  event('UserPromptSubmit', null, api);
  await sleep(4500); // let the "now watching" info bubble fade
  await shot('3-claude-working.png');

  event('Notification', 'permission_prompt', myApp);
  await sleep(700);
  await shot('4-needs-permission.png');

  event('Notification', 'permission_prompt', api);
  await sleep(700);
  await shot('5-two-sessions-waiting.png');

  event('UserPromptSubmit', null, myApp);
  event('UserPromptSubmit', null, api);
  event('Stop', null, myApp);
  await sleep(700);
  await shot('6-finished-your-turn.png');

  app.quit();
});
