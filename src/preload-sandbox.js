'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The sandbox window (npm run dev) can do exactly one thing: play a story at
// the dev buddy. Everything it draws is handed to it by main once the page has
// loaded, so there is nothing else for this bridge to carry.
contextBridge.exposeInMainWorld('sandboxAPI', {
  fire: (id) => ipcRenderer.send('clippy-sandbox-fire', String(id || '')),
});
