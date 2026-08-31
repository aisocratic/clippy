'use strict';

/**
 * Clippy is meant to be out of sight until it has something to say. Windows are
 * created hidden and only pop up when a session actually wants the user —
 * Claude finished a turn, or it's asking something (permission, plan,
 * question). Everything ambient (session start, tool activity, the user typing
 * a new prompt) sends the window back into hiding.
 *
 * Pure mapping so the policy is testable without Electron.
 *
 * @param {string} kind  reaction kind from SessionTracker / the hook handlers
 * @returns {'show'|'hide'|null}  null = leave the window however it is
 */
function windowActionFor(kind) {
  switch (kind) {
    case 'attention': // Claude finished, or is still waiting on the user
    case 'approval': // permission / plan approval card
    case 'answer': // answerable AskUserQuestion
    case 'question': // read-only AskUserQuestion (answer in the terminal)
    case 'review': // "Claude finished — looks good?"
      return 'show';

    case 'clear': // user typed a new prompt — they're back in the terminal
    case 'activity': // ambient tool use while Claude works
    case 'info': // session start and other chatter
      return 'hide';

    default:
      return null;
  }
}

/**
 * Should a 'show' actually pop the window for a buddy the user hid by hand?
 *
 * Claude re-sends idle reminders while a session sits at the prompt, and
 * re-opening a popup the user just closed is how a helper becomes a pest: the
 * window's contents still refresh underneath (the event is always delivered),
 * it just stays down. A dismissed buddy still comes back for anything urgent
 * (a permission request) and for the interactive cards (approval / question /
 * review), which carry new work rather than a repeat of the same wait. Main
 * lifts the dismissal on 'clear'/'activity', because those mean the world
 * moved on.
 *
 * @param {string} kind     reaction kind (see windowActionFor)
 * @param {string} urgency  'urgent' | 'normal' | 'low'
 * @param {boolean} dismissed  the user hid this buddy and nothing lifted it
 * @returns {boolean} pop the window
 */
function resurfaces(kind, urgency, dismissed) {
  if (!dismissed) return true;
  return !(kind === 'attention' && urgency !== 'urgent');
}

module.exports = { windowActionFor, resurfaces };
