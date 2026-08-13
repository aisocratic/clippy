'use strict';

/**
 * Nothing said to a buddy gets lost on the way.
 *
 * A BrowserWindow accepts `webContents.send` from the moment it exists, and
 * throws it away until the page inside has run its `ipcRenderer.on`. Clippy
 * creates a window and describes what it wants to say in the same tick — that
 * is the normal path, not an edge case — so the very first card of a session
 * was being sent into a renderer that was not listening yet, and simply never
 * appeared. The agent kept holding its hook open for two minutes waiting on a
 * card nobody could see.
 *
 * Two places already worked around this one at a time (the appearance sound
 * waits for `did-finish-load`; `wearIdentity` skips a push and lets the load
 * handler replay it). This makes it a property of the channel instead: post
 * whenever you like, and anything said too early is delivered the moment the
 * page is listening, in the order it was said.
 *
 * The send function is injected so the queueing is testable without Electron.
 */

/**
 * How many messages to hold for a window that has not loaded yet.
 *
 * A page that never loads must not become a memory leak, and past a certain
 * depth the backlog is not worth replaying anyway — nobody wants forty cards
 * arriving at once. The oldest go first: the newest state is the one worth
 * having.
 */
const DEFAULT_CAP = 60;

/**
 * @param {object} opts
 * @param {(channel: string, payload: any) => void} opts.send  the real delivery
 * @param {number} [opts.cap]
 * @param {(dropped: number) => void} [opts.onDrop]  told when the queue overflows
 */
function createOutbox({ send, cap = DEFAULT_CAP, onDrop = null }) {
  let ready = false;
  let queue = [];

  return {
    /** Say something, whether or not the page is listening yet. */
    post(channel, payload) {
      if (ready) {
        send(channel, payload);
        return true;
      }
      queue.push([channel, payload]);
      if (queue.length > cap) {
        const dropped = queue.length - cap;
        queue = queue.slice(dropped);
        if (onDrop) onDrop(dropped);
      }
      return false;
    },

    /** The page is listening: everything held back goes now, in order. */
    open() {
      ready = true;
      const held = queue;
      queue = [];
      for (const [channel, payload] of held) send(channel, payload);
      return held.length;
    },

    /**
     * The page is going away and a new one is coming (a reload, a crash
     * recovery). Anything said in the meantime waits for the new one, rather
     * than being handed to a renderer on its way out.
     */
    close() {
      ready = false;
    },

    get isOpen() {
      return ready;
    },
    get waiting() {
      return queue.length;
    },
  };
}

module.exports = { createOutbox, DEFAULT_CAP };
