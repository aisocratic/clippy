'use strict';

/**
 * The activity log's words — what a chip under Clippy says and what the reader
 * window behind it explains.
 *
 * Pure functions only, same arrangement as summary.js: clippy.js keeps the DOM
 * and the list, this decides what an entry is called, what its full page says,
 * and whether a new entry replaces, collapses into, or joins the ones before
 * it. Loaded as a plain script in the renderer (window.ClippyDeeds) and
 * required directly by the tests.
 */

// What the buddy did, in the past tense the chip leads with.
const DEED_WORDS = {
  allow: 'allowed',
  deny: 'denied',
  pass: 'handed back',
  dismiss: 'waved away',
  answer: 'answered',
  feedback: 'sent feedback on',
  ok: 'signed off',
};

const HEADLINE_MAX = 70;
const DEEDS_KEPT = 50;

/** One line, clipped on an ellipsis — the chip is a glance, not a page. */
function clip(text, max = HEADLINE_MAX) {
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * What the agent said as the turn ended. Main puts the whole recap in
 * `detail` only when there was more of it than a headline; a one-liner
 * arrives quoted inside the card title instead, and a turn that ended on a
 * bare tool call has neither.
 */
function recapOf(req = {}) {
  const detail = String(req.detail || '').trim();
  if (detail) return detail;
  const quoted = /^.*? finished: “([\s\S]*)”$/i.exec(String(req.title || '').trim());
  return quoted ? quoted[1].trim() : '';
}

/** The recap's first non-empty line, chip-sized. Empty when there is no recap. */
function headlineOf(req = {}) {
  const first = recapOf(req)
    .split('\n')
    .find((line) => line.trim());
  return clip(first || '');
}

/** Quoted for a chip: `signed off: “Parser fixed; tests pass.”`. */
const quote = (headline) => `“${headline}”`;

/**
 * The entry for a card you just dealt with.
 *
 * Reviews get a real name: "signed off the last turn" told you nothing once
 * the card was gone, and the reader page behind it repeated the same three
 * words. Now the chip carries what the turn ended with, and the page says
 * who finished, what you did about it, and what it said — so a second look
 * a minute later still makes sense.
 *
 * `key` names the turn (`review:<id>`), so the entry written when the card
 * arrived ("finished: …") is replaced rather than joined: one chip per turn.
 */
function deedFor(action, req = {}, message = '') {
  const word = DEED_WORDS[action] || action;
  if (req.type !== 'review') {
    return { key: '', text: `${word} ${req.title || 'a request'}`, detail: '' };
  }

  const who = req.name || 'The agent';
  const key = req.id ? `review:${req.id}` : '';
  const recap = recapOf(req);
  const headline = headlineOf(req);
  const asked = String(req.prompt || '').trim();
  const said = String(message || '').trim();
  const itSaid = `It said:\n${recap || '(nothing — the turn ended on a tool call, with no closing message)'}`;

  if (action === 'ok') {
    return {
      key,
      text: headline ? `signed off: ${quote(headline)}` : 'signed off a turn that ended without a message',
      detail: [
        `${who} finished a turn and you signed it off (Looks good).`,
        asked && `You asked:\n${asked}`,
        itSaid,
      ]
        .filter(Boolean)
        .join('\n\n'),
    };
  }
  if (action === 'feedback') {
    return {
      key,
      text: headline ? `sent feedback on: ${quote(headline)}` : 'sent feedback on the last turn',
      detail: [
        `${who} finished a turn and you sent feedback.`,
        said && `You said:\n${said}`,
        asked && `You asked:\n${asked}`,
        itSaid,
      ]
        .filter(Boolean)
        .join('\n\n'),
    };
  }
  return {
    key,
    text: headline ? `${word} ${quote(headline)}` : `${word} the last turn`,
    detail: [`${who} finished a turn (${word}).`, asked && `You asked:\n${asked}`, itSaid]
      .filter(Boolean)
      .join('\n\n'),
  };
}

/**
 * The entry for a finished-turn card arriving — the "we completed this" line,
 * worth keeping whether or not the card is ever answered. Keyed to the turn so
 * signing off later replaces it instead of standing next to it.
 */
function reviewArrivalDeed(evt = {}) {
  const req = { type: 'review', title: evt.message, detail: evt.detail };
  const recap = recapOf(req);
  const headline = headlineOf(req);
  return {
    key: evt.requestId ? `review:${evt.requestId}` : '',
    text: headline ? `finished: ${headline}` : 'finished a turn',
    detail: recap ? `${evt.name || 'The agent'} finished a turn.\n\nIt said:\n${recap}` : '',
  };
}

/**
 * Put an entry at the front of the log. Returns the new list; the old one is
 * left alone.
 *
 * - An entry with the same `key` as one already there replaces it: one chip
 *   per turn, "finished: X" becoming "signed off: X" rather than joining it.
 * - An unkeyed entry that says exactly what the newest one already says (same
 *   words, same agent) is folded into it instead of being shown twice: the
 *   newest keeps its place, its clock moves, and its `count` goes up.
 * - Anything else goes on top. The list never grows past `kept`.
 */
function recordDeed(list, deed, { kept = DEEDS_KEPT } = {}) {
  const rest = deed.key ? list.filter((d) => d.key !== deed.key) : list.slice();
  const newest = rest[0];
  if (!deed.key && newest && !newest.key && newest.text === deed.text && newest.who === deed.who) {
    rest[0] = { ...newest, at: deed.at, count: (newest.count || 1) + 1 };
    return rest.slice(0, kept);
  }
  return [deed, ...rest].slice(0, kept);
}

const ClippyDeeds = { DEED_WORDS, headlineOf, deedFor, reviewArrivalDeed, recordDeed };

// The renderer reads the global; the tests require the module.
if (typeof module !== 'undefined' && module.exports) module.exports = ClippyDeeds;
