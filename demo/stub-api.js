'use strict';

/**
 * Browser stand-in for src/preload.js.
 *
 * In Electron the renderer talks to main over IPC through `window.clippyAPI`.
 * In the web test bench the "main process" is the control panel in the parent
 * frame, so the same surface is implemented over postMessage. clippy.js is
 * loaded unchanged and never knows the difference.
 */

(function () {
  const handlers = { event: [], settings: [], identity: [] };
  // clippy.js is a separate <script>, so the panel's first messages can land
  // before it has called onEvent(). In Electron the preload has the same
  // problem and IPC solves it by buffering; do the same here rather than
  // silently losing the opening can-open / settings / dock events.
  const inbox = { event: [], settings: [], identity: [] };
  let usageData = null;

  const post = (type, payload = {}) =>
    window.parent.postMessage({ __clippyDemo: true, type, payload }, '*');

  const fire = (list, data) => {
    for (const cb of list) {
      try {
        cb(data);
      } catch (err) {
        post('error', { message: String(err && err.message ? err.message : err) });
      }
    }
  };

  const deliver = (kind, data) => {
    if (handlers[kind].length) fire(handlers[kind], data);
    else inbox[kind].push(data);
  };

  const subscribe = (kind, cb) => {
    handlers[kind].push(cb);
    const waiting = inbox[kind].splice(0, inbox[kind].length);
    for (const data of waiting) fire([cb], data);
  };

  window.clippyAPI = {
    onEvent: (cb) => subscribe('event', cb),
    onSettings: (cb) => subscribe('settings', cb),
    onIdentity: (cb) => subscribe('identity', cb),

    decide: (id, action, message) => post('decide', { id, action, message }),
    extend: (id) => post('extend', { id }),
    setSetting: (key, value) => post('set-setting', { key, value }),
    drivePrompt: (text) => post('drive-prompt', { text }),
    driveStop: () => post('drive-stop'),
    openWindow: (opts) => post('open-window', opts || {}),
    undock: () => post('undock'),
    pointAtPrompt: () => post('point'),
    openSettings: () => post('open-settings'),
    setMode: (mode, height) => post('mode', { mode, height }),
    // main answers this over IPC invoke; here the panel pushes the data ahead
    // of time and we just hand back whatever it last set.
    usage: async () => usageData,
    hide: () => post('hide'),
    quit: () => post('quit'),
  };

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.__clippyDemo !== true) return;
    switch (msg.type) {
      case 'event':
      case 'settings':
      case 'identity':
        deliver(msg.type, msg.payload);
        break;
      case 'usage-data':
        usageData = msg.payload;
        break;
      // The show run drives Clippy's own menu: click an item by id, the same
      // as a user would. Anything the UI can do, the run can demonstrate.
      case 'poke-menu': {
        document.getElementById(msg.payload && msg.payload.item)?.click();
        break;
      }
      // The panel can poke the buddy for you — clicking through an iframe that
      // sits under a control panel is fiddly otherwise.
      case 'poke': {
        const el = document.getElementById('clippy');
        if (!el) break;
        if (msg.payload && msg.payload.button === 'right') {
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        } else {
          el.click();
        }
        break;
      }
    }
  });

  // Say hello once the page is built, so a 'poke' from the panel finds a buddy
  // to click. Anything that beats clippy.js still waits in the inbox above.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => post('ready'));
  } else {
    post('ready');
  }
})();
