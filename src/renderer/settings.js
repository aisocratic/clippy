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

const SIZE_LABEL = { small: 'Small', medium: 'Medium', large: 'Large' };
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

/**
 * The cast, and who is wearing which face.
 *
 * There is no "the buddy" to select anymore — every project is cast on its own —
 * so clicking a character here means "give the projects I can see that one",
 * which is the same per-project assignment the Sessions pickers write. With
 * nothing reporting in there is no project to give it to, and the row says so.
 */
function renderCast() {
  const host = document.getElementById('cast');
  host.replaceChildren();
  const sessions = state.sessions || [];
  const assignedTo = (name) => (state.characterByProject || {})[name] || '';
  const projects = [...new Set(sessions.map((s) => s.name))];
  // Highlight whoever is actually on duty: the closest thing left to a selection.
  const onDuty = new Set(sessions.map((s) => assignedTo(s.name) || s.character));

  document.getElementById('cast-note').textContent = projects.length
    ? `Clicking one gives it to every project reporting in right now (${projects.join(', ')}). ` +
      'For one project at a time, use the picker beside it under Sessions.'
    : 'Nothing is reporting in, so there is no project to give a buddy to yet — start ' +
      'Claude Code or Codex and it gets one from this cast automatically.';

  for (const character of state.characters) {
    const row = document.createElement('div');
    row.className = `cast-row${onDuty.has(character.id) ? ' on' : ''}`;

    const who = document.createElement('button');
    who.className = 'cast-who';
    who.disabled = !projects.length;
    who.title = projects.length
      ? `Give ${projects.join(', ')} ${character.label}`
      : 'No projects yet — start Claude Code or Codex somewhere and it gets a buddy of its own';
    const name = document.createElement('span');
    name.className = 'cast-name';
    name.textContent = character.label;
    const origin = document.createElement('span');
    origin.className = 'cast-origin';
    origin.textContent = character.sheet
      ? `sprite pack · ${character.sheet.frameWidth}×${character.sheet.frameHeight}`
      : character.vector
      ? 'live SVG · session colour'
      : character.perColour
      ? 'drawn in code · per session colour'
      : 'drawn in code';
    who.append(name, origin);
    who.addEventListener('click', () => {
      for (const project of projects) window.clippySettings.assign(project, character.id);
    });

    const poses = document.createElement('div');
    poses.className = 'cast-poses';
    for (const pose of posesOf(character)) {
      const cell = document.createElement('div');
      cell.className = 'pose';
      const art = document.createElement('div');
      art.className = 'pose-art';
      art.appendChild(poseArt(character, pose, 44));
      const label = document.createElement('div');
      label.className = 'pose-label';
      label.textContent = pose.label;
      cell.append(art, label);
      poses.appendChild(cell);
    }

    row.append(who, poses);
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
        const json = document.createElement('code');
        json.className = `choice-json${choice.json === '{}' ? ' empty' : ''}`;
        json.textContent =
          choice.json === '{}' ? '{}  · no opinion, the agent carries on as normal' : choice.json;
        row.append(label, effect, json);
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

  if (!state.sessions.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-note';
    empty.textContent =
      'No sessions yet. Start Claude Code or Codex in a project and its buddy appears here.';
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

    // A buddy of its own, kept against the project name so the same repo looks
    // the same tomorrow.
    const assigned = (state.characterByProject || {})[session.name] || '';
    const pick = document.createElement('select');
    pick.className = 'session-pick';
    pick.title = 'Which buddy this project gets';
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
      window.clippySettings.assign(session.name, pick.value)
    );

    const art = document.createElement('span');
    art.className = 'session-art';
    const character = state.characters.find((c) => c.id === (assigned || session.character));
    if (character) art.appendChild(poseArt(character, posesOf(character)[0], 28));

    row.append(dot, show, status, art, pick);
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
});

// The rail follows whichever section you're reading.
const links = [...document.querySelectorAll('.rail-link')];
const spy = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const link of links) {
        link.classList.toggle('on', link.getAttribute('href') === `#${entry.target.id}`);
      }
    }
  },
  { rootMargin: '-10% 0px -75% 0px' }
);
for (const panel of document.querySelectorAll('.panel')) spy.observe(panel);

window.clippySettings.ready();

/* ---------- Updates ---------- */

// The one deliberate network call in the app, made when you press the button
// and never before. The result speaks plainly: a checkout compares commits
// against main (git pull to catch up), the packaged app compares its version
// against the newest release and links the fresh DMG.
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
        const link = document.createElement('a');
        link.href = info.release.dmg || info.release.url;
        link.textContent = 'download the new DMG';
        // Born after the page-load pass that rewires anchors, so it routes
        // itself: out to the browser, never navigating this window.
        link.addEventListener('click', (e) => {
          e.preventDefault();
          window.clippySettings.openExternal(link.href);
        });
        result.append(link, ' and drag it into Applications again.');
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
