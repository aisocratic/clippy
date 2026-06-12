'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  screen,
  nativeImage,
} = require('electron');
const path = require('node:path');
const { createHookServer } = require('./server');
const { SessionTracker } = require('./sessions');

const PORT = Number(process.env.CLIPPY_PORT || 43117);
const WIN_W = 280;
const WIN_H = 360;

const tracker = new SessionTracker();
let win = null;
let tray = null;

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
  win.on('closed', () => {
    win = null;
  });
}

function createTray() {
  // Empty image + emoji title gives us a menu bar presence on macOS
  // without shipping icon assets.
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('📎');
  tray.setToolTip('Clippy for Claude Code');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Clippy', click: () => win?.showInactive() },
      { label: 'Hide Clippy', click: () => win?.hide() },
      { type: 'separator' },
      {
        label: `Hook server: 127.0.0.1:${PORT}`,
        enabled: false,
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
}

function updateTray() {
  if (!tray) return;
  const { waiting } = tracker.counts();
  tray.setTitle(waiting > 0 ? `📎 ${waiting}` : '📎');
}

function handleHookEvent(eventName, kind, payload) {
  const reaction = tracker.handle(eventName, kind, payload);
  if (!reaction) return;
  updateTray();

  if (win) {
    win.webContents.send('clippy-event', { ...reaction, counts: tracker.counts() });
    if (reaction.kind === 'attention') {
      // Pop up without stealing keyboard focus from the terminal.
      win.showInactive();
    }
  }

  if (reaction.kind === 'attention' && Notification.isSupported()) {
    const n = new Notification({
      title: reaction.urgency === 'urgent' ? '📎 Claude needs you!' : '📎 Clippy',
      body: reaction.message,
      silent: reaction.urgency !== 'urgent',
    });
    n.on('click', () => win?.showInactive());
    n.show();
  }
}

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide();

  createWindow();
  createTray();

  ipcMain.on('clippy-hide', () => win?.hide());
  ipcMain.on('clippy-quit', () => app.quit());
  ipcMain.on('clippy-counts', updateTray);

  const server = createHookServer({
    port: PORT,
    onEvent: handleHookEvent,
    getStatus: () => ({ sessions: tracker.list(), counts: tracker.counts() }),
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
