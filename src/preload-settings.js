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
  // Give one project a buddy of its own; '' hands it back to the mode.
  assign: (name, character) => ipcRenderer.send('clippy-settings-assign', { name, character }),
  // 'accessibility' opens the macOS pane; 'copy-path' copies this app's path.
  fix: (what) => ipcRenderer.send('clippy-settings-fix', what),
  // Compare this build with the tip of main on GitHub.
  checkUpdates: () => ipcRenderer.invoke('clippy-settings-check-updates'),
  // Links open in the user's browser, never inside this window.
  openExternal: (url) => ipcRenderer.send('clippy-open-external', url),
});
