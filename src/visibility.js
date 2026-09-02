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
    case 'failure': // a failed tool with a compact problem preview
      return 'show';

    case 'clear': // user typed a new prompt — they're back in the terminal
    case 'activity': // ambient tool use while Claude works
    case 'info': // session start and other chatter
      return 'hide';

    default:
      return null;
  }
}

module.exports = { windowActionFor };
