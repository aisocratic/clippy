'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clippyAPI', {
  onEvent: (cb) => ipcRenderer.on('clippy-event', (_e, data) => cb(data)),
  onSettings: (cb) => ipcRenderer.on('clippy-settings', (_e, data) => cb(data)),
  onIdentity: (cb) => ipcRenderer.on('clippy-identity', (_e, data) => cb(data)),
  decide: (id, action, message) => ipcRenderer.send('clippy-decide', { id, action, message }),
  extend: (id) => ipcRenderer.send('clippy-extend', id),
  setSetting: (key, value) => ipcRenderer.send('clippy-set-setting', { key, value }),
  drivePrompt: (text) => ipcRenderer.send('clippy-drive-prompt', text),
  driveStop: () => ipcRenderer.send('clippy-drive-stop'),
  // Raise this session's terminal window (and perch on it) / let go of it.
  // `point: true` also walks Clippy down to that session's prompt when he
  // gets there — for when the answer has to be typed on that line.
  openWindow: (opts) => ipcRenderer.send('clippy-open-window', opts || {}),
  undock: () => ipcRenderer.send('clippy-undock'),
  // "Show me where": walk over to this session's prompt and point at it.
  pointAtPrompt: () => ipcRenderer.send('clippy-point'),
  // Everything that isn't about this one session lives in the settings window.
  openSettings: () => ipcRenderer.send('clippy-open-settings'),
  // The "Open Settings" button on a message you have to act on.
  fix: (what) => ipcRenderer.send('clippy-fix', what),
  // Grow to fit a card (as tall as its contents need), or shrink back to a
  // bare paperclip.
  setMode: (mode, height) => ipcRenderer.send('clippy-mode', { mode, height }),
  usage: () => ipcRenderer.invoke('clippy-usage'),
  hide: () => ipcRenderer.send('clippy-hide'),
  quit: () => ipcRenderer.send('clippy-quit'),
});
