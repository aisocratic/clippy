'use strict';

/**
 * The half of the bench bridge both pages share.
 *
 * demo/index.html and demo/states.html each drive iframes of the real
 * `src/renderer/` over the same postMessage protocol — the other end of it is
 * demo/stub-api.js, standing in for the Electron preload. They used to carry a
 * copy each of the envelope, the origin check and the action dispatcher, which
 * is exactly how the two drifted: a step the bench understood was a no-op on
 * the states page for no reason anybody had decided on.
 */

(function () {
  const MARKER = '__clippyDemo';

  /**
   * Post one bridge message at a frame. Everything here is same-origin (the
   * frames are pages off this same server), so the target origin is pinned
   * rather than left as '*' — nothing the bench says is meant for anyone else.
   */
  const post = (win, type, payload) => {
    if (win) win.postMessage({ [MARKER]: true, type, payload }, window.location.origin);
  };

  /**
   * Is this one of ours, from a frame we mounted? `sources` is the list of
   * contentWindows the page is willing to hear from; leaving it out accepts any
   * same-origin frame.
   */
  const isBridgeMessage = (event, sources) =>
    event.origin === window.location.origin &&
    Boolean(event.data) &&
    event.data[MARKER] === true &&
    (!sources || sources.some((win) => win === event.source));

  /**
   * Steps a page performs itself rather than handing to the renderer. `hooks`
   * says what this page can actually do: the states page has no window to dock
   * or walk down, so it leaves those out and they become no-ops.
   */
  function runAction(action, hooks) {
    switch (action && action.do) {
      case 'usage':
        // One left click is the whole gesture now: status, spend and the box to
        // reply in all arrive in the same panel.
        hooks.send('poke', { button: 'left' });
        break;
      case 'usage-close':
      case 'poke-menu':
        hooks.send('poke-menu', { item: action.item || 'btn-usage-close' });
        break;
      case 'set':
        hooks.setSetting(action.key, action.value);
        break;
      case 'dock':
        if (hooks.dock) hooks.dock(Boolean(action.value));
        break;
      case 'walk-to-prompt':
        if (hooks.walkToPrompt) hooks.walkToPrompt();
        break;
    }
  }

  window.ClippyBench = { MARKER, post, isBridgeMessage, runAction };
})();
