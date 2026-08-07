'use strict';

/**
 * The session status summary — the compact card a left click opens first.
 *
 * Pure functions only: what the card *says* (the state in plain words, the one
 * line about what the agent is doing) lives here so the Node test runner can
 * reach it, while clippy.js keeps the DOM. Loaded as a plain script in the
 * renderer (window.ClippySummary) and required directly by the tests.
 */

// The session's state, in the words the compact card leads with. These are
// deliberately not STATUS_TEXT: the card answers "is it going or is it on me?",
// so the words are about motion, not about the hook that fired.
const SUMMARY_STATE = {
  idle: 'paused — waiting for a prompt',
  working: 'running',
  waiting: 'waiting for your answer',
  needs_permission: 'needs your permission',
};

/** The state line for the compact card; unknown states pass through as-is. */
function summaryState(status) {
  return SUMMARY_STATE[status] || String(status || 'idle');
}

/**
 * One line, no matter what came in: whitespace (including newlines from a
 * transcript recap) flattened, and anything past `max` cut on an ellipsis —
 * the compact card is a glance, not a place to scroll.
 */
function oneLine(text, max = 160) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The "what is it doing right now" line: mid-turn the live activity line is
 * the truest answer, between turns it's the last thing Claude actually said.
 * Either can be missing (a turn that ends on a bare tool call has no recap),
 * so each falls back to the other, and to nothing.
 */
function summaryRecap({ status, activity, recap } = {}) {
  const doing = oneLine(activity);
  const said = oneLine(recap);
  return status === 'working' ? doing || said : said || doing;
}

const ClippySummary = { summaryState, summaryRecap, oneLine };

// The renderer reads the global; the tests require the module.
if (typeof module !== 'undefined' && module.exports) module.exports = ClippySummary;
