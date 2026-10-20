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
  // Open the existing tmux/SSH launcher; agent startup remains owned by main.
  newAgent: () => ipcRenderer.send('clippy-settings-new-agent'),
  setSetting: (key, value) => ipcRenderer.send('clippy-set-setting', { key, value }),
  showBuddy: (sessionId) => ipcRenderer.send('clippy-settings-show', sessionId),
  // 'accessibility' opens the macOS pane; 'copy-path' copies this app's path.
  fix: (what) => ipcRenderer.send('clippy-settings-fix', what),
  // Compare this build with GitHub, then download and install a verified DMG update.
  checkUpdates: () => ipcRenderer.invoke('clippy-settings-check-updates'),
  installUpdate: () => ipcRenderer.invoke('clippy-settings-install-update'),
  // Paste a pet's page link and main downloads and installs the pack.
  installPet: (url) => ipcRenderer.invoke('clippy-settings-install-pet', url),
  // Drawn buddies use the same local theme format as installed sprite packs.
  createPet: (drawing) => ipcRenderer.invoke('clippy-settings-create-pet', drawing),
  removePet: (character) => ipcRenderer.invoke('clippy-settings-remove-pet', character),
  // The one thing Clippy sends that came from the user, and only when they
  // press send. Main does the posting: see src/feedback.js for why.
  sendFeedback: (feedback) => ipcRenderer.invoke('clippy-settings-feedback', feedback),
  // Links open in the user's browser, never inside this window.
  openExternal: (url) => ipcRenderer.send('clippy-open-external', url),
});
