'use strict';

/**
 * One buddy for all of them.
 *
 * Watch three agents at once and three paperclips on the desk are three windows
 * of the same creature. So there is one window, and it speaks for whichever
 * agent needs you, wearing that agent's name and colour while it does.
 *
 * Which window an event belongs to is the whole of the difference, so it lives
 * here as a pure decision rather than as a branch in main's event path — the
 * same bargain visibility.js makes for show/hide.
 */

/** The map key the shared window lives under. Not a session id, and can't collide with one. */
const SOLO_KEY = 'solo';

/**
 * Does this key share the one window?
 *
 * The sandbox is excluded on purpose: it exists to put every buddy on screen
 * at once to compare them, and collapsing it into a single window would take
 * away the only thing it does.
 */
function sharesWindow(key) {
  return Boolean(key) && !String(key).startsWith('sandbox:');
}

/**
 * Which window shows this session — the shared one, or its own if it is a
 * sandbox buddy.
 *
 * `key` still says which session an event is *about*; only the window it
 * arrives in changes.
 */
const windowKeyFor = (key) => (sharesWindow(key) ? SOLO_KEY : key);

/**
 * When a session ends, whose face should the window wear next?
 *
 * The shared window belongs to every session, so one of them ending is not a
 * reason to take it away. Returns the session to switch to, or null when that
 * was the last one and the window really should go.
 */
function successorFor(sessions, endedId) {
  const rest = (sessions || []).filter((s) => s && s.sessionId && s.sessionId !== endedId);
  if (!rest.length) return null;
  // Whoever is waiting on the user comes first — a window that can only show
  // one agent should show the one that needs something.
  const waiting = rest.find((s) => s.status === 'needs_permission' || s.status === 'waiting');
  return waiting || rest[0];
}

module.exports = { SOLO_KEY, sharesWindow, windowKeyFor, successorFor };
