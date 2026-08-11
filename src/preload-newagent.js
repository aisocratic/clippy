'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The "start an agent somewhere" window. A tray menu can hold a folder picker
// but not a text field, and an SSH target needs two — a host and a path. This
// bridge carries exactly that, and nothing about any running session.
contextBridge.exposeInMainWorld('newAgentAPI', {
  // What the form should open with: the agents that can be started, and the
  // places you started one last time.
  onState: (fn) => ipcRenderer.on('clippy-newagent-state', (_e, state) => fn(state)),
  ready: () => ipcRenderer.send('clippy-newagent-ready'),
  // Ask main for the native folder picker — a renderer cannot open one.
  browse: () => ipcRenderer.invoke('clippy-newagent-browse'),
  start: (target) => ipcRenderer.invoke('clippy-newagent-start', target),
  close: () => ipcRenderer.send('clippy-newagent-close'),
});
