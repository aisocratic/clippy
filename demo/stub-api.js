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
    sendPrompt: (text, to) => post('send-prompt', { text, to }),
    // The bench has no sessions; the panel still needs a shape to lay out.
    agents: async () => {
      post('agents');
      return {
        showing: 'bench',
        pet: 'Bench',
        agents: [
          { sessionId: 'bench', name: 'bench', agent: 'claude', status: 'working', reachable: true },
          { sessionId: 'other', name: 'other-project', agent: 'codex', status: 'waiting', reachable: false },
        ],
      };
    },
    // In the app the pet's reply comes back from main over IPC invoke. The
    // bench has no model to ask, so it logs the question in the panel and
    // answers in character itself — enough to lay out the panel against.
    // The bench has no sessions, so nothing is ever routable.
    delegate: async () => ({ agent: null }),
    petSay: async (text) => {
      post('pet-say', { text });
      return { text: `(bench) “${String(text || '').slice(0, 48)}” — you say the nicest things.` };
    },
    // "read all" on a card main had to cut. In the app the rest of the message
    // is sitting in the main process; the bench has no main process, so it
    // hands back an obviously bench-made continuation — enough to watch the
    // card unfold and the window grow.
    cardFull: async (requestId) => {
      post('card-full', { requestId });
      return `${(document.getElementById('card-detail') || {}).textContent || ''}\n\n${
        '(bench) …and here is the rest of it. '.repeat(24)
      }`;
    },
    // The app opens the whole message in a window of its own; the bench has no
    // second window, so this only records the ask.
    openReader: (id, mine) => post('open-reader', { id, mine }),
    openActivityReader: (title, text) => post('open-activity-reader', { title, text }),
    openWindow: (opts) => post('open-window', opts || {}),
    pointAtPrompt: () => post('point'),
    openSettings: () => post('open-settings'),
    openExternal: (url) => post('open-external', { url }),
    fix: (what) => post('fix', { what }),
    setMode: (mode, height, width, anchor) => post('mode', { mode, height, width, anchor }),
    identity: async () => ({
      name: new URLSearchParams(location.search).get('name') || 'session',
      agent: new URLSearchParams(location.search).get('agent') === 'codex' ? 'codex' : 'claude',
      model: usageData?.session?.model || new URLSearchParams(location.search).get('model') || '',
    }),
    context: async () => ({ session: usageData?.session }),
    // main answers this over IPC invoke; here the panel pushes the data ahead
    // of time and we just hand back whatever it last set.
    usage: async () => usageData,
    // In the app these come from the session's own transcript; the bench
    // has no session, so it hands back something to lay out.
    feed: async () => {
      post('feed');
      return {
        source: 'tmux · clippy-bench-1',
        turns: [
          { role: 'user', kind: 'prompt', text: 'add a test for the parser', id: 'b1', tools: [] },
          { role: 'assistant', kind: 'say', text: 'Added one, and it fails on the empty case.', id: 'b2', tools: ['Edit'] },
        ],
      };
    },
    moveBy: (dx, dy) => post('move-by', { dx, dy }),
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
