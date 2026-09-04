'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clippyAPI', {
  onEvent: (cb) => ipcRenderer.on('clippy-event', (_e, data) => cb(data)),
  onSettings: (cb) => ipcRenderer.on('clippy-settings', (_e, data) => cb(data)),
  onIdentity: (cb) => ipcRenderer.on('clippy-identity', (_e, data) => cb(data)),
  decide: (id, action, message) => ipcRenderer.send('clippy-decide', { id, action, message }),
  extend: (id) => ipcRenderer.send('clippy-extend', id),
  setSetting: (key, value) => ipcRenderer.send('clippy-set-setting', { key, value }),
  drivePrompt: (text) => ipcRenderer.send('clippy-drive-prompt', text),
  driveStop: () => ipcRenderer.send('clippy-drive-stop'),
  // The prompt composer: raise this session's terminal and type this into it.
  // `to` names which session it goes to; without it, this buddy's own.
  sendPrompt: (text, to) => ipcRenderer.send('clippy-send-prompt', text, to),
  // Who else is running, so one buddy can speak for all of them.
  agents: () => ipcRenderer.invoke('clippy-agents'),
  // A word with the buddy itself, which goes nowhere near that terminal.
  petSay: (text) => ipcRenderer.invoke('clippy-pet-say', text),
  // "Who is this for?" — a proposal, never a delivery. See src/delegate.js.
  delegate: (text) => ipcRenderer.invoke('clippy-delegate', text),
  // Raise this session's terminal window and perch on it. `point: true` also
  // walks Clippy down to that session's prompt when he gets there — for when
  // the answer has to be typed on that line.
  openWindow: (opts) => ipcRenderer.send('clippy-open-window', opts || {}),
  // Hand-rolled window drag: the buddy is a normal clickable element (an
  // app-region would eat left-clicks), so moving him is explicit deltas.
  moveBy: (dx, dy) => ipcRenderer.send('clippy-move-by', { dx, dy }),
  // "Show me where": walk over to this session's prompt and point at it.
  pointAtPrompt: () => ipcRenderer.send('clippy-point'),
  // Everything that isn't about this one session lives in the settings window.
  openSettings: () => ipcRenderer.send('clippy-open-settings'),
  // Markdown links open in the system browser; main validates https again.
  openExternal: (url) => ipcRenderer.send('clippy-open-external', url),
  // The "Open Settings" button on a message you have to act on.
  fix: (what) => ipcRenderer.send('clippy-fix', what),
  // Grow to fit a card (as tall as its contents need), or shrink back to a
  // bare paperclip.
  setMode: (mode, height, width, anchor) =>
    ipcRenderer.send('clippy-mode', { mode, height, width, anchor }),
  identity: () => ipcRenderer.invoke('clippy-session-identity'),
  // The rest of a message the card had to cut — see "read all".
  cardFull: (requestId) => ipcRenderer.invoke('clippy-card-full', requestId),
  // Open a long message in a window of its own — see openReader in main.
  // `mine` is what the card already holds, for the common case where main
  // never had to cut the message and so kept no copy of it.
  openReader: (id, mine) => ipcRenderer.send('clippy-open-reader', id, mine),
  // Activity beneath the buddy is a glance; opening one sends its complete
  // text to the same ordinary, resizable reader window as "read it all".
  openActivityReader: (title, text) => ipcRenderer.send('clippy-open-activity-reader', { title, text }),
  context: () => ipcRenderer.invoke('clippy-context'),
  usage: () => ipcRenderer.invoke('clippy-usage'),
  // What a session Clippy started has been saying, for the panel that
  // shows more than the last line of it.
  feed: () => ipcRenderer.invoke('clippy-feed'),
  // { lookedAway: true } is a click elsewhere after dealing with Clippy: it
  // hides but keeps a perch or pin. Without it, the Hide button, which drops both.
  hide: (opts) => ipcRenderer.send('clippy-hide', opts && opts.lookedAway ? { lookedAway: true } : null),
  quit: () => ipcRenderer.send('clippy-quit'),
});
