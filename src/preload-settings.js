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
  // Both are keyed by session, not by project: two agents in one folder are two
  // buddies, and dressing one must not dress the other.
  assign: (sessionId, character) =>
    ipcRenderer.send('clippy-settings-assign', { sessionId, character }),
  assignSize: (sessionId, size) =>
    ipcRenderer.send('clippy-settings-assign-size', { sessionId, size }),
  // 'accessibility' opens the macOS pane; 'copy-path' copies this app's path.
  fix: (what) => ipcRenderer.send('clippy-settings-fix', what),
  // Compare this build with the tip of main on GitHub.
  checkUpdates: () => ipcRenderer.invoke('clippy-settings-check-updates'),
  // Paste a pet's page link and main downloads and installs the pack.
  installPet: (url) => ipcRenderer.invoke('clippy-settings-install-pet', url),
  // Drawn buddies use the same local theme format as installed sprite packs.
  createPet: (drawing) => ipcRenderer.invoke('clippy-settings-create-pet', drawing),
  removePet: (character) => ipcRenderer.invoke('clippy-settings-remove-pet', character),
  // Links open in the user's browser, never inside this window.
  openExternal: (url) => ipcRenderer.send('clippy-open-external', url),
});
