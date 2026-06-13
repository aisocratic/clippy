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
    width: 320,
    height: 560,
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
    // Force a fresh composite — capturePage can otherwise return a stale frame
    // on a non-focused window, yielding identical PNGs across shots.
    win.webContents.invalidate();
    await win.capturePage(); // priming capture triggers a recomposite
    await sleep(120);
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

  // Interactive approval card: a held PermissionRequest waiting for a click.
  event('UserPromptSubmit', null, myApp);
  const approval = tracker.handle('PermissionRequest', null, myApp);
  win.webContents.send('clippy-event', {
    ...approval,
    counts: tracker.counts(),
    requestId: 'demo-req-1',
    tool: 'Bash',
    title: 'Run: Delete the build directory',
    detail: '$ rm -rf /tmp/build && npm run build',
    expiresAt: Date.now() + 60_000,
  });
  await sleep(700);
  await shot('7-approval-card.png');

  // Interactive review card: a held Stop waiting for "looks good" or feedback.
  win.webContents.send('clippy-event', {
    kind: 'request-closed',
    requestId: 'demo-req-1',
    sessionId: 'demo-1',
    outcome: 'allow',
    counts: tracker.counts(),
  });
  const review = tracker.handle('Stop', null, api);
  win.webContents.send('clippy-event', {
    ...review,
    kind: 'review',
    message: `Claude finished in “${review.name}”. Looks good, or should it keep going?`,
    counts: tracker.counts(),
    requestId: 'demo-req-2',
    expiresAt: Date.now() + 30_000,
  });
  await sleep(700);
  await shot('8-review-card.png');

  // Live activity line: what Claude is doing right now (ambient, no popup).
  win.webContents.send('clippy-event', {
    kind: 'request-closed',
    requestId: 'demo-req-2',
    sessionId: 'demo-2',
    outcome: 'ok',
    counts: tracker.counts(),
  });
  event('UserPromptSubmit', null, myApp);
  event('PreToolUse', null, { ...myApp, tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the test suite' } });
  await sleep(700);
  await shot('9-activity-line.png');

  // Plan-approval card (ExitPlanMode held through PermissionRequest).
  const plan = '# Plan: API rate limiting\n\n1. Token-bucket middleware\n2. Wire into the router\n3. Per-route limits\n4. Tests for 200 / 429';
  const planReq = tracker.handle('PermissionRequest', null, { ...myApp, tool_name: 'ExitPlanMode', tool_input: { plan } });
  const planCard = require('../src/decisions').describeToolCall('ExitPlanMode', { plan });
  win.webContents.send('clippy-event', {
    ...planReq,
    counts: tracker.counts(),
    requestId: 'demo-req-3',
    tool: 'ExitPlanMode',
    variant: 'plan',
    title: planCard.title,
    detail: planCard.detail,
    expiresAt: Date.now() + 60_000,
  });
  await sleep(700);
  await shot('10-plan-card.png');

  // Question surfacing (AskUserQuestion — read-only; answered in the terminal).
  win.webContents.send('clippy-event', {
    kind: 'request-closed',
    requestId: 'demo-req-3',
    sessionId: 'demo-1',
    outcome: 'allow',
    counts: tracker.counts(),
  });
  const qInput = {
    questions: [
      {
        question: 'Which rate-limit store should I use?',
        options: [
          { label: 'Redis', description: 'Shared across instances' },
          { label: 'In-memory', description: 'Simplest, single instance' },
        ],
      },
    ],
  };
  const qReact = tracker.handle('PreToolUse', null, { ...myApp, tool_name: 'AskUserQuestion', tool_input: qInput });
  const qCard = require('../src/decisions').describeToolCall('AskUserQuestion', qInput);
  win.webContents.send('clippy-event', {
    ...qReact,
    kind: 'question',
    counts: tracker.counts(),
    title: qCard.title,
    detail: qCard.detail,
  });
  await sleep(700);
  await shot('11-question-card.png');

  // Drive mode: a Clippy-driven SDK session with a streamed transcript.
  // Clear the surfaced question first so the panels don't stack/overflow.
  win.webContents.send('clippy-event', { kind: 'clear', sessionId: 'demo-1', name: 'my-app', activity: null, counts: tracker.counts() });
  win.webContents.send('clippy-event', { kind: 'drive-open', name: 'billing-api', cwd: '/Users/fred/projects/billing-api' });
  win.webContents.send('clippy-event', { kind: 'drive-transcript', role: 'user', text: 'Add rate limiting to the API' });
  win.webContents.send('clippy-event', { kind: 'drive-transcript', role: 'assistant', text: "I'll add a token-bucket middleware and wire it into the router." });
  win.webContents.send('clippy-event', { kind: 'drive-activity', label: 'Editing middleware/rateLimit.js', tool: 'Edit' });
  await sleep(700);
  await shot('12-drive-panel.png');

  // Drive mode answers AskUserQuestion remotely (option buttons).
  // Close the transcript panel so the answer card is the clean hero shot.
  win.webContents.send('clippy-event', { kind: 'drive-close' });
  win.webContents.send('clippy-event', {
    kind: 'answer',
    requestId: 'demo-ans-1',
    name: 'billing-api',
    title: 'Which rate-limit store should I use?',
    questions: [
      {
        question: 'Which rate-limit store should I use?',
        options: [
          { label: 'Redis', description: 'Shared across instances' },
          { label: 'In-memory', description: 'Single instance' },
        ],
      },
    ],
  });
  await sleep(700);
  await shot('13-answer-card.png');

  app.quit();
});
