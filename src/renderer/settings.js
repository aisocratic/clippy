'use strict';

/**
 * Clippy's settings window.
 *
 * Everything on the page is built from what main sends: the cast (with each
 * character's animations playing live), the catalogue of what Clippy does with
 * a session, and the sessions currently reporting in. Nothing here has its own
 * copy of that knowledge. The on/off switches for what Clippy answers live in
 * the 📎 menu bar's Quick settings, where they're one click away from anywhere.
 */

const SIZE_LABEL = { xs: 'XS', small: 'Small', medium: 'Medium', large: 'Large' };
const STATUS_TEXT = {
  idle: 'idle',
  working: 'working…',
  waiting: 'finished — your turn',
  needs_permission: 'needs your permission',
};

// One flat object, exactly as main sends it: the settings themselves plus the
// rosters and catalogue the page is drawn from.
let state = { characters: [], sizes: [], actions: [], sessions: [] };
const sheetTimers = [];
const previewPose = new Map();

/* ---------- Buddies ---------- */

/**
 * Draw one animation. Vector buddies are live SVG, generated characters are
 * GIFs that animate themselves, and sprite-sheet packs are stepped here.
 */
function poseArt(character, pose, height = 64) {
  if (character.vector) {
    const colour = (state.sessions[0] || {}).color || '#9aa3ad';
    const svg = window.ClippyVectors.create(character.vector, pose.name, colour);
    svg.style.height = `${height}px`;
    svg.style.width = `${Math.round(height * 0.8)}px`;
    return svg;
  }
  if (!character.sheet) {
    const img = document.createElement('img');
    img.src = pose.file;
    img.alt = '';
    img.style.height = `${height}px`;
    return img;
  }

  const { frameWidth, frameHeight, columns, rows, fps } = character.sheet;
  const scale = height / frameHeight;
  const w = Math.round(frameWidth * scale);
  const h = Math.round(frameHeight * scale);

  const el = document.createElement('div');
  el.className = 'sheet';
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.style.backgroundImage = `url("${pose.file}")`;
  el.style.backgroundSize = `${w * columns}px ${h * rows}px`;
  el.style.backgroundRepeat = 'no-repeat';

  let frame = 0;
  const step = () => {
    el.style.backgroundPosition = `-${frame * w}px -${(pose.row || 0) * h}px`;
    frame = (frame + 1) % pose.frames;
  };
  step();
  if (pose.frames > 1) sheetTimers.push(setInterval(step, Math.round(1000 / (fps || 6))));
  return el;
}

// What each pose is for, in the order they're worth looking at.
const POSE_LABEL = {
  idle: 'idle',
  excited: 'needs you',
  walk: 'walking',
  point: 'pointing',
  sleep: 'asleep',
  cheer: 'cheering',
};

/**
 * Every animation a character has: the named poses first, then — for a sprite
 * pack — any rows of the sheet nobody has claimed yet, so you can see what else
 * is in there and name it in `theme.json`.
 */
function posesOf(character) {
  if (!character.sheet) {
    // Clippy is drawn per session colour; show him in the colour of the first
    // session that has reported in, or the default steel.
    const colour = ((state.sessions[0] || {}).color || '#9aa3ad').replace('#', '');
    const art = (pose) =>
      character.vector
        ? ''
        : `assets/themes/${character.id}/${character.perColour ? `${colour}-` : ''}${pose}.gif`;
    return (character.poses || ['idle', 'excited']).map((pose) => ({
      name: pose,
      label: POSE_LABEL[pose] || pose,
      file: art(pose),
      named: true,
    }));
  }

  const { poses: named, rows } = character.sheet;
  const poses = [];
  const claimed = new Set();
  for (const [name, pose] of Object.entries(named)) {
    poses.push({ ...pose, label: POSE_LABEL[name] || name, named: true });
    claimed.add(pose.row);
  }
  for (let row = 0; row < rows; row++) {
    if (claimed.has(row)) continue;
    poses.push({ ...named.idle, row, label: `row ${row}` });
  }
  return poses;
}

/** One live preview per buddy. Clicking it cycles through its animations. */
function renderCast() {
  const host = document.getElementById('cast');
  host.replaceChildren();
  const sessions = state.sessions || [];
  const onDuty = new Set(sessions.map((s) => s.character));

  document.getElementById('cast-note').textContent =
    'Click a buddy to see its next animation. Choose which session wears it under Sessions.';

  for (const character of state.characters) {
    const row = document.createElement('div');
    row.className = `cast-row${onDuty.has(character.id) ? ' on' : ''}`;

    const who = document.createElement('button');
    who.className = 'cast-who';
    const poses = posesOf(character);
    const poseIndex = (previewPose.get(character.id) || 0) % poses.length;
    const pose = poses[poseIndex];
    who.title = `Show ${character.label}'s next animation`;

    const art = document.createElement('span');
    art.className = 'cast-art';
    art.appendChild(poseArt(character, pose, 64));
    const name = document.createElement('span');
    name.className = 'cast-name';
    name.textContent = character.label;
    const poseName = document.createElement('span');
    poseName.className = 'cast-pose-name';
    poseName.textContent = pose.label;
    who.append(art, name, poseName);
    who.addEventListener('click', () => {
      previewPose.set(character.id, (poseIndex + 1) % poses.length);
      while (sheetTimers.length) clearInterval(sheetTimers.pop());
      renderCast();
    });

    row.appendChild(who);
    if (character.removable) {
      const remove = document.createElement('button');
      remove.className = 'remove-buddy';
      remove.textContent = '×';
      remove.title = `Remove ${character.label}`;
      remove.setAttribute('aria-label', `Remove ${character.label}`);
      remove.addEventListener('click', async () => {
        if (!confirm(`Remove ${character.label} from this machine?`)) return;
        remove.disabled = true;
        const result = await window.clippySettings.removePet(character.id);
        if (!result?.ok) {
          remove.disabled = false;
          alert(result?.error || 'That buddy could not be removed.');
        }
      });
      row.appendChild(remove);
    }
    host.appendChild(row);
  }
}

function renderSizes() {
  const host = document.getElementById('sizes');
  host.replaceChildren();
  for (const size of state.sizes) {
    const btn = document.createElement('button');
    btn.className = size.id === state.size ? 'on' : '';
    btn.textContent = SIZE_LABEL[size.id] || size.id;
    btn.title = `${size.buddy}px`;
    btn.addEventListener('click', () => set('size', size.id));
    host.appendChild(btn);
  }
}

// What each choice actually does, said in the panel rather than guessed at.
const BUDDY_MODES = [
  {
    id: 'each',
    label: 'One each',
    note:
      'A buddy per session, side by side — every agent has its own face, colour and ' +
      'spot on screen. Best when you want to see at a glance how many are running.',
  },
  {
    id: 'one',
    label: 'One for all',
    note:
      'A single buddy that speaks for whichever agent needs you, wearing that ' +
      "agent's name, colour and face while it does. Best when several agents are " +
      'running and you would rather not have a desk full of paperclips.',
  },
];

function renderBuddyMode() {
  const host = document.getElementById('buddy-mode');
  const note = document.getElementById('buddy-mode-note');
  const current = state.buddyMode === 'one' ? 'one' : 'each';
  host.replaceChildren();
  for (const mode of BUDDY_MODES) {
    const btn = document.createElement('button');
    btn.className = mode.id === current ? 'on' : '';
    btn.textContent = mode.label;
    btn.addEventListener('click', () => set('buddyMode', mode.id));
    host.appendChild(btn);
  }
  note.textContent = BUDDY_MODES.find((mode) => mode.id === current).note;
}

/**
 * The row for the buddy that stands in for every agent.
 *
 * Built from the same pieces as a session row — dot, name, art, a picker —
 * because it is the same kind of thing: a buddy you can look at and re-cast.
 * What it is *not* is a session, so it wears the highlight and says what it is
 * doing rather than which agent it is.
 */
function soloRow() {
  const solo = state.solo || {};
  const row = document.createElement('div');
  row.className = 'session solo-session';

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = solo.color || '#9aa3ad';

  const show = document.createElement('button');
  show.className = 'session-name';
  show.textContent = `${solo.pet || 'One buddy'} · every agent`;
  show.title = 'Bring the one buddy to the front';
  show.addEventListener('click', () => window.clippySettings.showBuddy('solo'));

  const status = document.createElement('span');
  status.className = 'session-status';
  status.textContent = solo.showing ? `speaking for ${solo.showing}` : 'waiting for an agent';

  const art = document.createElement('span');
  art.className = 'session-art';
  const character = state.characters.find((c) => c.id === solo.character);
  if (character) art.appendChild(poseArt(character, posesOf(character)[0], 28));

  // A dropdown, not a row of every character: the cast grows every time a
  // sprite pack is installed, and a segmented control grew with it.
  const pick = document.createElement('select');
  pick.className = 'session-pick';
  pick.title = 'Which buddy stands in for every agent';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = `Auto (${labelFor(solo.character)})`;
  pick.appendChild(auto);
  for (const option of state.characters) {
    const opt = document.createElement('option');
    opt.value = option.id;
    opt.textContent = option.label;
    pick.appendChild(opt);
  }
  pick.value = state.soloCharacter || '';
  pick.addEventListener('change', () => set('soloCharacter', pick.value));

  const sizePick = document.createElement('select');
  sizePick.className = 'session-pick session-size';
  sizePick.title = 'How big the main buddy is drawn';
  const autoSize = document.createElement('option');
  autoSize.value = '';
  autoSize.textContent = `Default (${SIZE_LABEL[state.size] || state.size})`;
  sizePick.appendChild(autoSize);
  for (const size of state.sizes) {
    const option = document.createElement('option');
    option.value = size.id;
    option.textContent = SIZE_LABEL[size.id] || size.id;
    sizePick.appendChild(option);
  }
  sizePick.value = solo.size || '';
  sizePick.addEventListener('change', () => set('soloSize', sizePick.value));

  row.append(dot, show, status, art, pick, sizePick);
  return row;
}

function renderSound() {
  document.getElementById('appearance-sound').value = state.appearanceSound || '';
}

/* ---------- Clippy's Features ---------- */

function renderActions() {
  const host = document.getElementById('action-list');
  host.replaceChildren();

  for (const action of state.actions) {
    const card = document.createElement('div');
    card.className = 'action';

    const head = document.createElement('div');
    head.className = 'action-head';
    const icon = document.createElement('span');
    icon.className = 'action-icon';
    icon.textContent = action.icon;
    const title = document.createElement('span');
    title.className = 'action-title';
    title.textContent = action.title;
    head.append(icon, title);

    if (action.hook) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = action.hook;
      tag.title = 'the lifecycle hook that triggers this';
      head.appendChild(tag);
    }
    if (action.appliesTo) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = action.appliesTo;
      tag.title = 'supported agents';
      head.appendChild(tag);
    }
    // Say plainly when this one is switched off, and where the switch is: the
    // catalogue would otherwise promise behaviour that can't happen.
    if (action.setting && !state[action.setting]) {
      const off = document.createElement('span');
      off.className = 'tag off';
      off.textContent = 'off';
      off.title = 'turned off in the 📎 menu bar → Quick settings';
      head.appendChild(off);
    }

    const dl = document.createElement('dl');
    for (const [term, value] of [['When', action.when], ['You see', action.shows]]) {
      if (!value) continue;
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dl.append(dt, dd);
    }

    card.append(head, dl);

    if (action.choices) {
      const choices = document.createElement('div');
      choices.className = 'choices';
      for (const choice of action.choices) {
        const row = document.createElement('div');
        row.className = 'choice';
        const label = document.createElement('span');
        label.className = 'choice-label';
        label.textContent = choice.label;
        const effect = document.createElement('span');
        effect.className = 'choice-effect';
        effect.textContent = `— ${choice.effect}`;
        row.append(label, effect);
        // A choice with no json answers no hook (the review card's buttons) —
        // showing "{}" there would claim a response that never happens.
        if (choice.json) {
          const json = document.createElement('code');
          json.className = `choice-json${choice.json === '{}' ? ' empty' : ''}`;
          json.textContent =
            choice.json === '{}' ? '{}  · no opinion, the agent carries on as normal' : choice.json;
          row.append(json);
        }
        choices.appendChild(row);
      }
      card.appendChild(choices);
    }

    host.appendChild(card);
  }
}

/* ---------- Sessions ---------- */

/**
 * The one bit of macOS bureaucracy Clippy can't do for you.
 *
 * Running from source, the app *is* Electron's own bundle — so the Accessibility
 * list says "Electron", there is no "Clippy" in it, and the entry may not exist
 * at all until it's added by hand. That confuses everyone once, so say it here
 * with the exact path and a button that copies it.
 */
function renderAccess() {
  const host = document.getElementById('access');
  host.classList.toggle('hidden', state.windowAccess !== false);
  if (state.windowAccess !== false) return;

  host.replaceChildren();
  const title = document.createElement('div');
  title.className = 'access-title';
  title.textContent = "macOS hasn't given Clippy window access";

  const body = document.createElement('p');
  body.className = 'access-body';
  body.textContent =
    'Without it Clippy can\'t raise your terminal windows, perch on them, or walk ' +
    'to a prompt. macOS only lets you grant this yourself — no app can add itself ' +
    `to that list. Press the button below and look for “${state.appName}” (not ` +
    '"Clippy"): asking puts it there, so it should just need switching on. If the ' +
    'list still has no entry, click + and add this:';

  const after = document.createElement('p');
  after.className = 'access-body access-after';
  after.textContent =
    'No restart needed — Clippy notices the moment you flip the switch and carries on.';

  const path = document.createElement('code');
  path.className = 'access-path';
  path.textContent = state.appPath || '';

  const actions = document.createElement('div');
  actions.className = 'access-actions';
  const open = document.createElement('button');
  open.className = 'primary';
  open.textContent = 'Open Accessibility ↗';
  open.addEventListener('click', () => window.clippySettings.fix('accessibility'));
  const copy = document.createElement('button');
  copy.textContent = 'Copy path';
  copy.addEventListener('click', () => {
    window.clippySettings.fix('copy-path');
    copy.textContent = 'Copied ✓';
    setTimeout(() => (copy.textContent = 'Copy path'), 1600);
  });
  actions.append(open, copy);

  host.append(title, body, path, actions, after);
}

function renderSessions() {
  const host = document.getElementById('session-list');
  host.replaceChildren();

  // One buddy for all of them: it goes at the top, because it is the one that
  // answers for every row under it.
  if (state.buddyMode === 'one') host.appendChild(soloRow());

  if (!state.sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-note';
    empty.textContent =
      state.buddyMode === 'one'
        ? 'No sessions yet. Start Claude Code or Codex and the buddy above speaks for it.'
        : 'No sessions yet. Start Claude Code or Codex in a project and its buddy appears here.';
    host.appendChild(empty);
    return;
  }

  for (const session of state.sessions) {
    const row = document.createElement('div');
    row.className = 'session';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = session.color || '#9aa3ad';

    const show = document.createElement('button');
    show.className = 'session-name';
    show.textContent = `${labelFor(session.character)} · ${session.name}`;
    show.title = `Bring ${labelFor(session.character)} to the front`;
    show.addEventListener('click', () => window.clippySettings.showBuddy(session.sessionId));

    const status = document.createElement('span');
    status.className = 'session-status';
    const agentName = { claude: 'Claude', codex: 'Codex', openclaw: 'OpenClaw' }[session.agent] || 'Claude';
    status.textContent = `${agentName} · ${STATUS_TEXT[session.status] || session.status || ''}`;

    // This one buddy's own. The choice is kept against the session (so the
    // folder's other agents keep theirs) and against the project (so the repo
    // still looks the same tomorrow) — see assignCharacter in src/main.js.
    const assigned =
      (state.characterBySession || {})[session.sessionId] ||
      (state.characterByProject || {})[session.name] ||
      '';
    const pick = document.createElement('select');
    pick.className = 'session-pick';
    pick.title = 'Which buddy this session gets';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = `Auto (${labelFor(session.character)})`;
    pick.appendChild(auto);
    for (const character of state.characters) {
      const option = document.createElement('option');
      option.value = character.id;
      option.textContent = character.label;
      pick.appendChild(option);
    }
    pick.value = assigned;
    pick.addEventListener('change', () =>
      window.clippySettings.assign(session.sessionId, pick.value)
    );

    // …and how big it is drawn, kept the same way. A repo you watch out of the
    // corner of your eye can be XS while the one you're in is large.
    const assignedSize =
      (state.sizeBySession || {})[session.sessionId] ||
      (state.sizeByProject || {})[session.name] ||
      '';
    const sizePick = document.createElement('select');
    sizePick.className = 'session-pick session-size';
    sizePick.title = 'How big this session’s buddy is drawn';
    const autoSize = document.createElement('option');
    autoSize.value = '';
    autoSize.textContent = `Default (${SIZE_LABEL[state.size] || state.size})`;
    sizePick.appendChild(autoSize);
    for (const size of state.sizes) {
      const option = document.createElement('option');
      option.value = size.id;
      option.textContent = SIZE_LABEL[size.id] || size.id;
      sizePick.appendChild(option);
    }
    sizePick.value = assignedSize;
    sizePick.addEventListener('change', () =>
      window.clippySettings.assignSize(session.sessionId, sizePick.value)
    );

    const art = document.createElement('span');
    art.className = 'session-art';
    const character = state.characters.find((c) => c.id === (assigned || session.character));
    if (character) art.appendChild(poseArt(character, posesOf(character)[0], 28));

    row.append(dot, show, status, art, pick, sizePick);
    host.appendChild(row);
  }
}

/* ---------- Wiring ---------- */

const labelFor = (id) => {
  const character = (state.characters || []).find((c) => c.id === id);
  return character ? character.label.replace(/^\S+\s/, '') : 'whoever is on duty';
};

function set(key, value) {
  state = { ...state, [key]: value };
  render(); // answer the click now; main confirms with the next state push
  window.clippySettings.setSetting(key, value);
}

function render() {
  renderAccess();
  renderSound();
  renderBuddyMode();
  renderSizes();
  renderCast();
  renderActions();
  renderSessions();

  const text = document.getElementById('server-text');
  text.textContent = state.port ? `listening on 127.0.0.1:${state.port}` : 'hook server';
  text.title = 'Where Claude Code and Codex hooks report in';
}

// Anything linked out of here opens in the browser, not in this window.
for (const link of document.querySelectorAll('a[href^="https://"]')) {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    window.clippySettings.openExternal(link.href);
  });
}

window.clippySettings.onState((next) => {
  // Sprite animations are re-created on every render; drop the old timers.
  while (sheetTimers.length) clearInterval(sheetTimers.pop());
  state = { ...state, ...next };
  render();
  syncRailSelection();
});

// The rail is a table of contents for one continuous settings page. Highlight
// the last section whose top has crossed the page header. An intersection band
// can skip a short Sessions panel entirely and select Sounds at scrollTop 0;
// measuring tops makes the first panel unambiguously own the top of the page.
const page = document.getElementById('page');
const links = [...document.querySelectorAll('.rail-link')];
const panels = [...document.querySelectorAll('.panel')];

function syncRailSelection() {
  const marker = page.getBoundingClientRect().top + 50;
  let current = panels[0];
  for (const panel of panels) {
    if (panel.getBoundingClientRect().top > marker) break;
    current = panel;
  }
  for (const link of links) {
    const on = link.getAttribute('href') === `#${current.id}`;
    link.classList.toggle('on', on);
    if (on) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}

page.addEventListener('scroll', syncRailSelection, { passive: true });
window.addEventListener('resize', syncRailSelection);
window.addEventListener('hashchange', () => requestAnimationFrame(syncRailSelection));
requestAnimationFrame(syncRailSelection);

window.clippySettings.ready();

// Use the same local-folder/SSH launcher as the menu-bar "New agent" item.
document.getElementById('btn-new-agent').addEventListener('click', () => {
  window.clippySettings.newAgent();
});

/* ---------- Sound ---------- */

{
  const pick = document.getElementById('appearance-sound');
  pick.addEventListener('change', () => set('appearanceSound', pick.value));
  document.getElementById('preview-sound').addEventListener('click', () => {
    window.ClippySounds.play(pick.value);
  });
}

/* ---------- Add, draw, and remove buddies ---------- */

{
  const dialog = document.getElementById('buddy-dialog');
  const options = document.getElementById('add-options');
  const drawing = document.getElementById('draw-buddy');
  const input = document.getElementById('pet-url');
  const button = document.getElementById('pet-install');
  const status = document.getElementById('pet-status');
  const canvas = document.getElementById('buddy-canvas');
  const context = canvas.getContext('2d');
  const name = document.getElementById('draw-name');
  const colour = document.getElementById('draw-colour');
  const eraser = document.getElementById('draw-eraser');
  const drawStatus = document.getElementById('draw-status');
  const pixels = Array(16 * 16).fill('');
  let painting = false;
  let erasing = false;

  const showOptions = () => {
    options.classList.remove('hidden');
    drawing.classList.add('hidden');
  };
  const showDrawing = () => {
    options.classList.add('hidden');
    drawing.classList.remove('hidden');
    paintCanvas();
  };

  const say = (text, tone) => {
    status.hidden = false;
    status.className = `field-note${tone ? ` ${tone}` : ''}`;
    status.textContent = text;
  };

  const install = async () => {
    const url = input.value.trim();
    if (!url) return;
    input.disabled = button.disabled = true;
    say('Fetching the pack…');
    const res = await window.clippySettings.installPet(url);
    input.disabled = button.disabled = false;
    if (res && res.ok) {
      say(`${res.label} joined the cast.`, 'good');
      input.value = '';
      setTimeout(() => dialog.close(), 500);
    } else {
      say((res && res.error) || 'that didn’t work', 'bad');
    }
  };

  button.addEventListener('click', install);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') install();
  });

  function paintCanvas() {
    const cell = canvas.width / 16;
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const value = pixels[y * 16 + x];
        if (value) {
          context.fillStyle = value;
          context.fillRect(x * cell, y * cell, cell, cell);
        }
      }
    }
    context.strokeStyle = 'rgba(21, 38, 42, 0.16)';
    context.lineWidth = 1;
    for (let n = 1; n < 16; n++) {
      context.beginPath();
      context.moveTo(n * cell, 0);
      context.lineTo(n * cell, canvas.height);
      context.stroke();
      context.beginPath();
      context.moveTo(0, n * cell);
      context.lineTo(canvas.width, n * cell);
      context.stroke();
    }
  }

  const drawAt = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * 16);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * 16);
    if (x < 0 || x >= 16 || y < 0 || y >= 16) return;
    pixels[y * 16 + x] = erasing ? '' : colour.value;
    paintCanvas();
  };

  canvas.addEventListener('pointerdown', (event) => {
    painting = true;
    canvas.setPointerCapture(event.pointerId);
    drawAt(event);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (painting) drawAt(event);
  });
  canvas.addEventListener('pointerup', () => (painting = false));
  canvas.addEventListener('pointercancel', () => (painting = false));

  document.getElementById('btn-add-buddy').addEventListener('click', () => {
    showOptions();
    dialog.showModal();
  });
  document.getElementById('close-buddy-dialog').addEventListener('click', () => dialog.close());
  document.getElementById('start-drawing').addEventListener('click', showDrawing);
  document.getElementById('back-to-add').addEventListener('click', showOptions);
  document.getElementById('draw-clear').addEventListener('click', () => {
    pixels.fill('');
    paintCanvas();
  });
  eraser.addEventListener('click', () => {
    erasing = !erasing;
    eraser.textContent = erasing ? 'Eraser on ✓' : 'Eraser';
  });
  colour.addEventListener('input', () => {
    erasing = false;
    eraser.textContent = 'Eraser';
  });
  document.getElementById('save-drawing').addEventListener('click', async () => {
    const save = document.getElementById('save-drawing');
    save.disabled = true;
    drawStatus.hidden = false;
    drawStatus.textContent = 'Saving your buddy…';
    drawStatus.className = 'field-note';
    const result = await window.clippySettings.createPet({
      label: name.value.trim(),
      width: 16,
      height: 16,
      pixels: [...pixels],
    });
    save.disabled = false;
    if (result?.ok) {
      drawStatus.textContent = `${result.label} joined the cast.`;
      drawStatus.className = 'field-note good';
      name.value = '';
      pixels.fill('');
      paintCanvas();
      setTimeout(() => dialog.close(), 500);
    } else {
      drawStatus.textContent = result?.error || 'That buddy could not be saved.';
      drawStatus.className = 'field-note bad';
    }
  });

  paintCanvas();
}

/* ---------- Updates ---------- */

// An installed app checks GitHub on demand, and a newer release can be fetched,
// checksummed, signature-verified and installed without a second DMG drag.
{
  const version = document.getElementById('update-version');
  const source = document.getElementById('update-source');
  const build = document.getElementById('update-build');
  const result = document.getElementById('update-result');
  const button = document.getElementById('btn-check-updates');

  // The offline half fills from state as soon as it arrives; the network half
  // waits for the button.
  window.clippySettings.onState((next) => {
    if (next.build) show({ ...next.build });
  });

  const show = (info) => {
    version.textContent = info.version ? `v${info.version}` : 'unknown';
    source.textContent =
      info.source === 'checkout'
        ? `a git checkout${info.branch ? ` (${info.branch})` : ''}`
        : 'the packaged app';
    build.textContent = info.sha ? info.sha.slice(0, 10) : 'no git info — packaged build';

    if (info.error) {
      result.textContent = `couldn't reach GitHub: ${info.error}`;
      result.className = 'update-result bad';
      return;
    }
    if (info.release) {
      // The packaged app measured itself against the newest release.
      const when = info.release.date ? new Date(info.release.date).toLocaleDateString() : '';
      if (info.upToDate === true) {
        result.textContent = `you're on the newest release (v${info.release.version}, ${when})`;
        result.className = 'update-result good';
      } else {
        result.replaceChildren();
        result.append(`v${info.release.version} is out (${when}) — `);
        const install = document.createElement('button');
        install.type = 'button';
        install.textContent = 'Install and relaunch';
        install.disabled = !info.release.dmg || !info.release.checksum;
        install.title = install.disabled
          ? 'This release is missing its checksum, so Clippy will not install it.'
          : 'Download the verified update and restart Clippy';
        install.addEventListener('click', async () => {
          install.disabled = true;
          button.disabled = true;
          result.textContent = `downloading v${info.release.version} and verifying it…`;
          result.className = 'update-result';
          const installed = await window.clippySettings.installUpdate();
          if (installed?.ok) {
            result.textContent = `v${installed.version} is installing — Clippy will relaunch.`;
            result.className = 'update-result good';
            return;
          }
          result.textContent = installed?.error || 'The update could not be installed.';
          result.className = 'update-result bad';
          button.disabled = false;
        });
        result.append(install);
        result.className = info.upToDate === false ? 'update-result warn' : 'update-result';
      }
      return;
    }
    if (!info.latest) return; // the offline fill — nothing has been checked yet
    const when = info.latest.date ? new Date(info.latest.date).toLocaleDateString() : '';
    if (info.upToDate === true) {
      result.textContent = `up to date with main (${when})`;
      result.className = 'update-result good';
    } else if (info.upToDate === false) {
      result.textContent = `main has moved on: “${info.latest.message}” (${when}) — git pull to catch up`;
      result.className = 'update-result warn';
    } else {
      result.textContent = `latest on main: “${info.latest.message}” (${when}) — no local git to compare`;
      result.className = 'update-result';
    }
  };

  button.addEventListener('click', async () => {
    button.disabled = true;
    result.textContent = 'asking GitHub…';
    result.className = 'update-result';
    try {
      show(await window.clippySettings.checkUpdates());
    } finally {
      button.disabled = false;
    }
  });
}

/* ---------------- Feedback ---------------- */

// Matches the cap in src/feedback.js and the API route, so the counter, the
// app and the server never disagree about what fits.
const FEEDBACK_MAX = 4000;

{
  const rest = document.getElementById('feedback-rest');
  const textarea = document.getElementById('feedback-text');
  const counter = document.getElementById('feedback-count');
  const prompt = document.getElementById('feedback-prompt');
  const send = document.getElementById('btn-send-feedback');
  const result = document.getElementById('feedback-result');
  const thumbs = {
    up: document.getElementById('thumb-up'),
    down: document.getElementById('thumb-down'),
  };

  let rating = null;

  const say = (message, tone = '') => {
    result.textContent = message;
    result.className = `update-result${tone ? ` ${tone}` : ''}`;
  };

  // Send stays out of reach until there is a thumb and some words. Nothing
  // Clippy sends should ever be one stray click away.
  const syncSend = () => {
    send.disabled = !(rating && textarea.value.trim());
  };

  const count = () => {
    const left = FEEDBACK_MAX - textarea.value.length;
    // Only worth saying when it starts to matter.
    counter.textContent = left > 400 ? '' : `${left} characters left`;
    counter.className = left < 0 ? 'feedback-count bad' : 'feedback-count';
  };

  const pick = (next) => {
    rating = next;
    for (const [key, button] of Object.entries(thumbs)) {
      const on = key === next;
      button.classList.toggle('on', on);
      button.setAttribute('aria-checked', String(on));
    }
    // The question is different depending on which way it went, and asking
    // "what happened?" of someone who just said it's going well reads oddly.
    prompt.textContent = next === 'up' ? 'What worked?' : 'What happened?';
    textarea.placeholder =
      next === 'up'
        ? 'What has Clippy got right?'
        : 'What were you doing, and what did Clippy do?';
    rest.classList.remove('hidden');
    say('');
    syncSend();
    textarea.focus();
  };

  thumbs.up.addEventListener('click', () => pick('up'));
  thumbs.down.addEventListener('click', () => pick('down'));
  textarea.addEventListener('input', () => {
    count();
    syncSend();
  });
  count();
  syncSend();

  send.addEventListener('click', async () => {
    const message = textarea.value.trim();
    if (!rating) return say('Pick 👍 or 👎 first.', 'bad');
    if (!message) return say('Tell us a little about it first.', 'bad');

    send.disabled = true;
    say('sending…');
    try {
      // Pressing the button is the yes: the note above it says where this
      // goes, and the API still wants that recorded alongside the words.
      const outcome = await window.clippySettings.sendFeedback({ rating, message });

      if (!outcome || !outcome.ok) {
        say((outcome && outcome.error) || 'That could not be sent.', 'bad');
        return;
      }
      // Reset rather than leave the words sitting there looking unsent.
      say('Sent — thank you. It goes straight to the team, and nowhere else.', 'good');
      textarea.value = '';
      rest.classList.add('hidden');
      for (const button of Object.values(thumbs)) {
        button.classList.remove('on');
        button.setAttribute('aria-checked', 'false');
      }
      rating = null;
      count();
    } finally {
      syncSend();
    }
  });
}
