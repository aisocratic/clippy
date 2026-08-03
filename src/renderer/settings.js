'use strict';

/**
 * Clippy's settings window.
 *
 * Everything on the page is built from what main sends: the cast (with each
 * character's animations playing live), the switches that decide what Clippy
 * answers, the catalogue of what it does with a session, and the sessions
 * currently reporting in. Nothing here has its own copy of that knowledge.
 */

const SWITCHES = [
  {
    key: 'approvals',
    title: 'Permission requests',
    desc: 'Answer <b>Allow / Deny</b> from Clippy when Claude Code would show a permission prompt.',
  },
  {
    key: 'answerQuestions',
    title: 'Questions',
    desc: "Turn Claude's multiple-choice questions into buttons, and feed your pick straight back.",
  },
  {
    key: 'reviewOnStop',
    title: 'Review when Claude finishes',
    desc: 'Offer a short review box before a turn ends — typed feedback sends Claude back to work.',
  },
  {
    key: 'autoPerch',
    title: "Perch on the session's window",
    desc: 'Appear on the terminal a session runs in, follow it around, and point at its prompt ' +
      'when something needs answering there.',
  },
];

const SIZE_LABEL = { small: 'Small', medium: 'Medium', large: 'Large' };
const STATUS_TEXT = {
  idle: 'idle',
  working: 'working…',
  waiting: 'finished — your turn',
  needs_permission: 'needs your permission',
};

// One flat object, exactly as main sends it: the settings themselves plus the
// rosters and catalogue the page is drawn from.
let state = { characters: [], sizes: [], actions: [], sessions: [], plans: [] };
const sheetTimers = [];

/* ---------- Buddies ---------- */

/**
 * Draw one animation. Generated characters are GIFs that animate themselves;
 * sprite-sheet packs are stepped here, one frame at a time.
 */
function poseArt(character, pose, height = 64) {
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
      `assets/themes/${character.id}/${character.perColour ? `${colour}-` : ''}${pose}.gif`;
    return (character.poses || ['idle', 'excited']).map((pose) => ({
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

function renderCast() {
  const host = document.getElementById('cast');
  host.replaceChildren();
  const picking = (state.characterMode || 'same') === 'same';

  for (const character of state.characters) {
    const row = document.createElement('div');
    row.className = `cast-row${picking && character.id === state.character ? ' on' : ''}`;

    const who = document.createElement('button');
    who.className = 'cast-who';
    who.title = picking
      ? `Use ${character.label} for every session`
      : `Switch to "Same for all" and use ${character.label}`;
    const name = document.createElement('span');
    name.className = 'cast-name';
    name.textContent = character.label;
    const origin = document.createElement('span');
    origin.className = 'cast-origin';
    origin.textContent = character.sheet
      ? `sprite pack · ${character.sheet.frameWidth}×${character.sheet.frameHeight}`
      : character.perColour
      ? 'drawn in code · per session colour'
      : 'drawn in code';
    who.append(name, origin);
    // Picking a face also means "and use that one" — the friendliest read of
    // clicking one while Clippy is choosing for you.
    who.addEventListener('click', () => {
      if (!picking) set('characterMode', 'same');
      set('character', character.id);
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

function renderModes() {
  const host = document.getElementById('modes');
  const note = document.getElementById('mode-note');
  const modes = state.characterModes || [];
  host.replaceChildren();

  for (const mode of modes) {
    const btn = document.createElement('button');
    btn.className = mode.id === state.characterMode ? 'on' : '';
    btn.textContent = mode.label;
    btn.addEventListener('click', () => set('characterMode', mode.id));
    host.appendChild(btn);
  }
  const current = modes.find((m) => m.id === state.characterMode);
  note.textContent = current ? current.note : '';
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

/* ---------- Plan & allowances ---------- */

// The windows Clippy measures, in the order `/usage` lists them; the ids are
// the keys main keeps a custom allowance under.
const LIMIT_ROWS = [
  { key: 'session', label: 'Current session', note: 'the rolling 5-hour block' },
  { key: 'week', label: 'Current week', note: 'all models, last 7 days' },
  { key: 'weekOpus', label: 'Current week — Opus', note: 'your plan counts Opus again on its own' },
];

// Allowances are typed in millions of tokens: nobody wants to count zeroes,
// and a week of real work runs to hundreds of millions once cache is included.
const MILLION = 1_000_000;
const inMillions = (n) => (n > 0 ? String(Math.round((n / MILLION) * 100) / 100) : '');

function renderPlans() {
  const host = document.getElementById('plans');
  const note = document.getElementById('plan-note');
  const plans = state.plans || [];
  host.replaceChildren();

  for (const plan of plans) {
    const btn = document.createElement('button');
    btn.className = plan.id === (state.plan || 'unknown') ? 'on' : '';
    btn.textContent = plan.label;
    btn.addEventListener('click', () => set('plan', plan.id));
    host.appendChild(btn);
  }
  const current = plans.find((p) => p.id === (state.plan || 'unknown'));
  note.textContent = current ? current.note : '';
  renderLimits(current);
}

// The three boxes currently on screen, kept so a re-render can leave them
// exactly where they are. Typing a number saves it, saving pushes fresh state
// back from main, and a rebuild at that moment would hand the caret to <body>
// mid-form — so the boxes outlive the render that would have replaced them.
let limitBoxes = null; // { plan: id, boxes: Map<key, input> }

/**
 * The three allowances the bars are drawn against.
 *
 * A named tier shows the numbers it is guessing with, so nobody has to take
 * them on trust; only Custom can be typed into, because those are the ones that
 * came from a real `/usage`. Leave a Custom box empty and that window quietly
 * goes back to showing a share of the week — no allowance, no percentage.
 */
function renderLimits(plan) {
  const host = document.getElementById('plan-limits');
  const known = plan && plan.id !== 'unknown';
  host.classList.toggle('hidden', !known);
  if (!known) {
    host.replaceChildren();
    limitBoxes = null;
    return;
  }

  const custom = plan.id === 'custom';
  const mine = state.planLimits || {};
  const valueFor = (key) => inMillions(custom ? mine[key] : (plan.limits || {})[key]);

  // Same plan, same three boxes: refresh what they say and leave the nodes —
  // and whichever one you are halfway through typing into — alone.
  if (limitBoxes && limitBoxes.plan === plan.id) {
    for (const [key, box] of limitBoxes.boxes) {
      if (box !== document.activeElement) box.value = valueFor(key);
    }
    return;
  }

  host.replaceChildren();
  const boxes = new Map();
  // One change writes all three, so a half-typed row can never strand the
  // other two on an older number.
  const commit = () => {
    const limits = {};
    for (const [key, box] of boxes) limits[key] = Math.round(Number(box.value) * MILLION) || 0;
    set('planLimits', limits);
  };

  for (const row of LIMIT_ROWS) {
    const field = document.createElement('div');
    field.className = 'limit';

    const label = document.createElement('label');
    label.textContent = row.label;
    const note = document.createElement('span');
    note.className = 'limit-note';
    note.textContent = row.note;

    const box = document.createElement('input');
    box.type = 'number';
    box.min = '0';
    box.step = '1';
    box.placeholder = 'not set';
    box.value = valueFor(row.key);
    box.disabled = !custom;
    box.title = custom
      ? 'What `/usage` implies this window allows, in millions of tokens'
      : `A ${plan.label} estimate — switch to Custom to correct it`;
    box.addEventListener('change', commit);
    boxes.set(row.key, box);

    const unit = document.createElement('span');
    unit.className = 'limit-unit';
    unit.textContent = 'M tokens';

    field.append(label, note, box, unit);
    host.appendChild(field);
  }
  limitBoxes = { plan: plan.id, boxes };

  if (plan.estimated) {
    const warning = document.createElement('p');
    warning.className = 'limit-warning';
    warning.textContent =
      'Estimates, not facts — Anthropic publishes no token numbers and Claude Code stores none. ' +
      'Run /usage, compare it with the panel over your buddy, and put the corrected numbers in ' +
      'under Custom.';
    host.appendChild(warning);
  }
}

/* ---------- Switches ---------- */

function renderSwitches() {
  const host = document.getElementById('switches');
  host.replaceChildren();

  for (const item of SWITCHES) {
    const on = Boolean(state[item.key]);
    const row = document.createElement('div');
    row.className = 'switch';

    const text = document.createElement('div');
    text.className = 'switch-text';
    const title = document.createElement('div');
    title.className = 'switch-title';
    title.textContent = item.title;
    const desc = document.createElement('div');
    desc.className = 'switch-desc';
    desc.innerHTML = item.desc; // fixed copy from the list above, never user input
    text.append(title, desc);

    const toggle = document.createElement('button');
    toggle.className = `toggle${on ? ' on' : ''}`;
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(on));
    toggle.setAttribute('aria-label', item.title);
    toggle.addEventListener('click', () => set(item.key, !state[item.key]));

    row.append(text, toggle);
    host.appendChild(row);
  }
}

/* ---------- What Clippy can do ---------- */

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
      tag.title = 'the Claude Code hook that triggers this';
      head.appendChild(tag);
    }
    // Say plainly when a switch on this page has this turned off.
    if (action.setting && !state[action.setting]) {
      const off = document.createElement('span');
      off.className = 'tag off';
      off.textContent = 'off';
      off.title = 'turned off in "What Clippy answers"';
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
          choice.json === '{}' ? '{}  · no opinion, Claude Code carries on as normal' : choice.json;
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
      'No sessions yet. Start Claude Code in a project and its buddy appears here.';
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
    show.textContent = session.name;
    show.title = 'Bring this buddy to the front';
    show.addEventListener('click', () => window.clippySettings.showBuddy(session.sessionId));

    const status = document.createElement('span');
    status.className = 'session-status';
    status.textContent = STATUS_TEXT[session.status] || session.status || '';

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
  renderModes();
  renderSizes();
  renderCast();
  renderPlans();
  renderSwitches();
  renderActions();
  renderSessions();

  const text = document.getElementById('server-text');
  text.textContent = state.port ? `listening on 127.0.0.1:${state.port}` : 'hook server';
  text.title = 'Where the Claude Code hooks report in';
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
