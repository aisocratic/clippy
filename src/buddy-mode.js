'use strict';

/**
 * One buddy per session, or one buddy for all of them.
 *
 * Watch three agents at once and you have three paperclips on your desk, which
 * is the point when it's three projects and a nuisance when it's three windows
 * of the same one. 'one' mode collapses them: a single window that speaks for
 * whichever agent needs you, wearing that agent's name, colour and face while
 * it does.
 *
 * Which window an event belongs to is the whole of the difference, so it lives
 * here as a pure decision rather than as a branch in main's event path — the
 * same bargain visibility.js makes for show/hide.
 */

/** The map key the shared window lives under. Not a session id, and can't collide with one. */
const SOLO_KEY = 'solo';

const MODES = ['each', 'one'];

/** Anything unrecognised behaves like today: a buddy each. */
const normalize = (mode) => (mode === 'one' ? 'one' : 'each');

/**
 * Does this key share the one window?
 *
 * The sandbox is excluded on purpose: it exists to put every buddy on screen
 * at once to compare them, and collapsing it into a single window would take
 * away the only thing it does.
 */
function sharesWindow(mode, key) {
  if (normalize(mode) !== 'one') return false;
  return Boolean(key) && !String(key).startsWith('sandbox:');
}

/**
 * Which window shows this session — its own, or the shared one.
 *
 * `key` still says which session an event is *about*; only the window it
 * arrives in changes.
 */
const windowKeyFor = (mode, key) => (sharesWindow(mode, key) ? SOLO_KEY : key);

/**
 * When a session ends in 'one' mode, whose face should the window wear next?
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

module.exports = { SOLO_KEY, MODES, normalize, sharesWindow, windowKeyFor, successorFor };
