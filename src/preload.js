'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clippyAPI', {
  onEvent: (cb) => ipcRenderer.on('clippy-event', (_e, data) => cb(data)),
  onSettings: (cb) => ipcRenderer.on('clippy-settings', (_e, data) => cb(data)),
  decide: (id, action, message) => ipcRenderer.send('clippy-decide', { id, action, message }),
  extend: (id) => ipcRenderer.send('clippy-extend', id),
  setSetting: (key, value) => ipcRenderer.send('clippy-set-setting', { key, value }),
  drivePrompt: (text) => ipcRenderer.send('clippy-drive-prompt', text),
  driveStop: () => ipcRenderer.send('clippy-drive-stop'),
  hide: () => ipcRenderer.send('clippy-hide'),
  quit: () => ipcRenderer.send('clippy-quit'),
});
