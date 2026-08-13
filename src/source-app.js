'use strict';

/**
 * What is asking, and where you go to answer it.
 *
 * A card that says "go to terminal" is a small lie in three of the four cases
 * Clippy now handles: a session in the ChatGPT app is not in a terminal, a
 * session in Claude has no tty at all, and one Clippy started in tmux has no
 * window to go to — you attach one. Getting the noun right matters more than it
 * sounds, because that button is the one thing on the card that moves you
 * somewhere, and a person who presses "terminal" and lands in an app has been
 * told the wrong thing about their own desk.
 *
 * So the source of a prompt is named once, here, and everything downstream —
 * the button, the card's header, the menu item, the tray — reads from it.
 *
 * Pure: this maps facts we already collected (the app bundle from the process
 * walk, TERM_PROGRAM from the hook headers, the tmux record) onto words. No
 * process table, no AppleScript.
 */

const { TERMINAL_APP, ITERM_APP } = require('./terminal');

/**
 * Agent hosts that are apps rather than terminals.
 *
 * Matched on bundle id first because that is the stable identifier — note that
 * ChatGPT.app ships as `com.openai.codex`, so "the ChatGPT app" and "the Codex
 * app" are one entry and not two, whatever the icon in the Dock says. Names are
 * a fallback for a build whose bundle id we have not seen.
 */
const GUI_HOSTS = [
  { bundle: 'com.openai.codex', names: ['ChatGPT', 'Codex'], label: 'ChatGPT' },
  { bundle: 'com.openai.atlas', names: ['ChatGPT Atlas', 'Atlas'], label: 'ChatGPT Atlas' },
  {
    bundle: 'com.anthropic.claudefordesktop',
    // Cowork is not a separate app: it runs inside Claude.app, so a Cowork
    // session resolves here and "go to Claude" is where its window is.
    names: ['Claude', 'Cowork', 'Claude Cowork'],
    label: 'Claude',
  },
];

/** The bundle id out of an app path, or '' — `/Applications/X.app` -> ''. */
const bundleIdOf = (app) => (app && typeof app.bundleId === 'string' ? app.bundleId : '');

/** Is this `.app` one of the agent hosts we know by name? */
function guiHostFor(app) {
  if (!app) return null;
  const bundle = bundleIdOf(app);
  const name = String(app.name || '');
  return (
    GUI_HOSTS.find((host) => bundle && host.bundle === bundle) ||
    GUI_HOSTS.find((host) => host.names.includes(name)) ||
    null
  );
}

/** What Terminal.app and iTerm2 are called when we only know TERM_PROGRAM. */
const PROGRAM_LABELS = {
  [TERMINAL_APP]: 'Terminal',
  [ITERM_APP]: 'iTerm',
};

/**
 * Name the place a session lives.
 *
 * @param {object} [where]
 * @param {string} [where.program]  TERM_PROGRAM, as the hook reported it
 * @param {object} [where.app]      {name, bundleId} from the process walk
 * @param {object} [where.tmux]     the spawned-session record, when Clippy started it
 * @returns {{kind: 'tmux'|'app'|'terminal'|'unknown', name: string, label: string, goLabel: string, known: boolean}}
 *   `name`    what to call it in prose ("ChatGPT", "Ghostty", "tmux")
 *   `label`   the noun for the place ("the ChatGPT app", "its terminal")
 *   `goLabel` the button ("go to ChatGPT ↗", "attach a terminal ↗")
 *   `known`   is there anywhere to actually send someone?
 */
function describeSource({ program = '', app = null, tmux = null } = {}) {
  // Checked first: a session Clippy started in tmux may well have an app
  // ancestor (the terminal Clippy itself was launched from), and that window
  // has nothing to do with the pane the agent is in.
  if (tmux) {
    const host = tmux.host ? ` on ${tmux.host}` : '';
    return {
      kind: 'tmux',
      name: `tmux${host}`,
      label: `its tmux session${host}`,
      goLabel: 'attach a terminal ↗',
      known: true,
    };
  }

  const gui = guiHostFor(app);
  if (gui) {
    return {
      kind: 'app',
      name: gui.label,
      label: `the ${gui.label} app`,
      goLabel: `go to ${gui.label} ↗`,
      known: true,
    };
  }

  const name = (app && app.name) || PROGRAM_LABELS[program] || '';
  if (name) {
    return {
      kind: 'terminal',
      name,
      label: `its ${name} window`,
      goLabel: `go to ${name} ↗`,
      known: true,
    };
  }

  // We know a prompt happened but not where. The button still works often
  // enough to offer — the raise path re-resolves from scratch — so this is
  // wording, not a capability check.
  return {
    kind: 'unknown',
    name: '',
    label: 'its terminal',
    goLabel: 'go to terminal ↗',
    known: false,
  };
}

module.exports = { describeSource, guiHostFor, GUI_HOSTS, PROGRAM_LABELS };
