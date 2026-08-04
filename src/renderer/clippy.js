'use strict';

const REMIND_AFTER_MS = 90 * 1000; // re-bounce if a session is still ignored
const SNOOZE_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 1000;
const EXTEND_THROTTLE_MS = 5 * 1000; // while typing, ask main to extend the hold
const GHOST_GRACE_MS = 5 * 1000; // how long past its deadline a card may linger

/* ---------- Identity: this window watches exactly one session ---------- */

const params = new URLSearchParams(location.search);
const me = {
  name: params.get('name') || 'session',
  color: params.get('color') || '#9aa3ad',
};

document.documentElement.style.setProperty('--clip', me.color);

const clippyEl = document.getElementById('clippy');
const bubbleEl = document.getElementById('bubble');
const bubbleText = document.getElementById('bubble-text');
const btnFix = document.getElementById('btn-fix');
let bubbleFix = null; // what the "fix it" button on this message would do
const badgeEl = document.getElementById('badge');
const statusEl = document.getElementById('statusline');

const cardEl = document.getElementById('card');
const cardQueue = document.getElementById('card-queue');
const cardTitle = document.getElementById('card-title');
const cardDetail = document.getElementById('card-detail');
const cardOptions = document.getElementById('card-options');
const cardInput = document.getElementById('card-input');
const countdownFill = document.getElementById('card-countdown-fill');
const btnAllow = document.getElementById('btn-allow');
const btnDeny = document.getElementById('btn-deny');
const btnPass = document.getElementById('btn-pass');
const btnGood = document.getElementById('btn-good');
const btnFeedback = document.getElementById('btn-feedback');
const btnSubmit = document.getElementById('btn-submit');
const btnDismiss = document.getElementById('btn-dismiss');
const btnGoto = document.getElementById('btn-goto');

const driveEl = document.getElementById('drive');
const driveTitle = document.getElementById('drive-title');
const driveTranscript = document.getElementById('drive-transcript');
const driveActivity = document.getElementById('drive-activity');
const driveInput = document.getElementById('drive-input');
const buddyEl = document.getElementById('buddy');

const btnOpen = document.getElementById('btn-open');
const usageEl = document.getElementById('usage');
const usageModel = document.getElementById('usage-model');
const usageStatus = document.getElementById('usage-status');
const usageBarFill = document.getElementById('usage-bar-fill');
const usageContext = document.getElementById('usage-context');
const usageBars = document.getElementById('usage-bars');
const usageNote = document.getElementById('usage-note');
const usageInput = document.getElementById('usage-input');

const menuEl = document.getElementById('menu');
const menuName = document.getElementById('menu-name');
const menuStatus = document.getElementById('menu-status');
const menuWaiting = document.getElementById('menu-waiting');

const sheetEl = document.getElementById('buddy-sheet');
let sheetTimer = null;
let pose = 'idle'; // what the buddy is doing right now, by name
let pointing = false; // standing on a prompt
let troubledUntil = 0; // a tool failed recently
let greetingUntil = 0; // this session just started
let pettedUntil = 0; // double-clicked just now — say hi back
let clickedUntil = 0; // single-clicked just now — a quick acknowledging wave
let contextTight = false; // the context window is filling up

const pointerEl = document.getElementById('pointer');
let walkTimer = null;

const whoEl = document.getElementById('who');
const whoName = document.getElementById('who-name');
const activityEl = document.getElementById('activity');
const qcardEl = document.getElementById('qcard');
const qcardTitle = document.getElementById('qcard-title');
const qcardDetail = document.getElementById('qcard-detail');
const btnQgoto = document.getElementById('btn-qgoto');

// sessionId -> { message, urgency, name, lastNudge, snoozedUntil, acknowledged }
const pending = new Map();
// requestId -> { id, type: 'approval'|'review', name, title, detail, expiresAt, holdMs }
const requests = new Map();
let activeRequestId = null;
let myStatus = 'idle';

const STATUS_TEXT = {
  idle: 'idle — waiting for a prompt',
  working: 'working…',
  waiting: 'finished — your turn',
  needs_permission: 'needs your permission',
};
// The same states, short enough for the menu's header line.
const SHORT_STATUS = {
  idle: 'idle',
  working: 'working',
  waiting: 'your turn',
  needs_permission: 'needs you',
};
// Main owns these; the cast and the size steps arrive with them so the menu
// never has its own copy of the list.
let settings = {
  approvals: true,
  reviewOnStop: true,
  answerQuestions: true,
  autoPerch: true,
  character: 'clip',
  size: 'medium',
  // Enough of a roster to paint the default buddy correctly on the very first
  // frame; main replaces all of it a moment later.
  characters: [{ id: 'clip', label: '📎 Clippy', perColour: true }],
  sizes: [{ id: 'medium', buddy: 96 }],
};
const SIZE_LABEL = { small: 'S', medium: 'M', large: 'L' };
let lastExtendAt = 0;
let canOpen = false; // do we know which terminal window this session lives in?
let docked = false; // perched on that window's top-right corner

/* ---------- Window size: a paperclip until there's something to read ---------- */

let modeSent = null;
let heightSent = 0;

const PANELS = ['card', 'bubble', 'qcard', 'usage', 'drive', 'menu'];

/**
 * How tall the window has to be for everything on the stage to fit. Measured
 * rather than guessed: a one-line approval and a 40-line plan are very
 * different windows, and the fixed size used to cut the taller one off.
 */
function contentHeight() {
  const stage = document.getElementById('stage');
  const style = getComputedStyle(stage);
  let h = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  for (const el of stage.children) {
    if (el.classList.contains('hidden')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    h += el.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
  }
  return Math.ceil(h) + 4; // a hair of slack for shadows and the card's tail
}

/**
 * Clippy's window is only as big as it needs to be. Main owns the geometry, so
 * the renderer just says which of the two sizes its current contents want, and
 * how tall the full one has to be.
 */
function syncMode() {
  const showing = PANELS.some((id) => !document.getElementById(id).classList.contains('hidden'));
  const want = showing ? 'full' : 'compact';
  // Measure after layout has settled, so a card that just appeared is included.
  const height = want === 'full' ? contentHeight() : 0;
  if (want === modeSent && Math.abs(height - heightSent) < 6) return;
  modeSent = want;
  heightSent = height;
  window.clippyAPI.setMode(want, height);
}

/* ---------- UI helpers ---------- */

function applyIdentity() {
  whoName.textContent = me.name;
  whoEl.title = `Claude Code session: ${me.name}`;
}

/**
 * The GIF for this character and pose. Every character lives in its own theme
 * folder; Clippy is the only one built per session colour, since a GIF can't be
 * recoloured by CSS.
 */
function buddyArt(pose) {
  const who = settings.character || 'clip';
  const character = (settings.characters || []).find((c) => c.id === who);
  // The clips are drawn per session colour; everyone else has one set of art.
  const tint = character && character.perColour ? `${me.color.replace('#', '')}-` : '';
  return `assets/themes/${who}/${tint}${pose}.gif`;
}

/** The pose that fits what's happening — falling back to what this buddy has. */
function poseFor(name) {
  const character = (settings.characters || []).find((c) => c.id === settings.character);
  const has = character && (character.sheet ? character.sheet.poses : toSet(character.poses));
  for (const want of [name, 'excited', 'idle']) {
    if (!has || has[want]) return want;
  }
  return 'idle';
}

const toSet = (list) => Object.fromEntries((list || ['idle', 'excited']).map((p) => [p, true]));

/** The sprite-sheet definition for the current character, if it has one. */
function currentSheet() {
  const who = (settings.characters || []).find((c) => c.id === settings.character);
  return who && who.sheet ? who.sheet : null;
}

/** Show a pose by name — `walk`, `point`, `excited`, `idle`… */
function setPose(name) {
  pose = poseFor(name);
  const sheet = currentSheet();
  if (sheet) {
    playSheet(sheet, pose);
    return;
  }
  // The drawn buddies animate inside the GIF, so a change of pose is a change
  // of file. The suffix restarts the animation from its first frame.
  const want = buddyArt(pose);
  if (!buddyEl.src.includes(want)) buddyEl.src = `${want}?${pose[0]}`;
}

function setExcited(on) {
  clippyEl.classList.toggle('excited', on);
  refreshPose();
}

/**
 * What the buddy should be doing, from what it knows — most specific first.
 *
 * A pose is a status line you can read across the room: sweating means
 * something failed or the context window is filling up, bouncing means this
 * session wants you, curled up means the turn is over.
 */
function poseForState() {
  if (document.body.classList.contains('walking')) return 'walk';
  if (pettedUntil > Date.now()) return 'cheer'; // you just double-clicked him
  if (clickedUntil > Date.now()) return 'wave'; // you just clicked him once
  if (pointing) return 'point';
  if (greetingUntil > Date.now()) return 'wave';
  if (activeRequestId || currentUrgent()) return 'excited';
  if (troubledUntil > Date.now() || contextTight) return 'stress';
  if (myStatus === 'working') return 'think';
  if (myStatus === 'waiting') return 'sleep'; // finished — nothing left to do
  return 'idle';
}

function refreshPose() {
  const want = poseForState();
  clippyEl.classList.toggle('stressed', want === 'stress');
  if (want !== pose) setPose(want);
}

/** Same buddy, same behaviour, different shape — and one constant size. */
function applyCharacter() {
  const sheet = currentSheet();
  buddyEl.classList.toggle('hidden', Boolean(sheet));
  sheetEl.classList.toggle('hidden', !sheet);
  if (!sheet) stopSheet();
  applySize();
  setPose(pose);
}

/**
 * Step a sprite sheet frame by frame: the sheet is scaled as a whole and the
 * window onto it moves along the pose's row.
 *
 * Small pixel art is blown up by whole numbers only (2x, 3x) because half a
 * pixel is mush; a sheet that's already bigger than the buddy is scaled down to
 * fit, where fractions are fine.
 */
function playSheet(sheet, name) {
  const pose = sheet.poses[name] || sheet.poses.idle;
  const want = buddyPx() / sheet.frameWidth;
  const scale = want >= 1 ? Math.round(want) : want;
  const w = sheet.frameWidth * scale;
  const h = sheet.frameHeight * scale;

  sheetEl.style.width = `${w}px`;
  sheetEl.style.height = `${h}px`;
  sheetEl.style.backgroundImage = `url("${pose.file}")`;
  sheetEl.style.backgroundSize = `${w * sheet.columns}px ${h * sheet.rows}px`;

  stopSheet();
  let frame = 0;
  const step = () => {
    sheetEl.style.backgroundPosition = `-${frame * w}px -${pose.row * h}px`;
    frame = (frame + 1) % pose.frames;
  };
  step();
  if (pose.frames > 1) sheetTimer = setInterval(step, Math.round(1000 / sheet.fps));
}

function stopSheet() {
  clearInterval(sheetTimer);
  sheetTimer = null;
}

/** How wide the buddy is drawn, per the size you picked. */
function buddyPx() {
  const step = (settings.sizes || []).find((s) => s.id === settings.size);
  return step ? step.buddy : 96;
}

/** The buddy is drawn at whatever size you picked, in every mode. */
function applySize() {
  document.documentElement.style.setProperty('--buddy', `${buddyPx()}px`);
}

// The art is generated, so a missing file means the build didn't run — show
// nothing rather than a broken-image icon, and say why in the console.
buddyEl.addEventListener('error', () => {
  buddyEl.classList.add('hidden');
  console.warn(`clippy: missing ${buddyEl.src} — run \`npm run make-buddies\``);
});

function showBubble(text, { fix = null } = {}) {
  bubbleText.textContent = text;
  bubbleFix = fix;
  btnFix.classList.toggle('hidden', !fix);
  usageEl.classList.add('hidden'); // news wins over the token panel
  menuEl.classList.add('hidden');
  bubbleEl.classList.remove('hidden');
  syncMode();
}

function hideBubble() {
  bubbleEl.classList.add('hidden');
  if (!activeRequestId) setExcited(false);
  syncMode();
}

/* ---------- Click menu ---------- */

function menuOpen() {
  return !menuEl.classList.contains('hidden');
}

/** Only offer what this buddy can actually do right now. */
function syncMenuItems() {
  const waiting = [...pending.values()].some((p) => !p.acknowledged);
  menuWaiting.classList.toggle('hidden', !waiting);
  menuName.textContent = me.name;
  menuStatus.textContent = SHORT_STATUS[myStatus] || myStatus;
}

function openMenu() {
  syncMenuItems();
  menuEl.classList.remove('hidden');
  syncMode();
}

function closeMenu() {
  if (!menuOpen()) return;
  menuEl.classList.add('hidden');
  syncMode();
}

function toggleMenu() {
  if (menuOpen()) closeMenu();
  else openMenu();
}

function render() {
  const active = [...pending.values()].filter((p) => !p.acknowledged);
  const open = active.length + requests.size;
  badgeEl.textContent = String(open);
  badgeEl.classList.toggle('hidden', open === 0);

  // This window speaks for one session only, so the status line is about it.
  statusEl.textContent = STATUS_TEXT[myStatus] || myStatus;
  whoEl.classList.toggle('busy', myStatus === 'working');

  // Every route to the terminal window needs to know we can find it.
  btnOpen.classList.toggle('hidden', !canOpen);
  btnGoto.classList.toggle('hidden', !canOpen);
  btnQgoto.classList.toggle('hidden', !canOpen);

  // Perching, a terminal we can find, a message waiting: all of it can change
  // while the menu is on screen.
  if (menuOpen()) syncMenuItems();
  // The combined panel is meant to be left open while the agent works, so its
  // status line follows the session rather than freezing at whatever it said
  // when the panel opened.
  if (!usageEl.classList.contains('hidden')) usageStatus.textContent = statusSummary();

  refreshPose();
  syncMode();
}

function nudge(p) {
  p.lastNudge = Date.now();
  if (activeRequestId) return; // an interactive card owns the stage right now
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

/* ---------- Ambient activity line ("what's Claude doing right now") ---------- */

const TROUBLE_MS = 25 * 1000; // how long a failure keeps the buddy sweating

// The last thing this session was seen doing. The line under the buddy shows it
// only when nothing else is open, but the combined panel wants it too, so the
// label is kept here rather than read back out of the DOM.
let latestActivity = '';

function showActivity(name, activity) {
  if (!activity || !activity.label) {
    latestActivity = '';
    activityEl.classList.add('hidden');
    return;
  }
  if (activity.ok === false) troubledUntil = Date.now() + TROUBLE_MS;
  const icon = !activity.ok ? '⚠' : activity.state === 'done' ? '✓' : '⚙';
  latestActivity = `${icon} ${activity.label}`;
  activityEl.textContent = `${icon} ${name} — ${activity.label}`;
  activityEl.classList.toggle('failed', !activity.ok);
  activityEl.classList.remove('hidden');
}

function clearActivity() {
  latestActivity = '';
  activityEl.classList.add('hidden');
  activityEl.classList.remove('failed');
}

/** What this agent is up to, in one line: its state, and the tool it's on. */
function statusSummary() {
  const state = STATUS_TEXT[myStatus] || myStatus;
  return latestActivity ? `${state} · ${latestActivity}` : state;
}

/* ---------- Read-only question card (AskUserQuestion surfacing) ---------- */

function showQuestion(evt) {
  qcardTitle.textContent = evt.title || 'Claude is asking you a question';
  qcardDetail.textContent = evt.detail || '';
  qcardDetail.classList.toggle('hidden', !evt.detail);
  // The picker is up in the terminal — the question is readable here, and this
  // takes you to where it can be answered.
  btnQgoto.classList.toggle('hidden', !canOpen);
  menuEl.classList.add('hidden');
  qcardEl.classList.remove('hidden');
  setExcited(true);
  syncMode();
}

function hideQuestion() {
  qcardEl.classList.add('hidden');
  if (!activeRequestId) setExcited(currentUrgent());
  syncMode();
}

/* ---------- The combined panel: status, usage, and a box to reply in ---------- */

const fmtTokens = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(v);
};

const shortModel = (m) => String(m || '').replace(/^claude-/, '') || 'unknown model';

/** in + out + cache, i.e. everything the plan's allowance sees. */
const allTokens = (t) => (t ? t.input + t.output + t.cacheRead + t.cacheCreate : 0);

/**
 * One labelled bar. `fraction` is how full it is drawn — of an allowance you
 * told Clippy about, or (when you haven't) of the week's spend, which the row
 * has to say out loud. Claude Code keeps the real allowances server-side, so a
 * bar must never imply "you have X% left" unless someone supplied the X.
 *
 * Pass `fraction` as null for a row that *is* the yardstick rather than a share
 * of one: it gets no track at all, because a bar drawn as a share of itself is
 * pinned full, and a full bar reads as "all gone" to everyone who never hovers.
 *
 * `sub` is the grey line under the label: what this window covers. It gets a
 * line of its own because the row above it is already a name and a number, and
 * a third thing squeezed in beside them is a thing nobody can read.
 */
function bar(label, value, fraction, { hint = '', tone = '', sub = '' } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'ubar';
  if (hint) wrap.title = hint;

  const head = document.createElement('div');
  head.className = 'ubar-head';
  const name = document.createElement('span');
  name.textContent = label;
  const amount = document.createElement('b');
  amount.textContent = value;
  head.append(name, amount);

  const when = document.createElement('div');
  when.className = 'ubar-sub';
  when.textContent = sub;

  const rails = [];
  if (fraction !== null) {
    const track = document.createElement('div');
    track.className = 'ubar-track';
    const fill = document.createElement('div');
    fill.className = `ubar-fill${tone ? ` ${tone}` : ''}`;
    // A sliver so a real-but-tiny number is still visible — but nothing spent
    // draws nothing, because a stub of colour reads as "something happened".
    const pct = Math.min(100, Math.round(fraction * 100));
    fill.style.width = fraction > 0 ? `${Math.max(2, pct)}%` : '0';
    track.appendChild(fill);
    rails.push(track);
  }

  wrap.append(head, ...(sub ? [when] : []), ...rails);
  return wrap;
}

// The three windows `/usage` reports against, in the order it lists them. Each
// one is machine-wide: the allowance doesn't care which terminal spent it.
const WINDOWS = [
  {
    key: 'session',
    label: 'session · 5 hours',
    what: 'everything every session on this machine has spent in the rolling 5-hour block',
  },
  {
    key: 'week',
    label: 'week · all models',
    what: 'everything spent in the last 7 days, all models',
  },
  {
    key: 'weekOpus',
    label: 'week · Opus',
    what: 'the Opus share of the last 7 days, which your plan counts separately',
  },
];

/** "4:11pm" today, "Mon 27 Jul" once it is further back than that. */
function clockOf(ts, now) {
  const then = new Date(ts);
  return new Date(now).toDateString() === then.toDateString()
    ? then.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : then.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * The grey line under a window's label.
 *
 * It used to count down to a reset, which was the one number on this panel
 * Clippy had made up: these windows trail the clock, so when the oldest message
 * drops out of one nothing resets — the bar twitches and the spend stays. The
 * block the allowance actually refills on lives on the server, so the line says
 * where this window's spend starts and points at the only thing that knows.
 */
function covers(win, now) {
  return win.firstAt
    ? `counting from ${clockOf(win.firstAt, now)} · /usage has the reset`
    : 'nothing counted yet';
}

/**
 * One window as a bar.
 *
 * With an allowance it's the real thing: spend over limit, warming up as it
 * fills. Without one there is nothing to be a percentage *of*, so the bar falls
 * back to this window's share of the week and the row says that is what it is —
 * except for the week itself, which is that share's denominator and so gets no
 * bar rather than one pinned full of itself.
 */
function windowBar(row, win, limit, weekTotal, now, estimated) {
  const spent = allTokens(win.totals);
  const sub = covers(win, now);
  // The star is the old panel's: this total is a floor, and the row says why.
  const label = win.truncated ? `${row.label} *` : row.label;
  const capped = win.truncated
    ? ' Some older transcripts were skipped to keep this quick, so the total is a floor.'
    : '';
  const clock =
    ' The grey line is where the spend Clippy can see begins, not a reset: run /usage in Claude ' +
    'Code for the block the server keeps.';

  if (limit > 0) {
    const pct = Math.round((spent / limit) * 100);
    // Past the allowance the percentage has stopped measuring anything, so it
    // stops being quoted — "1570%" is a fact about the number you typed in.
    const over =
      pct > 100
        ? ` Past it, in fact, which usually says the allowance is wrong rather than that you spent ` +
          `${Math.round(pct / 100)}× your plan — run /usage and correct it under Custom.`
        : '';
    return bar(label, `${fmtTokens(spent)} / ${fmtTokens(limit)}`, spent / limit, {
      sub,
      tone: pct >= 85 ? 'hot' : pct >= 60 ? 'warn' : '',
      hint:
        `${pct > 100 ? 'All' : `${pct}%`} of ` +
        `${estimated ? 'an estimated allowance' : 'the allowance you set'} — ${row.what}.` +
        `${over}${clock}${capped}`,
    });
  }

  // Every other row is drawn as a share of the week, which leaves the week with
  // nothing to be a share of but itself.
  const yardstick = row.key === 'week';
  return bar(label, fmtTokens(spent), yardstick ? null : weekTotal > 0 ? spent / weekTotal : 0, {
    sub: yardstick ? 'the week the other two are shares of' : sub,
    tone: 'share',
    hint: yardstick
      ? `${row.what}. No allowance is set, so this total is all the other bars have to be a share ` +
        `of — and nothing is left to draw it against, which is why it has no bar. Tell Clippy your ` +
        `plan in Settings to measure it against something.${clock}${capped}`
      : `${row.what}. No allowance is set, so the bar is this window's share of the last 7 days — ` +
        `spend, not what's left. Tell Clippy your plan in Settings to measure it against ` +
        `something.${clock}${capped}`,
  });
}

/**
 * The one panel a left click opens: what the agent is doing, what it has spent,
 * and a box to say the next thing. It used to take three separate visits — the
 * status line under the buddy, the token panel, the composer — for what is
 * really one question ("how is this session doing, and what now?").
 */
async function showUsage() {
  const data = await window.clippyAPI.usage();
  if (!data) return;
  const { session, windows, limits, plan } = data;
  const now = data.now || Date.now();

  // The panel and a speech bubble both want the space above Clippy's head.
  bubbleEl.classList.add('hidden');
  qcardEl.classList.add('hidden');
  menuEl.classList.add('hidden');

  usageModel.textContent = shortModel(session?.model);
  usageStatus.textContent = statusSummary();

  if (session && session.turns > 0) {
    const pct = Math.min(100, Math.round((session.context / session.contextLimit) * 100));
    const left = Math.max(0, session.contextLimit - session.context);
    usageBarFill.style.width = `${pct}%`;
    usageBarFill.classList.toggle('warn', pct >= 60 && pct < 85);
    usageBarFill.classList.toggle('hot', pct >= 85);
    // What's left is the number you act on, so it leads.
    usageContext.innerHTML = '';
    const strong = document.createElement('b');
    strong.textContent = `${fmtTokens(left)} left`;
    usageContext.append(
      strong,
      ` of ${fmtTokens(session.contextLimit)} context · ${fmtTokens(session.context)} used (${pct}%)`
    );
  } else {
    usageBarFill.style.width = '0';
    usageContext.textContent = 'no transcript for this session yet';
  }

  // Cached input dwarfs everything else (it's re-read every turn), so every bar
  // counts total-with-cache — the same thing the plan's allowance is spent on.
  const week = windows && windows.week;
  const weekTotal = week ? allTokens(week.totals) : 0;
  usageBars.replaceChildren();

  for (const row of WINDOWS) {
    const win = windows && windows[row.key];
    if (!win) continue;
    const limit = (limits && limits[row.key]) || 0;
    usageBars.append(windowBar(row, win, limit, weekTotal, now, plan && plan.estimated));
  }

  // Where it went: the models you actually leaned on this week.
  const models = Object.entries((week && week.byModel) || {})
    .map(([model, totals]) => [model, allTokens(totals)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (models.length) {
    const head = document.createElement('div');
    head.className = 'ubar-group';
    head.textContent = 'by model, last 7 days';
    usageBars.append(head);
    for (const [model, spent] of models) {
      usageBars.append(
        bar(shortModel(model), fmtTokens(spent), weekTotal > 0 ? spent / weekTotal : 0, {
          tone: 'alt',
          hint: 'share of the last 7 days, including cached input',
        })
      );
    }
  }

  // The one thing this panel must never fudge: whose number the bars are.
  const named = plan && plan.id && plan.id !== 'unknown';
  usageNote.textContent = !named
    ? 'No allowance set — bars are shares of the last 7 days. Set your plan under Usage & limits ' +
      'in Settings (📎 in the menu bar) to measure them against something, and run /usage in ' +
      'Claude Code for the real numbers.'
    : plan.estimated
    ? `Measured against a rough ${plan.label} estimate — run /usage in Claude Code and correct it ` +
      'under Custom in Settings (📎 in the menu bar). Clippy counts what you spent; only /usage ' +
      'knows what is left.'
    : `Measured against the limits you set. Clippy counts what you spent; only /usage knows what ` +
      'is left.';

  usageEl.classList.remove('hidden');
  syncMode();
  // The panel is also where you type the next prompt, so the caret starts there.
  usageInput.focus();
}

function hideUsage() {
  usageEl.classList.add('hidden');
  syncMode();
}

/* ---------- Drive mode panel (Clippy-driven Agent SDK session) ---------- */

function openDrive(evt) {
  driveTitle.textContent = `Driving “${evt.name}”`;
  driveTranscript.innerHTML = '';
  driveActivity.classList.add('hidden');
  driveEl.classList.remove('hidden');
}

function closeDrive() {
  driveEl.classList.add('hidden');
  driveActivity.classList.add('hidden');
}

function setDriveStatus(evt) {
  if (evt.status === 'error') addDriveLine('system', `⚠ ${evt.message || 'error'}`);
  else if (evt.status === 'ended') addDriveLine('system', '— session ended —');
  else if (evt.status === 'turn-done') driveActivity.classList.add('hidden');
}

function addDriveLine(role, text) {
  if (!text) return;
  const line = document.createElement('div');
  line.className = `drive-line ${role}`;
  line.textContent = (role === 'user' ? 'you: ' : role === 'system' ? '' : 'claude: ') + text;
  driveTranscript.appendChild(line);
  driveTranscript.scrollTop = driveTranscript.scrollHeight;
}

/* ---------- Interactive cards (approvals & reviews) ---------- */

function showNextRequest() {
  const next = requests.values().next().value;
  if (!next) {
    activeRequestId = null;
    cardEl.classList.add('hidden');
    syncMode();
    setExcited(currentUrgent());
    // surface whatever passive nudge was waiting behind the card
    const p = [...pending.values()].find((x) => !x.acknowledged);
    if (p) nudge(p);
    return;
  }

  activeRequestId = next.id;
  hideBubble();
  qcardEl.classList.add('hidden'); // a held card takes the stage
  menuEl.classList.add('hidden');

  const isApproval = next.type === 'approval';
  const isAnswer = next.type === 'answer';
  const isPlan = next.variant === 'plan';
  showQueueDepth();
  cardTitle.textContent = next.title;

  // Answerable multiple-choice question — option buttons. The answer is fed
  // straight back to Claude (hook: updatedInput.answers, Drive: canUseTool),
  // so the terminal picker never has to appear.
  if (isAnswer) {
    cardDetail.classList.add('hidden');
    cardInput.classList.add('hidden');
    renderAnswerOptions(next);
    for (const b of [btnAllow, btnDeny, btnGood, btnFeedback]) b.classList.add('hidden');
    // A held question can't be in two places at once: while Clippy holds it,
    // Claude Code hasn't run the tool, so there is no picker in the terminal
    // yet. This button hands it over — release the hook so the picker appears,
    // and raise that terminal window so you land on it.
    btnPass.textContent = canOpen ? 'Move to terminal ↗' : 'Ask me in terminal';
    btnPass.classList.toggle('hidden', !!next.noPass);
    btnSubmit.classList.remove('hidden');
    btnDismiss.classList.remove('hidden');
    cardEl.classList.remove('hidden');
    syncMode();
    setExcited(true);
    return;
  }

  cardOptions.classList.add('hidden');
  cardOptions.innerHTML = '';
  cardInput.classList.remove('hidden');
  btnSubmit.classList.add('hidden');
  btnDismiss.classList.add('hidden');

  cardDetail.textContent = next.detail || '';
  cardDetail.classList.toggle('hidden', !next.detail);
  cardInput.value = '';
  cardInput.placeholder = isPlan
    ? 'optional: what to change before approving (Revise sends this back)…'
    : isApproval
    ? 'optional: tell Claude why, or what to do instead…'
    : 'type feedback to send Claude back to work…';
  // Plan approvals reuse the allow/deny path but read better as Approve/Revise.
  btnAllow.textContent = isPlan ? 'Approve plan' : 'Allow';
  btnDeny.textContent = isPlan ? 'Revise' : 'Deny';
  btnPass.textContent = canOpen ? 'Ask me in terminal ↗' : 'Ask me in terminal';
  btnAllow.classList.toggle('hidden', !isApproval);
  btnDeny.classList.toggle('hidden', !isApproval);
  btnPass.classList.toggle('hidden', !isApproval || next.noPass); // Drive has no terminal
  btnGood.classList.toggle('hidden', isApproval);
  btnFeedback.classList.toggle('hidden', isApproval);
  btnFeedback.disabled = true;

  cardEl.classList.remove('hidden');
  syncMode();
  setExcited(true);
}

/** "+2 more": how many held requests are stacked up behind this card. */
function showQueueDepth() {
  cardQueue.classList.toggle('hidden', requests.size <= 1);
  cardQueue.textContent = `+${requests.size - 1} more`;
}

// answers map for the active answer card: questionText -> label | [labels]
let answerState = {};

function renderAnswerOptions(req) {
  answerState = {};
  cardOptions.innerHTML = '';
  for (const q of req.questions || []) {
    answerState[q.question] = q.multiSelect ? [] : null;
    const group = document.createElement('div');
    group.className = 'opt-group';
    const label = document.createElement('div');
    label.className = 'opt-question';
    label.textContent = q.question;
    group.appendChild(label);
    for (const opt of q.options || []) {
      const btn = document.createElement('button');
      btn.className = 'opt';
      btn.textContent = opt.label;
      if (opt.description) btn.title = opt.description;
      btn.addEventListener('click', () => {
        if (q.multiSelect) {
          const sel = answerState[q.question];
          const i = sel.indexOf(opt.label);
          if (i >= 0) sel.splice(i, 1);
          else sel.push(opt.label);
          btn.classList.toggle('chosen', i < 0);
        } else {
          answerState[q.question] = opt.label;
          [...group.querySelectorAll('.opt')].forEach((b) => b.classList.remove('chosen'));
          btn.classList.add('chosen');
        }
        btnSubmit.disabled = !answersComplete();
      });
      group.appendChild(btn);
    }
    cardOptions.appendChild(group);
  }
  cardOptions.classList.remove('hidden');
  btnSubmit.disabled = !answersComplete();
}

function answersComplete() {
  return Object.values(answerState).every((v) => (Array.isArray(v) ? v.length > 0 : v != null));
}

function decide(action, message = '') {
  if (!activeRequestId) return;
  window.clippyAPI.decide(activeRequestId, action, message);
  requests.delete(activeRequestId);
  showNextRequest();
  render();
}

// Shrink the countdown bar; main resolves the request server-side on timeout,
// this is just so the user can see how long Clippy can wait.
setInterval(() => {
  // Safety net: main sends `request-closed` when a hold expires, but if that
  // event is ever missed the card would sit there accepting clicks that can no
  // longer reach Claude. Drop anything well past its deadline.
  const now = Date.now();
  let dropped = false;
  for (const [id, req] of requests) {
    if (now - req.expiresAt > GHOST_GRACE_MS) {
      requests.delete(id);
      dropped = true;
    }
  }
  if (dropped) {
    if (!requests.has(activeRequestId)) showNextRequest();
    render();
  }

  if (!activeRequestId) return;
  const req = requests.get(activeRequestId);
  if (!req) return;
  const left = Math.max(0, req.expiresAt - now);
  countdownFill.style.width = `${Math.min(100, (left / req.holdMs) * 100)}%`;
}, 200);

/* ---------- Event handling from main process ---------- */

window.clippyAPI.onSettings((s) => {
  settings = s;
  applyCharacter();
  render();
});

window.clippyAPI.onIdentity((id) => {
  Object.assign(me, id);
  applyIdentity();
});

function handleEvent(evt) {
  if (evt.status) myStatus = evt.status;
  if (evt.name && evt.name !== me.name) {
    me.name = evt.name;
    applyIdentity();
  }

  switch (evt.kind) {
    case 'approval':
    case 'review': {
      requests.set(evt.requestId, {
        id: evt.requestId,
        type: evt.kind,
        variant: evt.variant || 'tool',
        noPass: !!evt.noPass,
        name: evt.name,
        title: evt.kind === 'approval' ? evt.title : evt.message,
        detail: evt.detail || '',
        expiresAt: evt.expiresAt,
        holdMs: Math.max(1, evt.expiresAt - Date.now()),
      });
      if (!activeRequestId) showNextRequest();
      else showQueueDepth(); // another one queued behind the open card
      break;
    }
    case 'answer': {
      // An answerable multiple-choice question (option buttons). Comes from
      // the AskUserQuestion hook in watch mode, or canUseTool in Drive mode.
      const expiresAt = evt.expiresAt || Date.now() + 300000;
      requests.set(evt.requestId, {
        id: evt.requestId,
        type: 'answer',
        noPass: !!evt.noPass,
        name: evt.name,
        title: evt.title || 'Claude is asking you',
        questions: evt.questions || [],
        expiresAt,
        holdMs: Math.max(1, expiresAt - Date.now()),
      });
      if (!activeRequestId) showNextRequest();
      else showQueueDepth(); // another one queued behind the open card
      break;
    }
    case 'drive-open':
      openDrive(evt);
      break;
    case 'drive-close':
      closeDrive();
      break;
    case 'drive-status':
      setDriveStatus(evt);
      break;
    case 'drive-transcript':
      addDriveLine(evt.role, evt.text);
      break;
    case 'drive-activity':
      driveActivity.textContent = `⚙ ${evt.label || ''}`;
      driveActivity.classList.toggle('hidden', !evt.label);
      break;
    case 'activity': {
      showActivity(evt.name, evt.activity);
      break;
    }
    case 'can-open': {
      canOpen = Boolean(evt.value);
      break;
    }
    case 'dock': {
      // Perched on the session's terminal window: happy, small, and quiet
      // until something actually needs an answer.
      docked = Boolean(evt.docked);
      document.body.classList.toggle('docked', docked);
      // Compact is about size, not about being perched — a corner buddy is a
      // bare paperclip too until it has something to show.
      document.body.classList.toggle('compact', Boolean(evt.compact));
      // Clicking a compact buddy opens the panel before main has grown the
      // window, and a display:none textarea can't take the caret — so the
      // composer claims it here, once the panel is actually on screen.
      if (!evt.compact && !usageEl.classList.contains('hidden')) usageInput.focus();
      break;
    }
    case 'pose': {
      // A dev hook: the test bench uses it to look at one animation. Nothing in
      // the app sends this — the buddy picks its own pose from what it knows.
      setPose(evt.name || 'idle');
      break;
    }
    case 'walk': {
      // Main is stepping the window across the terminal; all we do is put him
      // in a walking pose, facing the way he's going.
      document.body.classList.add('walking');
      document.body.classList.toggle('facing-left', evt.facing === 'left');
      refreshPose();
      clearTimeout(walkTimer);
      // Safety net: if the walk event that ends this one never lands, don't
      // leave him marching on the spot forever.
      walkTimer = setTimeout(() => {
        document.body.classList.remove('walking');
        refreshPose();
      }, 4000);
      break;
    }
    case 'point': {
      document.body.classList.remove('walking');
      clearTimeout(walkTimer);
      pointing = Boolean(evt.on);
      pointerEl.classList.toggle('hidden', !pointing);
      refreshPose();
      break;
    }
    case 'question': {
      // Surface-only: hooks can't answer AskUserQuestion (that's Drive mode).
      showQuestion(evt);
      break;
    }
    case 'request-closed': {
      // resolved elsewhere: timeout, terminal answer, or session moved on
      if (requests.delete(evt.requestId) && evt.requestId === activeRequestId) {
        showNextRequest();
      }
      break;
    }
    case 'extended': {
      const req = requests.get(evt.requestId);
      if (req) {
        req.expiresAt = evt.expiresAt;
        req.holdMs = Math.max(req.holdMs, evt.expiresAt - Date.now());
      }
      break;
    }
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
      pending.delete(evt.sessionId);
      hideQuestion();
      showActivity(evt.name, evt.activity); // "Working…"
      if (pending.size === 0 || ![...pending.values()].some((p) => !p.acknowledged)) {
        hideBubble();
      }
      break;
    case 'remove': {
      pending.delete(evt.sessionId);
      hideQuestion();
      clearActivity();
      if (pending.size === 0 || ![...pending.values()].some((p) => !p.acknowledged)) {
        hideBubble();
      }
      break;
    }
    case 'info':
      // "Now watching …" — say hello.
      if (!evt.sticky) {
        greetingUntil = Date.now() + 2600;
        refreshPose();
        setTimeout(refreshPose, 2700);
      }
      if (!activeRequestId) {
        showBubble(evt.message, { fix: evt.fix });
        // Something you have to act on stays until you dismiss it; ordinary
        // chatter gets out of the way on its own.
        if (!evt.sticky) {
          setTimeout(() => {
            if (!activeRequestId && ![...pending.values()].some((p) => !p.acknowledged)) {
              hideBubble();
            }
          }, 4000);
        }
      }
      break;
  }
  render();
}

window.clippyAPI.onEvent(handleEvent);

/* ---------- Context pressure: a full window is worth worrying about ---------- */

// Past this much of the context window used, the buddy starts to look stressed.
// It's the number you'd want to notice before Claude starts forgetting things.
const CONTEXT_STRESS = 0.3;
const CONTEXT_POLL_MS = 60 * 1000;

async function checkContext() {
  let data = null;
  try {
    data = await window.clippyAPI.usage();
  } catch {
    return; // no transcript yet, or main is busy — try again next time
  }
  const session = data && data.session;
  const tight = Boolean(
    session && session.turns > 0 && session.context / session.contextLimit > CONTEXT_STRESS
  );
  if (tight === contextTight) return;
  contextTight = tight;
  refreshPose();
}

setInterval(checkContext, CONTEXT_POLL_MS);
checkContext();

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

btnAllow.addEventListener('click', () => decide('allow', cardInput.value.trim()));
btnDeny.addEventListener('click', () => decide('deny', cardInput.value.trim()));
// Hand this one back to the terminal — and take the user there, since that's
// where the prompt (or the question picker) is about to appear.
btnPass.addEventListener('click', () => {
  decide('pass');
  // …and once we're there, walk down and point at the line to answer on.
  if (canOpen) window.clippyAPI.openWindow({ point: true });
});
btnGood.addEventListener('click', () => decide('ok'));
btnFeedback.addEventListener('click', () => {
  const msg = cardInput.value.trim();
  if (msg) decide('feedback', msg);
});
btnSubmit.addEventListener('click', () => {
  if (answersComplete()) decide('answer', JSON.stringify(answerState));
});
btnDismiss.addEventListener('click', () => decide('dismiss'));

document.getElementById('drive-send').addEventListener('click', sendDrivePrompt);
document.getElementById('drive-stop').addEventListener('click', () => window.clippyAPI.driveStop());
driveInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendDrivePrompt();
});

function sendDrivePrompt() {
  const text = driveInput.value.trim();
  if (!text) return;
  window.clippyAPI.drivePrompt(text);
  driveInput.value = '';
}

// Typing a reason takes time — keep asking main to hold the hook a bit longer.
cardInput.addEventListener('input', () => {
  btnFeedback.disabled = !cardInput.value.trim();
  const now = Date.now();
  if (activeRequestId && now - lastExtendAt > EXTEND_THROTTLE_MS) {
    lastExtendAt = now;
    window.clippyAPI.extend(activeRequestId);
  }
});

// "I'll answer in the terminal" — put the card away and show them where.
document.getElementById('btn-qok').addEventListener('click', () => {
  hideQuestion();
  if (canOpen) window.clippyAPI.pointAtPrompt();
});
// Same question, other screen: raise the terminal where the picker is waiting,
// then stand on the prompt.
btnQgoto.addEventListener('click', () => window.clippyAPI.openWindow({ point: true }));

btnFix.addEventListener('click', () => {
  if (bubbleFix) window.clippyAPI.fix(bubbleFix);
});

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

// Raise this session's terminal window; Clippy rides along on its top-right
// corner until you hide it or send it back to its own corner.
btnOpen.addEventListener('click', () => window.clippyAPI.openWindow());
// Same thing from a card: "this needs you — take me to that terminal".
btnGoto.addEventListener('click', () => window.clippyAPI.openWindow());

document.getElementById('btn-usage-close').addEventListener('click', hideUsage);

/* ---------- Talking back: the composer at the foot of the panel ---------- */

function sendPrompt() {
  const text = usageInput.value.trim();
  if (!text) return;
  window.clippyAPI.sendPrompt(text);
  usageInput.value = '';
  hideUsage();
  // The visible confirmation is the terminal raising and the text appearing
  // on its own prompt line — a cheer here bridges the half-second gap.
  pettedUntil = Date.now() + 1200;
  refreshPose();
  setTimeout(refreshPose, 1300);
}

usageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
  if (e.key === 'Escape') hideUsage();
});
document.getElementById('btn-usage-send').addEventListener('click', sendPrompt);

/**
 * What a plain click should just do, no menu in the way: a message you haven't
 * seen yet wins (it's why the buddy is bouncing), otherwise the one panel that
 * answers "how is this session doing, and what now?" opens — status, spend and
 * a box to type the next prompt into. Everything else is a right-click away.
 */
const CLICK_ACK_MS = 900;
function primaryAction() {
  // A quick wave so the click reads as "got it, on it" even though the real
  // feedback — the composer, the bubble reopening — takes a beat.
  clickedUntil = Date.now() + CLICK_ACK_MS;
  refreshPose();
  setTimeout(refreshPose, CLICK_ACK_MS + 50);

  const next = [...pending.values()].find((p) => !p.acknowledged);
  if (next) {
    nudge(next);
    return;
  }
  showUsage();
}

// Click Clippy: straight to the useful thing, not a menu you have to read
// first. `e.detail` is the browser's own click count for this burst of clicks
// on the same element — skipping anything past the first lets a double-click
// go straight to dblclick below instead of also firing the primary action.
clippyEl.addEventListener('click', (e) => {
  if (activeRequestId) return; // the card is already the main attraction
  if (e.detail > 1) return;
  primaryAction();
});

// Right-click is the one way in to everything else — settings, hide, unperch.
clippyEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!activeRequestId) toggleMenu();
});

// Double-click: not a session action, just Clippy being glad you're there —
// a beat of `cheer` and back to whatever pose the session actually calls for.
const PET_MS = 1000;
clippyEl.addEventListener('dblclick', () => {
  if (activeRequestId) return; // don't upstage a card that needs an answer
  closeMenu();
  pettedUntil = Date.now() + PET_MS;
  refreshPose();
  setTimeout(refreshPose, PET_MS + 50);
});

// A click anywhere else puts the menu away, like any other popup.
document.addEventListener('click', (e) => {
  if (!menuOpen()) return;
  if (menuEl.contains(e.target) || clippyEl.contains(e.target)) return;
  closeMenu();
});

// Clicking a different window entirely (the terminal, another app) never
// reaches the listener above — it's a separate native window and no DOM click
// happens here at all. Losing focus is the one signal that covers that case.
window.addEventListener('blur', closeMenu);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenu();
    hideUsage();
  }
});

menuWaiting.addEventListener('click', () => {
  closeMenu();
  const next = [...pending.values()].find((p) => !p.acknowledged);
  if (next) nudge(next);
});

document.getElementById('menu-settings').addEventListener('click', () => {
  closeMenu();
  window.clippyAPI.openSettings();
});

document.getElementById('menu-stats').addEventListener('click', () => {
  closeMenu();
  if (usageEl.classList.contains('hidden')) showUsage();
  else hideUsage();
});

document.getElementById('menu-hide').addEventListener('click', () => {
  closeMenu();
  window.clippyAPI.hide();
});

applyIdentity();
applyCharacter();
render();
