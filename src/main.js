'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  dialog,
  screen,
  nativeImage,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createHookServer } = require('./server');
const { SessionTracker, WORKING } = require('./sessions');
const { DecisionBroker, toHookResponse, describeToolCall } = require('./decisions');
const { DriveSession } = require('./sdk-session');

const PORT = Number(process.env.CLIPPY_PORT || 43117);
const WIN_W = 320;
const WIN_H = 560;

// How long interactive cards wait for a click before falling back to the
// normal terminal flow. Both can be extended while the user is typing, but
// never past the broker's hard cap (which stays under the hook's curl -m).
const APPROVAL_HOLD_MS = Number(process.env.CLIPPY_APPROVAL_HOLD_SECS || 60) * 1000;
const REVIEW_HOLD_MS = Number(process.env.CLIPPY_REVIEW_HOLD_SECS || 30) * 1000;

const tracker = new SessionTracker();
const broker = new DecisionBroker({ hardCapMs: 100_000 });
let drive = null; // the active Clippy-driven (Agent SDK) session, if any
let win = null;
let tray = null;

/* ---------------- Settings (persisted across restarts) ---------------- */

const settings = {
  approvals: true, // answer permission requests from the Clippy UI
  reviewOnStop: true, // offer a review box when Claude finishes a turn
};
const settingsFile = () => path.join(app.getPath('userData'), 'clippy-settings.json');

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch {
    // first run / unreadable -> defaults
  }
}

function setSetting(key, value) {
  if (!(key in settings)) return;
  settings[key] = Boolean(value);
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('clippy: could not save settings', err);
  }
  tray?.setContextMenu(trayMenu());
  sendSettings();
}

function sendSettings() {
  win?.webContents.send('clippy-settings', { ...settings });
}

/* ---------------- Window & tray ---------------- */

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: workArea.x + workArea.width - WIN_W - 16,
    y: workArea.y + workArea.height - WIN_H - 16,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', sendSettings);
  win.on('closed', () => {
    win = null;
  });
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show Clippy', click: () => win?.showInactive() },
    { label: 'Hide Clippy', click: () => win?.hide() },
    { type: 'separator' },
    {
      label: 'Approve permissions in Clippy',
      type: 'checkbox',
      checked: settings.approvals,
      click: (item) => setSetting('approvals', item.checked),
    },
    {
      label: 'Review when Claude finishes',
      type: 'checkbox',
      checked: settings.reviewOnStop,
      click: (item) => setSetting('reviewOnStop', item.checked),
    },
    { type: 'separator' },
    drive
      ? { label: `Stop Clippy-driven session (${drive.name})`, click: stopDriveSession }
      : { label: 'New Clippy-driven session…', click: startDriveSession },
    { type: 'separator' },
    {
      label: `Hook server: 127.0.0.1:${PORT}`,
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

/* ---------------- Drive mode (Agent SDK) ---------------- */

async function startDriveSession() {
  if (drive) return;
  const picked = await dialog.showOpenDialog({
    title: 'Folder for the Clippy-driven Claude session',
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return;

  drive = new DriveSession({
    cwd: picked.filePaths[0],
    send: (event) => win?.webContents.send('clippy-event', event),
  });
  tray?.setContextMenu(trayMenu());
  win?.showInactive();
  win?.webContents.send('clippy-event', { kind: 'drive-open', name: drive.name, cwd: drive.cwd });
  try {
    await drive.start({ permissionMode: 'default' });
  } catch (err) {
    win?.webContents.send('clippy-event', {
      kind: 'drive-status',
      status: 'error',
      message:
        'Could not start the Agent SDK. Install it with `npm install @anthropic-ai/claude-agent-sdk` ' +
        'and make sure `claude` is logged in. ' +
        String(err && err.message),
    });
  }
}

function stopDriveSession() {
  if (!drive) return;
  drive.stop();
  drive = null;
  tray?.setContextMenu(trayMenu());
  win?.webContents.send('clippy-event', { kind: 'drive-close' });
}

function createTray() {
  // Empty image + emoji title gives us a menu bar presence on macOS
  // without shipping icon assets.
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('📎');
  tray.setToolTip('Clippy for Claude Code');
  tray.setContextMenu(trayMenu());
}

function updateTray() {
  if (!tray) return;
  const { waiting } = tracker.counts();
  tray.setTitle(waiting > 0 ? `📎 ${waiting}` : '📎');
}

function notify(title, body, { silent = true } = {}) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent });
  n.on('click', () => win?.showInactive());
  n.show();
}

/* ---------------- Hook handling ---------------- */

function emitPassive(reaction, { osNotification = true } = {}) {
  updateTray();
  if (win) {
    win.webContents.send('clippy-event', { ...reaction, counts: tracker.counts() });
    if (reaction.kind === 'attention') {
      // Pop up without stealing keyboard focus from the terminal.
      win.showInactive();
    }
  }
  if (reaction.kind === 'attention' && osNotification) {
    notify(
      reaction.urgency === 'urgent' ? '📎 Claude needs you!' : '📎 Clippy',
      reaction.message,
      { silent: reaction.urgency !== 'urgent' }
    );
  }
}

/**
 * Claude Code is about to show a permission dialog. Hold the hook open and
 * let the user answer from Clippy; on timeout/pass return {} so the normal
 * terminal prompt appears (and the Notification hook nudges as before).
 */
async function handlePermissionRequest(payload, ctx) {
  if (!settings.approvals || !win) return {};

  const reaction = tracker.handle('PermissionRequest', null, payload);
  updateTray();

  const isPlan = payload.tool_name === 'ExitPlanMode';
  const { title, detail } = describeToolCall(payload.tool_name, payload.tool_input);
  const { id, expiresAt, promise } = broker.ask(
    { event: 'PermissionRequest', sessionId: reaction.sessionId },
    APPROVAL_HOLD_MS
  );
  ctx.onClose(() => broker.resolve(id, 'cancel'));

  win.webContents.send('clippy-event', {
    ...reaction,
    counts: tracker.counts(),
    requestId: id,
    tool: payload.tool_name,
    // 'plan' relabels the approval buttons to Approve / Revise in the UI.
    variant: isPlan ? 'plan' : 'tool',
    title,
    detail,
    expiresAt,
  });
  win.showInactive();
  notify(
    isPlan ? '📎 Claude has a plan' : '📎 Claude needs your approval',
    `${reaction.name}: ${title}`,
    { silent: false }
  );

  const { action, message, timedOut } = await promise;

  if (action === 'allow' || action === 'deny') {
    tracker.setStatus(reaction.sessionId, WORKING);
  }
  // pass / timeout: status stays needs_permission — the terminal prompt takes
  // over and the Notification(permission_prompt) hook will nudge passively.
  updateTray();
  win?.webContents.send('clippy-event', {
    kind: 'request-closed',
    requestId: id,
    sessionId: reaction.sessionId,
    outcome: action,
    timedOut,
    counts: tracker.counts(),
  });
  return toHookResponse('PermissionRequest', action, message);
}

/**
 * Claude finished a turn. If review mode is on, hold the Stop hook briefly:
 * "looks good" (or timeout) lets Claude stop; typed feedback blocks the stop
 * and sends Claude back to work with that feedback.
 */
async function handleStop(payload, ctx) {
  const reaction = tracker.handle('Stop', null, payload);

  if (!settings.reviewOnStop || !win) {
    emitPassive(reaction);
    return {};
  }
  updateTray();

  const { id, expiresAt, promise } = broker.ask(
    { event: 'Stop', sessionId: reaction.sessionId },
    REVIEW_HOLD_MS
  );
  ctx.onClose(() => broker.resolve(id, 'cancel'));

  win.webContents.send('clippy-event', {
    ...reaction,
    kind: 'review',
    message: `Claude finished in “${reaction.name}”. Looks good, or should it keep going?`,
    counts: tracker.counts(),
    requestId: id,
    expiresAt,
  });
  win.showInactive();
  notify('📎 Claude finished', `“${reaction.name}” — review it from Clippy`, { silent: true });

  const { action, message, timedOut } = await promise;

  win?.webContents.send('clippy-event', {
    kind: 'request-closed',
    requestId: id,
    sessionId: reaction.sessionId,
    outcome: action,
    timedOut,
    counts: tracker.counts(),
  });

  if (action === 'feedback' && message.trim()) {
    tracker.setStatus(reaction.sessionId, WORKING);
    updateTray();
    return toHookResponse('Stop', action, message);
  }
  if (timedOut) {
    // Nobody reviewed in time — degrade to the classic passive nudge (without
    // a second OS notification; one was shown when the review card appeared).
    emitPassive(reaction, { osNotification: false });
  }
  return {};
}

/**
 * Claude called AskUserQuestion. The CLI hook API can't inject the answer
 * (only the Agent SDK's canUseTool can — that's Drive mode), so we surface the
 * question prominently and notify; the user answers in the terminal. Returning
 * undefined lets the terminal picker proceed unaffected.
 */
function surfaceQuestion(payload) {
  const reaction = tracker.handle('PreToolUse', null, payload);
  const { title, detail } = describeToolCall('AskUserQuestion', payload.tool_input);
  updateTray();
  if (win) {
    win.webContents.send('clippy-event', {
      ...reaction,
      kind: 'question',
      counts: tracker.counts(),
      title,
      detail,
      message: `Claude is asking in “${reaction.name}” — answer in your terminal.`,
    });
    win.showInactive();
  }
  notify('📎 Claude is asking you', `${reaction.name}: ${title}`, { silent: false });
}

function handleHookEvent(eventName, kind, payload, ctx) {
  if (eventName === 'PermissionRequest') return handlePermissionRequest(payload, ctx);
  if (eventName === 'Stop') return handleStop(payload, ctx);

  if (eventName === 'PreToolUse' && payload.tool_name === 'AskUserQuestion') {
    surfaceQuestion(payload);
    return undefined;
  }

  if (eventName === 'UserPromptSubmit' || eventName === 'SessionEnd') {
    // The user moved on in the terminal — pending cards for this session are moot.
    broker.cancelBySession(payload.session_id || 'unknown');
  }

  const reaction = tracker.handle(eventName, kind, payload);
  if (reaction) emitPassive(reaction);
  return undefined;
}

/* ---------------- App lifecycle ---------------- */

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide();

  loadSettings();
  createWindow();
  createTray();

  ipcMain.on('clippy-hide', () => win?.hide());
  ipcMain.on('clippy-quit', () => app.quit());
  ipcMain.on('clippy-counts', updateTray);
  ipcMain.on('clippy-decide', (_e, { id, action, message }) => {
    const a = String(action || '');
    const m = typeof message === 'string' ? message : '';
    // Ids are globally unique; try the hook broker, then the Drive session.
    if (!broker.resolve(id, a, m)) drive?.resolve(id, a, m);
  });
  ipcMain.on('clippy-extend', (_e, id) => {
    const expiresAt = broker.extend(id) || drive?.extend(id);
    if (expiresAt) {
      win?.webContents.send('clippy-event', { kind: 'extended', requestId: id, expiresAt });
    }
  });
  ipcMain.on('clippy-set-setting', (_e, { key, value }) => setSetting(key, value));
  ipcMain.on('clippy-drive-prompt', (_e, text) => {
    if (drive && typeof text === 'string' && text.trim()) drive.prompt(text.trim());
  });
  ipcMain.on('clippy-drive-stop', stopDriveSession);

  const server = createHookServer({
    port: PORT,
    onEvent: handleHookEvent,
    getStatus: () => ({
      sessions: tracker.list(),
      counts: tracker.counts(),
      settings: { ...settings },
      pending: broker.list(),
    }),
  });
  try {
    await server.listenOn();
    console.log(`clippy: listening for Claude Code hooks on 127.0.0.1:${PORT}`);
  } catch (err) {
    console.error(
      `clippy: could not bind 127.0.0.1:${PORT} (${err.code}). ` +
        'Is another Clippy running? Set CLIPPY_PORT to use a different port.'
    );
    app.quit();
  }
});

// Menu-bar style app: keep running with the window hidden/closed.
app.on('window-all-closed', () => {});
