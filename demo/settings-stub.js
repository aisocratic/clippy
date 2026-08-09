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
    // Main writes both levels (see assignCharacter there); the bench keeps the
    // session one, which is what the pickers read back.
    assign: (sessionId, character) => {
      const bySession = { ...(state.characterBySession || {}) };
      if (character) bySession[sessionId] = character;
      else delete bySession[sessionId];
      const sessions = (state.sessions || []).map((s) =>
        s.sessionId === sessionId && character ? { ...s, character } : s
      );
      state = { ...state, characterBySession: bySession, sessions };
      push();
    },
    assignSize: (sessionId, size) => {
      const bySession = { ...(state.sizeBySession || {}) };
      if (size) bySession[sessionId] = size;
      else delete bySession[sessionId];
      state = { ...state, sizeBySession: bySession };
      push();
    },
    openExternal: (url) => window.open(url, '_blank', 'noopener'),
    fix: (what) => console.log('would fix', what),
  };
})();
