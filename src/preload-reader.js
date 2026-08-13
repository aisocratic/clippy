'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The reading window: a real, resizable window for a message too long to live
// on a paperclip. It carries text and nothing else — no session, no decisions,
// nothing that could answer a hook. Closing it is just closing a window.
contextBridge.exposeInMainWorld('readerAPI', {
  onText: (fn) => ipcRenderer.on('clippy-reader-text', (_e, payload) => fn(payload)),
  ready: () => ipcRenderer.send('clippy-reader-ready'),
});
