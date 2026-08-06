'use strict';

/**
 * Control panel for the web test bench: plays scenarios at the renderer in the
 * iframe and prints whatever it sends back. This is the "main process" half of
 * the bridge — the other half is demo/stub-api.js, which stands in for the
 * Electron preload.
 */

const frame = document.getElementById('buddy-frame');
const desktop = document.getElementById('desktop');
const terminal = document.getElementById('fake-terminal');
const logEl = document.getElementById('log');
const noteEl = document.getElementById('note');

// Same geometry main uses (src/main.js): a bare buddy until there's a card,
// then as tall as the renderer says it needs to be. The compact size comes from
// the size roster, so it tracks whichever size is selected.
const FULL_W = 268;
const FALLBACK_H = 470;
const MIN_FULL_H = 190;
// Which of the two window sizes the frame is at. Tracked rather than measured:
// the frame's width animates, so reading offsetWidth mid-transition reports the
// size it is leaving, not the one it is at.
let frameMode = 'compact';
const compactSize = () => {
  const step = (settings.sizes || []).find((s) => s.id === settings.size);
  return (step && step.win) || [108, 136];
};
// Matches the walk in src/main.js, so the bench looks like the app.
const WALK_MS = 900;
const POINT_MS = 5000;
const POINT_EXTRA_H = 30;
let walkTimers = [];
let spriteTimers = []; // the workbench animations, cleared on every re-render
let previewPose = 'idle';

let data = { scenarios: [], usage: {}, palette: [], characters: [], sizes: [] };
// Mirrors main's settings, including the rosters the renderer builds its menu
// from — same payload shape, so the menu behaves exactly as it does in the app.
let settings = {
  approvals: true,
  reviewOnStop: true,
  answerQuestions: true,
  autoPerch: true,
  character: 'clip',
  size: 'medium',
  characters: [],
  sizes: [],
};
let ready = false;
const queued = []; // messages posted before the frame said hello
let timers = []; // scenario steps still to fire
let reqSeq = 0;
// requestId -> what this request was, so a decision can be scored like a hook
const openRequests = new Map();

/* ---------------- bridge ---------------- */

function send(type, payload) {
  const msg = { __clippyDemo: true, type, payload };
  if (!ready) {
    queued.push(msg);
    return;
  }
  frame.contentWindow.postMessage(msg, '*');
}

function flushQueue() {
  while (queued.length) frame.contentWindow.postMessage(queued.shift(), '*');
}

function log(dir, key, message) {
  const line = document.createElement('div');
  line.className = `line ${dir}`;
  const now = new Date();
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = now.toTimeString().slice(0, 8);
  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = key;
  const m = document.createElement('span');
  m.className = 'm';
  m.textContent = message;
  line.append(t, k, m);
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

/* ---------------- playing a scenario ---------------- */

function stopPlayback() {
  timers.forEach(clearTimeout);
  timers = [];
  walkTimers.forEach(clearTimeout);
  walkTimers = [];
  document.querySelectorAll('.scenario.playing').forEach((b) => b.classList.remove('playing'));
  // Anything still held from the last scenario would stack up behind the new
  // card. Main closes stale requests the same way when a session moves on.
  for (const id of openRequests.keys()) {
    send('event', { kind: 'request-closed', requestId: id, outcome: 'cancel' });
  }
  openRequests.clear();
}

/** kind -> the Claude Code hook that would have produced this card. */
const HOOK_FOR = { approval: 'PermissionRequest', review: 'Stop', answer: 'PreToolUse' };

function playScenario(scenario, button) {
  stopPlayback();
  button?.classList.add('playing');
  const refs = new Map(); // ref name -> requestId, so a later step can close it
  let at = 0;

  scenario.steps.forEach((step, i) => {
    at += step.delay || 0;
    const timer = setTimeout(() => {
      if (step.note) showNote(step.note);
      if (step.action) runAction(step.action);
      if (!step.event) {
        if (i === scenario.steps.length - 1) finishRun(button);
        return;
      }
      const event = { ...step.event };

      if (step.holdSecs) {
        const id = `demo-${++reqSeq}`;
        event.requestId = id;
        event.expiresAt = Date.now() + step.holdSecs * 1000;
        if (step.ref) refs.set(step.ref, id);
        openRequests.set(id, {
          hook: HOOK_FOR[event.kind] || '',
          toolInput: event.questions ? { questions: event.questions } : {},
          label: event.title || event.message || event.kind,
        });
      } else if (step.ref && refs.has(step.ref)) {
        event.requestId = refs.get(step.ref);
      }

      send('event', event);
      log('out', event.kind, describeEvent(event));

      if (i === scenario.steps.length - 1) finishRun(button);
    }, at);
    timers.push(timer);
  });
}

function finishRun(button) {
  setTimeout(() => {
    button?.classList.remove('playing');
    noteEl.classList.remove('on');
  }, 400);
}

/** The caption over the stage: what the show run is demonstrating right now. */
function showNote(text) {
  noteEl.textContent = text;
  noteEl.classList.add('on');
  log('note', 'show run', text);
}

/** Steps that the panel performs rather than the renderer. */
function runAction(action) {
  switch (action.do) {
    case 'usage':
      // One left click is the whole gesture now: status, spend and the box to
      // reply in all arrive in the same panel.
      send('poke', { button: 'left' });
      break;
    case 'usage-close':
      send('poke-menu', { item: 'btn-usage-close' });
      break;
    case 'set':
      settings = { ...settings, [action.key]: action.value };
      syncSettingInputs();
      send('settings', settings);
      log('out', 'settings', `${action.key} = ${action.value}`);
      break;
    case 'dock':
      setDocked(Boolean(action.value));
      break;
    case 'walk-to-prompt':
      walkToPrompt();
      break;
    case 'poke-menu':
      send('poke-menu', { item: action.item });
      break;
  }
}

/**
 * The bench's stand-in for main's walk (pointAtPrompt in src/main.js): step the
 * window down to the terminal's input line, hold there pointing, stroll back.
 * Main moves the real window frame by frame; here the browser tweens it.
 */
function walkToPrompt() {
  if (!desktop.classList.contains('docked')) setDocked(true);
  const term = terminal.getBoundingClientRect();
  const stage = desktop.getBoundingClientRect();
  const w = frame.offsetWidth;
  const h = frame.offsetHeight + POINT_EXTRA_H; // room for the arrow underneath

  frame.style.height = `${h}px`;
  frame.style.transition = `left ${WALK_MS}ms ease-in-out, top ${WALK_MS}ms ease-in-out`;
  send('event', { kind: 'walk', facing: 'left' });
  frame.style.right = 'auto';
  frame.style.bottom = 'auto';
  frame.style.left = `${term.left - stage.left + 18}px`;
  frame.style.top = `${term.top - stage.top + term.height - 62 - h}px`;
  log('out', 'walk', 'strolling to the prompt');

  walkTimers.forEach(clearTimeout);
  walkTimers = [
    setTimeout(() => {
      send('event', { kind: 'point', on: true });
      log('out', 'point', 'standing on the input line');
    }, WALK_MS + 50),
    setTimeout(() => {
      send('event', { kind: 'point', on: false });
      send('event', { kind: 'walk', facing: 'right' });
      frame.style.left = '';
      frame.style.top = '';
    }, WALK_MS + POINT_MS),
    setTimeout(() => {
      // Back on the perch: hand the position back to the stylesheet.
      frame.style.transition = '';
      frame.style.right = '';
      frame.style.bottom = '';
      frame.style.height = `${frame.offsetHeight - POINT_EXTRA_H}px`;
    }, WALK_MS * 2 + POINT_MS),
  ];
}

function describeEvent(e) {
  const bits = [];
  if (e.status) bits.push(`status=${e.status}`);
  if (e.title) bits.push(e.title);
  if (e.message) bits.push(e.message);
  if (e.label) bits.push(e.label);
  if (e.activity) bits.push(e.activity.label + (e.activity.ok ? '' : ' (failed)'));
  if (e.activity === null) bits.push('activity cleared');
  if (e.text) bits.push(`${e.role}: ${e.text}`);
  if (e.requestId) bits.push(`#${e.requestId}`);
  return bits.join(' · ') || JSON.stringify(e);
}

/* ---------------- messages coming back from the renderer ---------------- */

window.addEventListener('message', async (e) => {
  const msg = e.data;
  if (!msg || msg.__clippyDemo !== true || e.source !== frame.contentWindow) return;
  const p = msg.payload || {};

  switch (msg.type) {
    case 'ready':
      ready = true;
      flushQueue();
      send('settings', settings);
      send('usage-data', data.usage[document.getElementById('opt-usage').value]);
      send('event', { kind: 'can-open', value: document.getElementById('set-canopen').checked });
      // Whatever size the frame is already at decides the layout — saying
      // "not compact" here would leave a bare buddy wearing the full chrome.
      send('event', {
        kind: 'dock',
        docked: desktop.classList.contains('docked'),
        compact: frameMode === 'compact',
      });
      log('note', 'renderer', 'loaded — clippyAPI stub attached');
      break;

    case 'mode': {
      // Main owns the geometry; here the iframe is the window. The renderer
      // measures how tall its contents need to be — clamp it to the fake
      // desktop the way main clamps to the display's work area.
      frameMode = p.mode;
      const [w, fallback] = p.mode === 'compact' ? compactSize() : [FULL_W, FALLBACK_H];
      const h =
        p.mode === 'compact'
          ? fallback
          : Math.round(
              Math.max(MIN_FULL_H, Math.min(Number(p.height) || fallback, desktop.clientHeight - 24))
            );
      frame.style.width = `${w}px`;
      frame.style.height = `${h}px`;
      send('event', {
        kind: 'dock',
        docked: desktop.classList.contains('docked'),
        compact: p.mode === 'compact',
      });
      log('in', 'setMode', `${p.mode} — asked for ${Math.round(p.height || 0)}px, window ${w}×${h}`);
      break;
    }

    case 'decide': {
      const req = openRequests.get(p.id);
      log('in', 'decide', `${p.action}${p.message ? ` — “${p.message}”` : ''} on ${req ? req.label : p.id}`);
      openRequests.delete(p.id);
      if (req && req.hook) {
        const res = await fetch('/api/decision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: req.hook,
            action: p.action,
            message: p.message,
            toolInput: req.toolInput,
          }),
        })
          .then((r) => r.json())
          .catch(() => null);
        if (res) {
          const json = JSON.stringify(res.response);
          log(
            'note',
            req.hook,
            json === '{}'
              ? '{} — no opinion, Claude Code falls back to the terminal'
              : json
          );
        }
      }
      break;
    }

    case 'extend': {
      // Main pushes the deadline out while you type; mirror that so the
      // countdown bar behaves the way it does in the app.
      const expiresAt = Date.now() + 30_000;
      send('event', { kind: 'extended', requestId: p.id, expiresAt });
      log('in', 'extend', `${p.id} → +30s`);
      break;
    }

    case 'set-setting':
      settings = { ...settings, [p.key]: p.value };
      syncSettingInputs();
      send('settings', settings);
      log('in', 'setSetting', `${p.key} = ${p.value}`);
      break;

    case 'drive-prompt':
      log('in', 'drivePrompt', p.text);
      // Echo the turn back like a driven SDK session would.
      send('event', { kind: 'drive-transcript', role: 'user', text: p.text });
      setTimeout(() => send('event', { kind: 'drive-activity', label: 'Thinking…' }), 400);
      setTimeout(() => {
        send('event', {
          kind: 'drive-transcript',
          role: 'assistant',
          text: `(demo) I would work on: ${p.text}`,
        });
        send('event', { kind: 'drive-status', status: 'turn-done' });
      }, 1600);
      break;

    case 'drive-stop':
      log('in', 'driveStop', 'session stopped');
      send('event', { kind: 'drive-status', status: 'ended' });
      break;

    case 'undock':
      log('in', 'undock', 'let go of the terminal window');
      setDocked(false);
      break;

    case 'open-window':
      log('in', 'openWindow', 'raise the terminal window and perch on it');
      setDocked(true);
      // `point: true` means the answer has to be typed on that prompt — main
      // walks over once it has landed, so the bench does too.
      if (p.point) setTimeout(walkToPrompt, 500);
      break;

    case 'point':
      log('in', 'pointAtPrompt', 'show me where to answer');
      walkToPrompt();
      break;

    case 'fix':
      log('in', 'fix', `would open macOS ${p.what} settings`);
      break;

    case 'open-settings':
      log('in', 'openSettings', 'would open the settings window (/settings/ here)');
      window.open('/settings/', '_blank', 'noopener');
      break;

    case 'hide':
      log('in', 'hide', 'would hide the window (kept visible here so you can carry on)');
      break;

    case 'quit':
      log('in', 'quit', 'would quit the app');
      break;

    case 'error':
      log('note', 'error', p.message);
      break;

    default:
      log('in', msg.type, JSON.stringify(p));
  }
});

/* ---------------- panel wiring ---------------- */

function syncSettingInputs() {
  for (const key of ['approvals', 'reviewOnStop', 'answerQuestions', 'autoPerch']) {
    document.getElementById(`set-${key}`).checked = Boolean(settings[key]);
  }
  document.getElementById('set-character').value = settings.character;
  document.getElementById('set-size').value = settings.size;
}

function reloadFrame() {
  stopPlayback();
  ready = false;
  openRequests.clear();
  const name = document.getElementById('opt-name').value.trim() || 'session';
  const color = document.getElementById('opt-color').value;
  const params = new URLSearchParams({ session: 'demo-session', name, color });
  frame.style.width = `${FULL_W}px`;
  frame.style.height = `${FALLBACK_H}px`;
  frame.src = `/renderer/?${params}`;
}

function setDocked(on) {
  document.getElementById('set-docked').checked = on;
  desktop.classList.toggle('docked', on);
  terminal.classList.toggle('hidden', !on);
  send('event', { kind: 'dock', docked: on, compact: frameMode === 'compact' });
}

async function boot() {
  data = await fetch('/api/scenarios').then((r) => r.json());
  settings = { ...settings, characters: data.characters, sizes: data.sizes };

  const fillSelect = (el, items, text) => {
    for (const item of items) {
      const opt = document.createElement('option');
      opt.value = item.id;
      opt.textContent = text(item);
      el.appendChild(opt);
    }
  };
  fillSelect(document.getElementById('set-character'), data.characters, (c) => c.label);
  renderSprites();
  renderActions();
  fillSelect(document.getElementById('set-size'), data.sizes, (s) => `${s.id} (${s.buddy}px)`);
  syncSettingInputs();

  const colorSel = document.getElementById('opt-color');
  for (const p of data.palette) {
    const opt = document.createElement('option');
    opt.value = p.color;
    opt.textContent = p.color;
    colorSel.appendChild(opt);
  }
  colorSel.value = '#4fa3d1';

  // Scenario buttons, grouped in the order the server listed them.
  const groups = document.getElementById('scenario-groups');
  const seen = new Map();
  for (const s of data.scenarios) {
    let box = seen.get(s.group);
    if (!box) {
      const wrap = document.createElement('div');
      wrap.className = 'group';
      const name = document.createElement('div');
      name.className = 'group-name';
      name.textContent = s.group;
      wrap.appendChild(name);
      groups.appendChild(wrap);
      box = wrap;
      seen.set(s.group, wrap);
    }
    const btn = document.createElement('button');
    btn.className = 'scenario';
    btn.textContent = s.label;
    if (s.hint) {
      const small = document.createElement('small');
      small.textContent = s.hint;
      btn.appendChild(small);
    }
    btn.addEventListener('click', () => playScenario(s, btn));
    box.appendChild(btn);
    // The show run is the headline act, so the big play button above the stage
    // starts it too.
    if (s.showRun) {
      document.getElementById('btn-showrun').addEventListener('click', () => playScenario(s, btn));
    }
  }

  reloadFrame();
}

document.getElementById('opt-reload').addEventListener('click', reloadFrame);
document.getElementById('opt-name').addEventListener('change', reloadFrame);
document.getElementById('opt-color').addEventListener('change', reloadFrame);

document.getElementById('opt-random').addEventListener('click', () => {
  const p = data.palette[Math.floor(Math.random() * data.palette.length)];
  document.getElementById('opt-color').value = p.color;
  reloadFrame();
});

for (const key of ['approvals', 'reviewOnStop', 'answerQuestions', 'autoPerch']) {
  document.getElementById(`set-${key}`).addEventListener('change', (e) => {
    settings = { ...settings, [key]: e.target.checked };
    send('settings', settings);
  });
}

for (const key of ['character', 'size']) {
  document.getElementById(`set-${key}`).addEventListener('change', (e) => {
    settings = { ...settings, [key]: e.target.value };
    send('settings', settings);
    if (key === 'character') {
      renderSprites();
      renderActions();
    }
  });
}

document.getElementById('set-canopen').addEventListener('change', (e) => {
  send('event', { kind: 'can-open', value: e.target.checked });
});

document.getElementById('set-docked').addEventListener('change', (e) => setDocked(e.target.checked));

document.getElementById('opt-usage').addEventListener('change', (e) => {
  send('usage-data', data.usage[e.target.value]);
});

for (const btn of document.querySelectorAll('[data-poke]')) {
  btn.addEventListener('click', () => send('poke', { button: btn.dataset.poke }));
}

document.getElementById('btn-walk').addEventListener('click', walkToPrompt);

/* ---------------- Workbench: every sprite, every action ---------------- */

const POSE_LABEL = {
  idle: 'idle',
  think: 'thinking',
  excited: 'needs you',
  stress: 'stressed',
  walk: 'walking',
  point: 'pointing',
  sleep: 'asleep',
  cheer: 'cheering',
  wave: 'hello',
};

/** One animation, playing: live SVG, a generated GIF, or a stepped sheet. */
function poseArt(character, poseName, height = 44) {
  if (character.vector) {
    const colour = document.getElementById('opt-color').value || '#9aa3ad';
    const svg = window.ClippyVectors.create(character.vector, poseName, colour);
    svg.style.height = `${height}px`;
    svg.style.width = `${Math.round(height * 0.8)}px`;
    return svg;
  }
  if (!character.sheet) {
    const img = document.createElement('img');
    const colour = (document.getElementById('opt-color').value || '#9aa3ad').replace('#', '');
    img.src = `/renderer/assets/themes/${character.id}/${
      character.perColour ? `${colour}-` : ''
    }${poseName}.gif`;
    img.alt = '';
    img.style.height = `${height}px`;
    return img;
  }

  const pose = character.sheet.poses[poseName];
  if (!pose) return document.createElement('span');
  const { frameWidth, frameHeight, columns, rows, fps } = character.sheet;
  const scale = height / frameHeight;
  const w = Math.round(frameWidth * scale);
  const h = Math.round(frameHeight * scale);

  const el = document.createElement('div');
  el.className = 'sheet';
  el.style.cssText = `width:${w}px;height:${h}px;background-repeat:no-repeat;background-image:url("/renderer/${pose.file}");background-size:${w * columns}px ${h * rows}px`;
  let frame = 0;
  const step = () => {
    el.style.backgroundPosition = `-${frame * w}px -${(pose.row || 0) * h}px`;
    frame = (frame + 1) % pose.frames;
  };
  step();
  if (pose.frames > 1) spriteTimers.push(setInterval(step, Math.round(1000 / (fps || 6))));
  return el;
}

const posesOf = (c) => (c.sheet ? Object.keys(c.sheet.poses) : c.poses || ['idle', 'excited']);

function renderSprites() {
  const host = document.getElementById('sprite-sheet');
  spriteTimers.forEach(clearInterval);
  spriteTimers = [];
  host.replaceChildren();

  for (const character of data.characters) {
    const row = document.createElement('div');
    row.className = 'sprite-row';

    const who = document.createElement('div');
    who.className = 'sprite-who';
    const name = document.createElement('div');
    name.className = 'sprite-name';
    name.textContent = character.label;
    const origin = document.createElement('div');
    origin.className = 'sprite-origin';
    origin.textContent = character.sheet
      ? `${character.sheet.frameWidth}×${character.sheet.frameHeight} sheet`
      : character.vector
      ? 'live SVG'
      : 'drawn in code';
    who.append(name, origin);

    const poses = document.createElement('div');
    poses.className = 'sprite-poses';
    for (const poseName of posesOf(character)) {
      const cell = document.createElement('button');
      cell.className = `sprite-pose${
        character.id === settings.character && poseName === previewPose ? ' on' : ''
      }`;
      cell.title = `Show ${character.label} ${POSE_LABEL[poseName] || poseName} on the stage`;
      const art = document.createElement('div');
      art.className = 'sprite-art';
      art.appendChild(poseArt(character, poseName));
      const label = document.createElement('div');
      label.className = 'sprite-label';
      label.textContent = POSE_LABEL[poseName] || poseName;
      cell.append(art, label);
      cell.addEventListener('click', () => showOnStage(character.id, poseName));
      poses.appendChild(cell);
    }

    row.append(who, poses);
    host.appendChild(row);
  }
}

/** Put a character on the stage holding a pose, so it can be looked at. */
function showOnStage(character, poseName) {
  previewPose = poseName;
  if (settings.character !== character) {
    settings = { ...settings, character };
    syncSettingInputs();
    send('settings', settings);
  }
  send('event', { kind: 'pose', name: poseName });
  log('out', 'pose', `${character} · ${POSE_LABEL[poseName] || poseName}`);
  renderSprites();
}

function renderActions() {
  const host = document.getElementById('action-grid');
  host.replaceChildren();

  for (const action of data.actions || []) {
    const card = document.createElement('div');
    card.className = 'action-card';

    const pose = document.createElement('div');
    pose.className = 'action-pose';
    const character = data.characters.find((c) => c.id === settings.character) || data.characters[0];
    if (character) pose.appendChild(poseArt(character, action.pose, 40));
    const poseLabel = document.createElement('div');
    poseLabel.className = 'sprite-label';
    poseLabel.textContent = POSE_LABEL[action.pose] || action.pose;
    pose.appendChild(poseLabel);

    const body = document.createElement('div');
    body.className = 'action-body';
    const name = document.createElement('div');
    name.className = 'action-name';
    name.textContent = `${action.icon} ${action.title}`;
    const when = document.createElement('div');
    when.className = 'action-when';
    when.textContent = action.when;
    const meta = document.createElement('div');
    meta.className = 'action-meta';
    if (action.hook) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = action.hook;
      meta.appendChild(chip);
    }
    const scenario = data.scenarios.find((sc) => sc.id === action.scenario);
    if (scenario) {
      const button = document.createElement('button');
      button.textContent = '▶ play';
      button.title = scenario.label;
      button.addEventListener('click', () => {
        desktop.scrollIntoView({ behavior: 'smooth', block: 'center' });
        playScenario(scenario);
      });
      meta.appendChild(button);
    }
    body.append(name, when, meta);

    card.append(pose, body);
    host.appendChild(card);
  }
}

document.getElementById('btn-clear-log').addEventListener('click', () => {
  logEl.replaceChildren();
});

document.getElementById('btn-reset').addEventListener('click', () => {
  setDocked(false);
  logEl.replaceChildren();
  reloadFrame();
});

boot();
