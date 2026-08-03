'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The settings window's bridge. Deliberately smaller than the buddy's: it reads
 * the app's state and writes single settings, nothing else.
 */
contextBridge.exposeInMainWorld('clippySettings', {
  // { settings, characters, sizes, actions, sessions, port, version }
  onState: (cb) => ipcRenderer.on('clippy-settings-state', (_e, data) => cb(data)),
  ready: () => ipcRenderer.send('clippy-settings-ready'),
  setSetting: (key, value) => ipcRenderer.send('clippy-set-setting', { key, value }),
  showBuddy: (sessionId) => ipcRenderer.send('clippy-settings-show', sessionId),
  // Links open in the user's browser, never inside this window.
  openExternal: (url) => ipcRenderer.send('clippy-open-external', url),
});
