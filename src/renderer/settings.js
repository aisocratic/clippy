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
let state = { characters: [], sizes: [], sessions: [] };
const sheetTimers = [];
const previewPose = new Map();

/**
 * Sprite previews are stepped by an interval each, and every render builds new
 * elements for them — so the old timers have to go, or they carry on stepping
 * nodes that are no longer on the page. One call at the top of render() covers
 * the cast, the sessions and the solo row together; the clearing used to live
 * at two call sites instead, and the third — every click on a size or a sound,
 * which goes through set() — left another set of intervals running.
 */
function clearSheetTimers() {
  while (sheetTimers.length) clearInterval(sheetTimers.pop());
}

/* ---------- Buddies ---------- */

/**
 * Draw one animation. Vector buddies are live SVG, generated characters are
 * GIFs that animate themselves, and sprite-sheet packs are stepped here.
 */
function poseArt(character, pose, height = 64) {
  if (character.vector) {
    const colour = (state.sessions[0] || {}).color || '#9aa3ad';
    const svg = window.ClippyVectors.create(character.vector, pose.name, colour);
    // A character naming a drawing this build does not have gets nothing rather
    // than taking the whole page down with it — the same guard the buddy
    // window uses for the same call.
    if (!svg) return document.createElement('span');
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
  // Escaped even though main vets sheet filenames: a quote would end the url().
  el.style.backgroundImage = `url("${CSS.escape(pose.file)}")`;
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
  // The face Clippy wears: the one picked here, or main's default for it.
  const wearing = state.soloCharacter || (state.solo && state.solo.character) || '';

  document.getElementById('cast-note').textContent =
    'Click a buddy and Clippy wears it. ▶ plays its next animation.';

  for (const character of state.characters) {
    const row = document.createElement('div');
    row.className = `cast-row${character.id === wearing ? ' on' : ''}`;

    const who = document.createElement('button');
    who.className = 'cast-who';
    const poses = posesOf(character);
    const poseIndex = (previewPose.get(character.id) || 0) % poses.length;
    const pose = poses[poseIndex];
    who.title = `Clippy wears ${character.label}`;
    who.setAttribute('aria-pressed', String(character.id === wearing));

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
    who.addEventListener('click', () => set('soloCharacter', character.id));

    // Every buddy has nine animations; this steps through them without
    // choosing. The whole page re-renders, not only the cast: clearing the
    // timers stops the session rows' sprites too, and they only come back
    // when their art is rebuilt.
    const next = document.createElement('button');
    next.className = 'cast-next';
    next.textContent = '▶';
    next.title = `Play ${character.label}'s next animation`;
    next.setAttribute('aria-label', `Play ${character.label}'s next animation`);
    next.addEventListener('click', () => {
      previewPose.set(character.id, (poseIndex + 1) % poses.length);
      render();
    });

    row.append(who, next);
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

/**
 * Clippy's own row: the one buddy that stands in for every agent.
 *
 * It wears the highlight and says which agent it is speaking for right now.
 * Its face and size are chosen under Buddies, because Clippy never changes
 * with the session. The sessions are listed under it, smaller and indented,
 * as the agents connected to it.
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
  show.textContent = 'Clippy';
  show.title = 'Bring Clippy to the front';
  show.addEventListener('click', () => window.clippySettings.showBuddy('solo'));

  const status = document.createElement('span');
  status.className = 'session-status';
  status.textContent = solo.showing ? `speaking for ${solo.showing}` : 'waiting for an agent';

  const art = document.createElement('span');
  art.className = 'session-art';
  const character = state.characters.find((c) => c.id === solo.character);
  if (character) art.appendChild(poseArt(character, posesOf(character)[0], 28));

  // Which face and how big are chosen under Buddies, the one place for both;
  // this row only shows the result.
  const look = document.createElement('a');
  look.className = 'session-look';
  look.href = '#buddies';
  look.textContent = `${labelFor(solo.character)} · ${SIZE_LABEL[state.size] || state.size}`;
  look.title = 'Change under Buddies';

  row.append(dot, show, status, art, look);
  return row;
}

function renderSound() {
  document.getElementById('appearance-sound').value = state.appearanceSound || '';
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

  // Clippy at the top; every agent connected to it underneath.
  host.appendChild(soloRow());

  if (!state.sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-note';
    empty.textContent = 'No agents yet. Start Claude Code or Codex and Clippy speaks for it.';
    host.appendChild(empty);
    return;
  }

  const agents = document.createElement('div');
  agents.className = 'agents';
  for (const session of state.sessions) {
    // An agent row says who and how it is doing, and nothing about looks:
    // Clippy never changes with the session, so there is nothing to pick here.
    const row = document.createElement('div');
    row.className = 'session agent-session';

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = session.color || '#9aa3ad';

    const show = document.createElement('button');
    show.className = 'session-name';
    show.textContent = session.name;
    show.title = 'Bring Clippy to the front for this agent';
    show.addEventListener('click', () => window.clippySettings.showBuddy(session.sessionId));

    const status = document.createElement('span');
    status.className = 'session-status';
    const agentName = { claude: 'Claude', codex: 'Codex', openclaw: 'OpenClaw' }[session.agent] || 'Claude';
    status.textContent = `${agentName} · ${STATUS_TEXT[session.status] || session.status || ''}`;

    row.append(dot, show, status);
    agents.appendChild(row);

    // The subagents it has running, one step further in: a helper of this
    // agent, with what it is doing. They come and go with the task.
    for (const sub of session.subagents || []) {
      const subRow = document.createElement('div');
      subRow.className = 'session agent-session subagent-session';
      const subDot = document.createElement('span');
      subDot.className = 'dot';
      subDot.style.background = session.color || '#9aa3ad';
      const subName = document.createElement('span');
      subName.className = 'session-name';
      subName.textContent = sub.type;
      const subStatus = document.createElement('span');
      subStatus.className = 'session-status';
      subStatus.textContent = sub.label || 'working…';
      subRow.append(subDot, subName, subStatus);
      agents.appendChild(subRow);
    }
  }
  host.appendChild(agents);
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
  clearSheetTimers();
  renderAccess();
  renderSound();
  renderSizes();
  renderCast();
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
