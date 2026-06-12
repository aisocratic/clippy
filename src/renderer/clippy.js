'use strict';

const REMIND_AFTER_MS = 90 * 1000; // re-bounce if a session is still ignored
const SNOOZE_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 1000;

const clippyEl = document.getElementById('clippy');
const bubbleEl = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const badgeEl = document.getElementById('badge');
const statusEl = document.getElementById('statusline');

// sessionId -> { message, urgency, name, lastNudge, snoozedUntil, acknowledged }
const pending = new Map();
let counts = { total: 0, waiting: 0 };

/* ---------- UI helpers ---------- */

function setExcited(on) {
  clippyEl.classList.toggle('excited', on);
}

function showBubble(text) {
  bubbleText.textContent = text;
  bubbleEl.classList.remove('hidden');
}

function hideBubble() {
  bubbleEl.classList.add('hidden');
  setExcited(false);
}

function render() {
  const active = [...pending.values()].filter((p) => !p.acknowledged);
  badgeEl.textContent = String(active.length);
  badgeEl.classList.toggle('hidden', active.length === 0);

  if (counts.total === 0) {
    statusEl.textContent = 'no sessions yet — start claude in a terminal';
  } else {
    statusEl.textContent =
      `${counts.total} session${counts.total === 1 ? '' : 's'}` +
      (counts.waiting ? ` · ${counts.waiting} waiting for you` : ' · all busy');
  }
}

function nudge(p) {
  p.lastNudge = Date.now();
  showBubble(p.message);
  setExcited(p.urgency === 'urgent');
  if (p.urgency !== 'urgent') {
    // brief hop even for gentle news
    setExcited(true);
    setTimeout(() => {
      if (!currentUrgent()) setExcited(false);
    }, 1600);
  }
}

function currentUrgent() {
  return [...pending.values()].some((p) => !p.acknowledged && p.urgency === 'urgent');
}

/* ---------- Event handling from main process ---------- */

window.clippyAPI.onEvent((evt) => {
  if (evt.counts) counts = evt.counts;

  switch (evt.kind) {
    case 'attention': {
      const p = {
        message: evt.message,
        urgency: evt.urgency,
        name: evt.name,
        lastNudge: 0,
        snoozedUntil: 0,
        acknowledged: false,
      };
      pending.set(evt.sessionId, p);
      nudge(p);
      break;
    }
    case 'clear': // user typed a prompt — that session no longer needs us
    case 'remove': {
      pending.delete(evt.sessionId);
      if (pending.size === 0 || ![...pending.values()].some((p) => !p.acknowledged)) {
        hideBubble();
      }
      break;
    }
    case 'info':
      showBubble(evt.message);
      setTimeout(() => {
        if (![...pending.values()].some((p) => !p.acknowledged)) hideBubble();
      }, 4000);
      break;
  }
  render();
});

/* ---------- Reminder loop: Clippy doesn't give up ---------- */

setInterval(() => {
  const now = Date.now();
  for (const p of pending.values()) {
    if (p.acknowledged || now < p.snoozedUntil) continue;
    if (now - p.lastNudge >= REMIND_AFTER_MS) {
      p.message = p.message.startsWith('Still ')
        ? p.message
        : `Still here! ${p.message}`;
      nudge(p);
    }
  }
}, CHECK_INTERVAL_MS);

/* ---------- Buttons ---------- */

document.getElementById('btn-ok').addEventListener('click', () => {
  for (const p of pending.values()) p.acknowledged = true;
  hideBubble();
  render();
});

document.getElementById('btn-snooze').addEventListener('click', () => {
  const until = Date.now() + SNOOZE_MS;
  for (const p of pending.values()) p.snoozedUntil = until;
  hideBubble();
  render();
});

document.getElementById('btn-hide').addEventListener('click', () => {
  window.clippyAPI.hide();
});

// Clicking Clippy re-opens the bubble with whatever is pending.
clippyEl.addEventListener('click', () => {
  const next = [...pending.values()].find((p) => !p.acknowledged) || [...pending.values()][0];
  if (next) nudge(next);
});

/* ---------- Idle life: blinking & wandering pupils ---------- */

const eyes = [...document.querySelectorAll('.eye')];
const pupils = [...document.querySelectorAll('.pupil')];

setInterval(() => {
  eyes.forEach((e) => e.classList.add('blink'));
  setTimeout(() => eyes.forEach((e) => e.classList.remove('blink')), 140);
}, 3800 + Math.random() * 1500);

setInterval(() => {
  const dx = (Math.random() * 6 - 3).toFixed(1);
  const dy = (Math.random() * 4 - 2).toFixed(1);
  pupils.forEach((p) => (p.style.transform = `translate(${dx}px, ${dy}px)`));
}, 2600);

render();
