'use strict';

/**
 * A session's last 24 hours as one strip, on its row in Settings: when it was
 * working, when it was waiting on you, and when it was done and it was your
 * turn — after the board's fleet activity column (the website's
 * fleet-activity.tsx), drawn from what Clippy itself saw.
 *
 * Main keeps each session's status changes (`history` in src/sessions.js);
 * this turns them into spans and words. Every strip is the same 24 hours
 * ending now, so they line up down the list and "now" is always the right
 * edge; idle is the line under the spans, so it is not a span of its own.
 *
 * Pure functions only, as deeds.js: settings.js keeps the DOM, and the tests
 * require this directly. Loaded as a plain script (window.ClippyStrip).
 */

const STRIP_DAY_MS = 24 * 60 * 60 * 1000;

// What each status is drawn as. Idle is not drawn.
const STRIP_STATES = { working: 'working', needs_permission: 'waiting', waiting: 'done' };
// …and what each is called, in a title and in the summary.
const STRIP_LABELS = { working: 'working', waiting: 'waiting on you', done: 'done' };

/**
 * The spans a history draws over the 24 hours ending `now`: `{ state, from,
 * to, open }`, oldest first, clipped to the window, with idle left out and a
 * state that runs on across two entries drawn once. `open` is the span still
 * going: its end is "now", whenever now is.
 *
 * @param {{status: string, at: number}[]} history  as main sends it
 */
function stripSpans(history, now, dayMs = STRIP_DAY_MS) {
  const start = now - dayMs;
  const list = Array.isArray(history) ? history : [];
  const spans = [];
  for (let i = 0; i < list.length; i++) {
    const state = STRIP_STATES[list[i] && list[i].status];
    const open = i === list.length - 1;
    const from = Math.max(start, Number(list[i].at) || 0);
    const to = Math.min(now, open ? now : Number(list[i + 1].at) || now);
    // A span that ended before the window opened is gone. One that has only
    // just begun is kept: it is what the session is doing now.
    if (!state || to < from || (to === from && !open)) continue;
    const last = spans[spans.length - 1];
    if (last && last.state === state && last.to === from) {
      last.to = to;
      last.open = open;
    } else {
      spans.push({ state, from, to, open });
    }
  }
  return spans;
}

/** "2h 05m", "40m", "<1m". */
function stripDuration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * "2h 05m working · 5m waiting on you · 40m done": time in each, in that
 * order. Empty when there was nothing to draw.
 */
function describeStrip(spans) {
  const total = {};
  for (const span of spans) total[span.state] = (total[span.state] || 0) + (span.to - span.from);
  const parts = Object.keys(STRIP_LABELS)
    .filter((state) => state in total)
    .map((state) => `${stripDuration(total[state])} ${STRIP_LABELS[state]}`);
  return parts.join(' · ');
}

/**
 * Where a span sits on the strip, as percentages of its width. A span too
 * short to see is drawn a sliver wide, back from "now" when it is at the edge,
 * so it can still be seen and hovered.
 */
function stripPlace(span, now, dayMs = STRIP_DAY_MS, min = 0.8) {
  const start = now - dayMs;
  const width = Math.max(((span.to - span.from) / dayMs) * 100, min);
  const left = Math.min(((span.from - start) / dayMs) * 100, 100 - width);
  return { left: Math.max(0, left), width };
}

const ClippyStrip = { STRIP_DAY_MS, STRIP_LABELS, stripSpans, stripDuration, describeStrip, stripPlace };

// The renderer reads the global; the tests require the module.
if (typeof module !== 'undefined' && module.exports) module.exports = ClippyStrip;
