'use strict';

/**
 * The sandbox gallery: one iframe of the real renderer per scenario, all on a
 * page you scroll. Where the bench (demo.js) drives one buddy through one
 * state at a time, this shows the whole cast at once — the fastest way to
 * judge a design change everywhere it lands.
 *
 * Each frame gets its own copy of the bench's message protocol: settings in,
 * scenario events in, and the frame's own 'mode' reports back out, which is
 * what sizes its cell. Delays inside a scenario are compressed — the point of
 * a wall of states is the final pose, not the journey — and held cards are
 * stamped with an hour so nothing counts down to a blank cell.
 */

const HOLD_MS = 60 * 60 * 1000;
const STEP_DELAY_CAP = 400;
const COMPACT_H = 200;

// States whose whole point is the window physically travelling across your
// desktop; an iframe in a grid can't show that honestly, so they're labelled
// instead of faked.
const WINDOW_MOTION = new Set(['dock', 'walk-to-prompt']);

const gallery = document.getElementById('gallery');
const frames = new Map(); // contentWindow -> entry, for routing replies
const entries = []; // every cell, for pushing a settings change to all of them

const post = (win, type, payload) => win.postMessage({ __clippyDemo: true, type, payload }, '*');

function sendOrQueue(entry, type, payload) {
  if (entry.ready) post(entry.iframe.contentWindow, type, payload);
  else entry.queue.push([type, payload]);
}

async function build() {
  const data = await fetch('/api/scenarios').then((r) => r.json());
  // Small by default: a wall of two dozen buddies reads better at 2x, and the
  // pickers above the grid swap character and size across every cell at once.
  const baseSettings = {
    approvals: true,
    reviewOnStop: true,
    answerQuestions: true,
    autoPerch: true,
    character: 'clip',
    size: 'small',
    characters: data.characters,
    sizes: data.sizes,
  };
  // A default usage payload so any state that opens the panel has numbers.
  const usage = data.usage && (data.usage.noplan || Object.values(data.usage)[0]);

  const pickCharacter = document.getElementById('pick-character');
  const pickSize = document.getElementById('pick-size');
  for (const c of data.characters) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.label || c.id;
    pickCharacter.appendChild(opt);
  }
  for (const s of data.sizes) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = `${s.id} (${s.buddy}px)`;
    pickSize.appendChild(opt);
  }
  pickCharacter.value = baseSettings.character;
  pickSize.value = baseSettings.size;
  const applyToAll = (key, value) => {
    for (const entry of entries) {
      entry.settings = { ...entry.settings, [key]: value };
      sendOrQueue(entry, 'settings', entry.settings);
    }
  };
  pickCharacter.addEventListener('change', () => applyToAll('character', pickCharacter.value));
  pickSize.addEventListener('change', () => applyToAll('size', pickSize.value));

  data.scenarios.forEach((scenario, i) => {
    const cell = document.createElement('section');
    cell.className = 'state';

    const head = document.createElement('h2');
    head.textContent = scenario.label;
    const group = document.createElement('span');
    group.className = 'group';
    group.textContent = scenario.group || '';
    head.appendChild(group);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = scenario.hint || '';

    cell.append(head, hint);

    const motionOnly = (scenario.steps || []).every(
      (s) => !s.event && s.action && WINDOW_MOTION.has(s.action.do)
    );
    if (motionOnly) {
      const note = document.createElement('p');
      note.className = 'motion';
      note.textContent = 'window-motion state — watch it in the app sandbox (npm run sandbox:app)';
      cell.appendChild(note);
      gallery.appendChild(cell);
      return;
    }

    const iframe = document.createElement('iframe');
    const color = data.palette[i % data.palette.length];
    iframe.src = `/renderer/?name=${encodeURIComponent(scenario.label)}&color=${encodeURIComponent(
      (color && color.color) || '#9aa3ad'
    )}`;
    iframe.style.height = `${COMPACT_H}px`;
    cell.appendChild(iframe);
    gallery.appendChild(cell);

    const entry = { iframe, queue: [], ready: false, settings: { ...baseSettings } };
    entries.push(entry);
    iframe.addEventListener('load', () => {
      frames.set(iframe.contentWindow, entry);
    });

    // Queue the whole story now; it flushes when the frame says 'ready'.
    sendOrQueue(entry, 'settings', entry.settings);
    if (usage) sendOrQueue(entry, 'usage-data', usage);
    let at = 0;
    let seq = 0;
    for (const step of scenario.steps || []) {
      at += Math.min(step.delay || 0, STEP_DELAY_CAP);
      const wait = at;
      const fire = () => {
        if (step.action) runAction(entry, step.action);
        if (!step.event) return;
        const event = { ...step.event };
        if (step.holdSecs) {
          event.requestId = `g${i}-${++seq}`;
          event.expiresAt = Date.now() + HOLD_MS;
        }
        sendOrQueue(entry, 'event', event);
      };
      entry.queue.push(['__timer__', { wait, fire }]);
    }
  });
}

function runAction(entry, action) {
  switch (action.do) {
    case 'usage':
      sendOrQueue(entry, 'poke', { button: 'left' });
      break;
    case 'usage-close':
    case 'poke-menu':
      sendOrQueue(entry, 'poke-menu', { item: action.item || 'btn-usage-close' });
      break;
    case 'set':
      entry.settings = { ...entry.settings, [action.key]: action.value };
      sendOrQueue(entry, 'settings', entry.settings);
      break;
    // dock / walk-to-prompt move a real window; a grid cell has nothing to move.
  }
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || msg.__clippyDemo !== true) return;
  const entry = frames.get(e.source);
  if (!entry) return;

  if (msg.type === 'ready') {
    entry.ready = true;
    for (const [type, payload] of entry.queue.splice(0)) {
      if (type === '__timer__') setTimeout(payload.fire, payload.wait);
      else post(e.source, type, payload);
    }
    return;
  }
  // The frame reports how tall its contents want to be — that is the cell's
  // height, exactly the way main resizes the real window.
  if (msg.type === 'mode') {
    const { mode, height } = msg.payload || {};
    entry.iframe.style.height = `${mode === 'full' && height ? Math.max(height, COMPACT_H) : COMPACT_H}px`;
  }
});

build();
