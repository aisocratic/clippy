'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The reading window: a real, resizable review surface for a response too long
// to live on a paperclip. Its narrow bridge can return to the mini card, open
// the originating app, or resolve the specific review it was opened for.
contextBridge.exposeInMainWorld('readerAPI', {
  onText: (fn) => ipcRenderer.on('clippy-reader-text', (_e, payload) => fn(payload)),
  openSource: () => ipcRenderer.send('clippy-reader-open-source'),
  minimize: () => ipcRenderer.send('clippy-reader-minimize'),
  decide: (action, message = '') => ipcRenderer.send('clippy-reader-decide', { action, message }),
});
