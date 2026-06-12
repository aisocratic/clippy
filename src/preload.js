'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clippyAPI', {
  onEvent: (cb) => ipcRenderer.on('clippy-event', (_e, data) => cb(data)),
  hide: () => ipcRenderer.send('clippy-hide'),
  quit: () => ipcRenderer.send('clippy-quit'),
});
