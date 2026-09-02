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
    installPet: async () => ({ ok: false, error: 'Pack installation is available in the desktop app.' }),
    createPet: async ({ label, pixels }) => {
      const name = String(label || '').trim();
      if (!name) return { ok: false, error: 'give your buddy a name' };
      if (!Array.isArray(pixels) || !pixels.some(Boolean)) {
        return { ok: false, error: 'draw at least one pixel first' };
      }
      const id = `drawn-${Date.now()}`;
      state = {
        ...state,
        characters: [
          ...state.characters,
          { id, label: name, vector: 'orbit', poses: ['idle', 'excited'], removable: true },
        ],
      };
      push();
      return { ok: true, id, label: name };
    },
    removePet: async (id) => {
      state = { ...state, characters: state.characters.filter((character) => character.id !== id) };
      push();
      return { ok: true };
    },
    openExternal: (url) => window.open(url, '_blank', 'noopener'),
    fix: (what) => console.log('would fix', what),
  };
})();
