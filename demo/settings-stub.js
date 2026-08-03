'use strict';

/**
 * Browser stand-in for src/preload-settings.js, so the settings window can be
 * worked on in the test bench. Same surface, backed by the demo server instead
 * of the main process: settings changes are kept in memory here and echoed
 * back, exactly as main would echo them.
 */

(function () {
  let state = null;
  const listeners = [];

  const push = () => listeners.forEach((cb) => cb(state));

  window.clippySettings = {
    onState: (cb) => {
      listeners.push(cb);
      if (state) cb(state);
    },
    ready: async () => {
      state = await fetch('/api/settings-state').then((r) => r.json());
      push();
    },
    setSetting: (key, value) => {
      if (!state) return;
      state = { ...state, [key]: value };
      push();
    },
    showBuddy: (sessionId) => console.log('would show the buddy for', sessionId),
  };
})();
