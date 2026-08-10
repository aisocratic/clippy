'use strict';

const { setMarkdown } = window.ClippyMarkdown;

document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[data-clippy-external]');
  if (!link) return;
  event.preventDefault();
  window.clippyAPI.openExternal(link.href);
});

const REMIND_AFTER_MS = 90 * 1000; // re-bounce if a session is still ignored
const SNOOZE_MS = 5 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 1000;
const EXTEND_THROTTLE_MS = 5 * 1000; // while typing, ask main to extend the hold
const GHOST_GRACE_MS = 5 * 1000; // how long past its deadline a card may linger

/* ---------- Identity: this window watches exactly one session ---------- */

// Which harness this buddy watches (mirrors AGENTS in src/sessions.js —
// renderers run without node integration, so the map is repeated here).
const HARNESS_NAMES = { claude: 'Claude Code', codex: 'Codex', openclaw: 'OpenClaw' };

const params = new URLSearchParams(location.search);
const me = {
  name: params.get('name') || 'session',
  color: params.get('color') || '#9aa3ad',
  agent: HARNESS_NAMES[params.get('agent')] ? params.get('agent') : 'claude',
  pet: params.get('pet') || 'Buddy', // the RPG party-member name main dealt us
  model: '',
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
const cardMore = document.getElementById('btn-card-more');
const cardOptions = document.getElementById('card-options');
const cardInput = document.getElementById('card-input');
const countdownFill = document.getElementById('card-countdown-fill');
const countdownBar = document.getElementById('card-countdown');
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

const usageEl = document.getElementById('usage');
const usageStatus = document.getElementById('usage-status');
const usageRecap = document.getElementById('usage-recap');
const usageBarFill = document.getElementById('usage-bar-fill');
const usageContext = document.getElementById('usage-context');
const usageBars = document.getElementById('usage-bars');
const usageNote = document.getElementById('usage-note');
const usageInput = document.getElementById('usage-input');
const btnUsageSize = document.getElementById('btn-usage-size');

const petEl = document.getElementById('pet');
const petWho = document.getElementById('pet-who');
const petLog = document.getElementById('pet-log');
const petInput = document.getElementById('pet-input');

const stageEl = document.getElementById('stage');
const controlsEl = document.getElementById('controls');

const menuEl = document.getElementById('menu');
const menuName = document.getElementById('menu-name');
const menuStatus = document.getElementById('menu-status');
const menuWaiting = document.getElementById('menu-waiting');

const sheetEl = document.getElementById('buddy-sheet');
const vectorEl = document.getElementById('buddy-vector');
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
const whoPet = document.getElementById('who-pet');
const whoSub = document.getElementById('who-sub');
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
  characters: [{ id: 'clip', label: 'Clippy', perColour: true }],
  sizes: [{ id: 'medium', buddy: 96 }],
};
let lastExtendAt = 0;
let canOpen = false; // do we know which terminal window this session lives in?

/* ---------- Window size: a paperclip until there's something to read ---------- */

let modeSent = null;
let heightSent = 0;
let widthSent = 0;

// How wide the window has to be while a plan card is up: the plan panel
// (--plan-w in clippy.css) plus the same slack the normal window keeps around
// the normal panel. Every other card leaves the width alone (0 = default).
const PLAN_WIN_W = 510;

const PANELS = ['card', 'bubble', 'qcard', 'usage', 'pet', 'drive', 'menu'];

// When we last asked main for a different window, and how long afterwards a
// mouseleave is treated as the layout moving rather than the pointer.
let resizedAt = 0;
const RESIZE_SETTLE_MS = 400;

/**
 * How tall the window has to be for everything on the stage to fit. Measured
 * rather than guessed: a one-line approval and a 40-line plan are very
 * different windows, and the fixed size used to cut the taller one off.
 */
function contentHeight() {
  const style = getComputedStyle(stageEl);
  let h = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  for (const el of stageEl.children) {
    if (el.classList.contains('hidden')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    h += el.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
  }
  // Slack for what layout does not measure: the panel's offset shadow falls
  // 5px below it, and while he's perched the bottom panel is the last thing in
  // the window, with no padding under it to fall into.
  return Math.ceil(h) + 10;
}

/**
 * Clippy's window is only as big as it needs to be. Main owns the geometry, so
 * the renderer just says which of the two sizes its current contents want, and
 * how tall the full one has to be.
 */
/* Panels that take the hide/chat row in when they open. The three left out —
   a held card, a question card, and the menu — are each already a set of
   actions waiting on you, so a second row underneath would be one more thing
   to read at the moment you can least afford it. While one of those is up the
   row simply steps aside. */
const CONTROL_HOSTS = ['usage', 'pet', 'bubble', 'drive'];

/**
 * Where hide/chat live right now.
 *
 * With nothing open they float above the buddy's head. A panel takes that space
 * the moment it opens, so the row moves *into* the panel and becomes its last
 * row rather than a pair of buttons hovering over the top of it.
 *
 * Called from syncMode before it measures, so the height main is given already
 * accounts for wherever the row ended up.
 */
function placeControls() {
  const open = (id) => !document.getElementById(id).classList.contains('hidden');
  const hostId = CONTROL_HOSTS.find(open);
  const host = hostId ? document.getElementById(hostId) : null;
  controlsEl.classList.toggle('inside', Boolean(host));
  // No host, but something else has the stage: stand down rather than float
  // over the top of a card.
  controlsEl.classList.toggle('hidden', !host && PANELS.some(open));
  const parent = host || stageEl;
  if (controlsEl.parentElement === parent) return;
  if (host) host.append(controlsEl);
  else stageEl.insertBefore(controlsEl, clippyEl);
}

function syncMode() {
  const showing = PANELS.some((id) => !document.getElementById(id).classList.contains('hidden'));
  const want = showing ? 'full' : 'compact';
  // Switch to the mode we're about to ask for *before* measuring. `compact`
  // decides what is on the stage at all — it hides every panel and shows the
  // ambient lines — so measuring while it still says "compact" reports the
  // height of the window we're leaving, not the one we want. Main sized to
  // that, echoed `dock` back, the class flipped, and the next render measured
  // properly and resized again: one click, two resizes, and a buddy that
  // visibly jumped. Main sends the same value straight back, so this only ever
  // moves the flip earlier.
  document.body.classList.toggle('compact', want === 'compact');
  placeControls();
  // Measure after layout has settled, so a card that just appeared is included.
  const height = want === 'full' ? contentHeight() : 0;
  // Only the plan card asks for extra width; 0 means "the usual".
  const width = want === 'full' && document.body.classList.contains('plan') ? PLAN_WIN_W : 0;
  if (want === modeSent && Math.abs(height - heightSent) < 6 && width === widthSent) return;
  modeSent = want;
  heightSent = height;
  widthSent = width;
  resizedAt = Date.now();
  window.clippyAPI.setMode(want, height, width);
}

/* ---------- UI helpers ---------- */

function applyIdentity() {
  const character = settings.characters.find((candidate) => candidate.id === settings.character);
  const buddyName = character?.label || 'Buddy';
  const harness = HARNESS_NAMES[me.agent] || HARNESS_NAMES.claude;
  const model = shortModel(me.model);
  // The pet's own name leads; under it, the folder this session is in and the
  // model spending in it. The model goes on in full — `gpt-5.6-sol`, not the
  // `claude-` stripped label the panels use — because on the plate it is the
  // only thing that says which model this session is actually costing you.
  whoPet.textContent = me.pet;
  whoSub.textContent = me.model ? `${me.name} · ${me.model}` : me.name;
  whoEl.title = `${me.pet} the ${buddyName}, on “${me.name}” — running ${harness} with ${model}`;
}

// Hook payloads identify the harness, while its transcript is the reliable
// source for the model. Refresh on activity so switching models during a long
// session eventually updates the plate, without re-reading the transcript for
// every noisy tool event.
let identityRefreshAt = 0;
let identityRefreshTimer = null;
async function refreshIdentity({ force = false } = {}) {
  const now = Date.now();
  const interval = me.model ? 30_000 : 2_000;
  if (!force && now - identityRefreshAt < interval) {
    clearTimeout(identityRefreshTimer);
    identityRefreshTimer = setTimeout(refreshIdentity, interval - (now - identityRefreshAt));
    return;
  }
  identityRefreshAt = now;
  let identity;
  try {
    identity = await window.clippyAPI.identity();
  } catch {
    return; // the window/app may be closing while the IPC request is in flight
  }
  if (!identity) return;
  if (identity.name) me.name = identity.name;
  if (identity.agent) me.agent = identity.agent;
  me.model = identity.model || '';
  applyIdentity();
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

/** The built-in SVG drawing name for the current character, if it has one. */
function currentVector() {
  const who = (settings.characters || []).find((c) => c.id === settings.character);
  return who && who.vector ? who.vector : null;
}

/* ---------- Which way the buddy is looking ----------

   Two halves. *Heading* is where he wants to look: the way he's being carried
   while you drag him, the way he's walking, and — with nothing else going on —
   inward, away from the edge he's parked against, because a buddy on the left
   of the screen looking further left has his back to everything you care about.
   Main watches the window and sends `side`; the rest is here.

   *Drawn* is which way the art already points, and turning a buddy around is
   only a mirror, so the two have to be compared before flipping anything. It is
   per character AND per animation: packs disagree with each other (one fox
   faces right, the next left) and with themselves (a sheet that runs to the
   left often sits facing the viewer). Art drawn 'center' looks straight out of
   the screen and is never mirrored — there is nothing to turn. */

let heading = null; // 'left' | 'right' — where he's actively looking, if anywhere
let side = 'right'; // which half of the screen he's parked on, per main

/** Which way the current character's current pose is drawn. */
function drawnFacing() {
  const who = (settings.characters || []).find((c) => c.id === settings.character);
  const perPose = who?.sheet?.poses?.[pose]?.facing;
  return perPose || who?.facing || 'right';
}

/** Where he looks when nothing is pulling him: inward, off the nearest edge. */
const restHeading = () => (side === 'left' ? 'right' : 'left');

/** Mirror the art, or don't, from the heading and the way the pose is drawn. */
function applyFacing() {
  const want = heading || restHeading();
  const drawn = drawnFacing();
  document.body.classList.toggle('flipped', drawn !== 'center' && want !== drawn);
}

/**
 * Point the buddy somewhere — 'left', 'right', or null to let him settle back
 * to facing into the screen.
 */
function face(want) {
  heading = want === 'left' || want === 'right' ? want : null;
  applyFacing();
}

/** Show a pose by name — `walk`, `point`, `excited`, `idle`… */
function setPose(name) {
  pose = poseFor(name);
  // A different animation can be drawn facing a different way, so the mirror is
  // reconsidered every time the pose changes, not only when he turns.
  applyFacing();
  const vector = currentVector();
  if (vector) {
    const art = window.ClippyVectors.create(vector, pose, me.color);
    if (art) vectorEl.replaceChildren(art);
    return;
  }
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
  const vector = currentVector();
  buddyEl.classList.toggle('hidden', Boolean(sheet || vector));
  sheetEl.classList.toggle('hidden', !sheet);
  vectorEl.classList.toggle('hidden', !vector);
  if (!sheet) stopSheet();
  if (!vector) vectorEl.replaceChildren();
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
  setMarkdown(bubbleText, text);
  bubbleFix = fix;
  btnFix.classList.toggle('hidden', !fix);
  usageEl.classList.add('hidden'); // news wins over the token panel
  petEl.classList.add('hidden');
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
  // One thing above the buddy's head at a time: the menu replaces whatever
  // panel was up, instead of stacking under it and shoving it around.
  usageEl.classList.add('hidden');
  petEl.classList.add('hidden');
  bubbleEl.classList.add('hidden');
  syncMenuItems();
  menuEl.classList.remove('hidden');
  syncMode();
}

function closeMenu() {
  parkedPanel = null; // an explicit close is not a parking — nothing comes back
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

  // Every route to the terminal window needs to know we can find it.
  btnGoto.classList.toggle('hidden', !canOpen);
  btnQgoto.classList.toggle('hidden', !canOpen);

  // Perching, a terminal we can find, a message waiting: all of it can change
  // while the menu is on screen.
  if (menuOpen()) syncMenuItems();
  // The combined panel is meant to be left open while the agent works, so its
  // status lines follow the session rather than freezing at whatever they said
  // when the panel opened.
  if (!usageEl.classList.contains('hidden')) syncUsageStatus();

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

// What Claude said as its last turn ended, from the usage payload — the
// summary card's "doing right now" line falls back to it between turns.
let latestRecap = '';

/**
 * The summary card's two lines, kept live while the panel is open: the state
 * in plain words (running / paused / waiting on you), then what the agent is
 * doing right now. The words are ClippySummary's (summary.js), so the tests
 * can hold them still.
 */
function syncUsageStatus() {
  usageStatus.textContent = ClippySummary.summaryState(myStatus);
  const recap = ClippySummary.summaryRecap({
    status: myStatus,
    activity: latestActivity,
    recap: latestRecap,
  });
  usageRecap.textContent = recap;
  usageRecap.classList.toggle('hidden', !recap);
}

/* ---------- Read-only question card (AskUserQuestion surfacing) ---------- */

function showQuestion(evt) {
  qcardTitle.textContent = evt.title || 'Claude is asking you a question';
  setMarkdown(qcardDetail, evt.detail || '');
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
 * Clippy measures spend, and only `/usage` (read from Claude Code's own cache,
 * shown above these bars whenever it exists) knows the allowance — so there is
 * nothing local to be a percentage *of*. Each bar is this window's share of
 * the week and the row says that is what it is — except for the week itself,
 * which is that share's denominator and so gets no bar rather than one pinned
 * full of itself.
 */
function windowBar(row, win, weekTotal, now, agent = 'claude') {
  const spent = allTokens(win.totals);
  const sub = covers(win, now);
  // The star is the old panel's: this total is a floor, and the row says why.
  const label = win.truncated ? `${row.label} *` : row.label;
  const capped = win.truncated
    ? ' Some older transcripts were skipped to keep this quick, so the total is a floor.'
    : '';
  const clock = agent === 'codex'
    ? ' The grey line is where the spend Clippy can see begins, not an account-limit reset.'
    : ' The grey line is where the spend Clippy can see begins, not a reset: run /usage in Claude ' +
      'Code for the block the server keeps.';

  // Every other row is drawn as a share of the week, which leaves the week with
  // nothing to be a share of but itself.
  const yardstick = row.key === 'week';
  return bar(label, fmtTokens(spent), yardstick ? null : weekTotal > 0 ? spent / weekTotal : 0, {
    sub: yardstick ? 'the week the other two are shares of' : sub,
    tone: 'share',
    hint: yardstick
      ? `${row.what}. Clippy measures spend, so this total is all the other bars have to be a ` +
        `share of — and nothing is left to draw it against, which is why it has no bar.` +
        `${clock}${capped}`
      : `${row.what}. The bar is this window's share of the last 7 days — spend, not what's ` +
        `left.${clock}${capped}`,
  });
}

// Whether the panel is grown into the full view. A fresh open always starts
// at the collapsed summary; growing it is a choice you make each visit — but a
// parked panel comes back as you left it.
let usageExpanded = false;

function applyUsageExpansion() {
  usageEl.classList.toggle('collapsed', !usageExpanded);
  // The same button both ways, pointing the way the panel will move: the
  // ordinary disclosure chevron, down to open it and up to fold it back.
  btnUsageSize.textContent = usageExpanded ? '▴' : '▾';
  btnUsageSize.title = usageExpanded
    ? 'Back to the summary'
    : 'Show more: the allowance bars, and a box to talk to this agent';
}

/**
 * The one panel a left click opens — collapsed to a status summary first: the
 * session's state, what the agent is doing right now, the model, and how full
 * the context is. The ▾ button grows the same window into the full view (the
 * allowance bars and a box to say the next thing) and ▴ folds it back — one
 * panel either way.
 *
 * Every open starts at the collapsed summary, including one coming back from
 * having stepped aside — see parkPanels.
 */
async function showUsage() {
  const data = await window.clippyAPI.usage();
  if (!data) return;
  const { session, windows } = data;
  const now = data.now || Date.now();

  // The panel, the pet and a speech bubble all want the space above his head.
  bubbleEl.classList.add('hidden');
  petEl.classList.add('hidden');
  qcardEl.classList.add('hidden');
  menuEl.classList.add('hidden');

  usageExpanded = false;
  applyUsageExpansion();

  latestRecap = data.recap || '';
  if (session?.model && session.model !== me.model) {
    me.model = session.model;
    applyIdentity();
  }
  syncUsageStatus();

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

  if (data.official && data.official.limits && data.official.limits.length) {
    renderOfficialBars(data.official, now);
  } else {
    renderMeasuredBars(data, windows, week, weekTotal, now);
  }

  usageEl.classList.remove('hidden');
  syncMode();
  // The full view is also where you type the next prompt, so the caret starts
  // there — but only once it's on screen; the collapsed summary has no box.
  // preventScroll, always: a window clamped shorter than its contents will
  // happily scroll the composer into view and take the buddy off the top of
  // his own window with it.
  if (usageExpanded) usageInput.focus({ preventScroll: true });
}

/**
 * The real thing, kept simple: what's LEFT of each limit, straight from
 * Claude Code's own cached /usage numbers. The 5-hour block is the near-term
 * row, the week rows carry the total and whichever model the plan counts on
 * its own. Nothing else — this is a glance, not a report.
 */
function renderOfficialBars(official, now) {
  const age = now - (official.fetchedAtMs || 0);
  const fetched = official.fetchedAtMs ? clockOf(official.fetchedAtMs, now) : 'some time ago';
  for (const limit of official.limits) {
    const left = Math.max(0, 100 - limit.percent);
    const resets = limit.resetsAt ? `resets ${clockOf(limit.resetsAt, now)}` : '';
    usageBars.append(
      bar(limit.label, `${left}% left`, Math.min(1, limit.percent / 100), {
        sub: resets,
        tone: limit.percent >= 85 || limit.severity !== 'normal' ? 'hot' : limit.percent >= 60 ? 'warn' : '',
        hint:
          `${limit.percent}% of this limit used — Claude Code's own number, cached when ` +
          `/usage last loaded (${fetched}).`,
      })
    );
  }
  usageNote.textContent =
    `From /usage, cached ${fetched}` +
    `${age > 6 * 60 * 60 * 1000 ? ' — getting stale: open /usage in any session to refresh' : ''}.`;
}

/**
 * The measured-spend fallback: per-window bars from the transcripts, then
 * where it went by model. The note must never fudge whose number the bars
 * are — measured spend, not an allowance.
 */
function renderMeasuredBars(data, windows, week, weekTotal, now) {
  const rows = data.agent === 'codex' ? WINDOWS.filter((row) => row.key !== 'weekOpus') : WINDOWS;
  for (const row of rows) {
    const win = windows && windows[row.key];
    if (!win) continue;
    usageBars.append(windowBar(row, win, weekTotal, now, data.agent));
  }

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

  usageNote.textContent = data.agent === 'codex'
    ? 'Measured from local Codex rollout transcripts. These are token totals, not your remaining account allowance.'
    : 'Bars are shares of the last 7 days — measured spend, not an allowance. Run /usage in ' +
      'Claude Code once and Clippy picks up the real percentages it caches, no setup needed.';
}

function hideUsage() {
  parkedPanel = null; // an explicit close is not a parking — nothing comes back
  usageExpanded = false; // the next open starts at the summary again
  usageEl.classList.add('hidden');
  syncMode();
}

// Same window, grown or shrunk — the bars and the composer were rendered when
// the panel opened, so this only reveals or hides them and asks main for the
// window that fits. Never a second panel.
btnUsageSize.addEventListener('click', () => {
  usageExpanded = !usageExpanded;
  applyUsageExpansion();
  syncMode();
  if (usageExpanded) usageInput.focus({ preventScroll: true });
});

/* ---------- Talking to the pet ----------
   The 💬 button under the buddy. Everything else in this window talks to the
   coding session; this talks to the animal sitting on top of it, and main
   keeps the two apart (src/pet-chat.js). */

let petThinking = false;

function petLine(text, cls = '') {
  const el = document.createElement('div');
  el.className = `pet-line${cls ? ` ${cls}` : ''}`;
  el.textContent = text;
  petLog.append(el);
  petLog.scrollTop = petLog.scrollHeight;
  return el;
}

function showPet() {
  // The panel and everything else want the same space above the buddy's head.
  usageEl.classList.add('hidden');
  bubbleEl.classList.add('hidden');
  qcardEl.classList.add('hidden');
  menuEl.classList.add('hidden');
  petWho.textContent = `${me.pet} · ${me.name}`;
  if (!petLog.children.length) {
    petLine(`${me.pet} is listening. (This never reaches the session.)`, 'waiting');
  }
  petEl.classList.remove('hidden');
  syncMode();
  petInput.focus({ preventScroll: true });
}

function hidePet() {
  parkedPanel = null;
  petEl.classList.add('hidden');
  syncMode();
}

function togglePet() {
  if (petEl.classList.contains('hidden')) showPet();
  else hidePet();
}

async function sayToPet() {
  const text = petInput.value.trim();
  if (!text || petThinking) return;
  petThinking = true;
  petInput.value = '';
  petEl.classList.remove('composing');
  petLine(text, 'mine');
  const thinking = petLine('…', 'waiting');
  syncMode();
  // He perks up while he's thinking of something to say back.
  pettedUntil = Date.now() + 1200;
  refreshPose();
  setTimeout(refreshPose, 1300);

  let reply = null;
  try {
    reply = await window.clippyAPI.petSay(text);
  } catch (err) {
    reply = { error: String((err && err.message) || err) };
  }
  thinking.remove();
  if (reply && reply.text) petLine(reply.text);
  else petLine((reply && reply.error) || 'no answer', 'failed');
  syncMode();
  petThinking = false;
}

petInput.addEventListener('input', () => syncComposing(petInput, petEl));

petInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sayToPet();
  }
  if (e.key === 'Escape') hidePet();
});

document.getElementById('pet-close').addEventListener('click', hidePet);
document.getElementById('btn-chat').addEventListener('click', (e) => {
  e.stopPropagation(); // the buddy's own click would open the status panel
  togglePet();
});

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
  const prefix = role === 'user' ? 'you:' : role === 'system' ? '' : 'claude:';
  if (prefix) {
    const label = document.createElement('span');
    label.className = 'drive-role';
    label.textContent = prefix;
    line.appendChild(label);
  }
  const copy = document.createElement('div');
  copy.className = 'drive-copy markdown';
  setMarkdown(copy, text);
  line.appendChild(copy);
  driveTranscript.appendChild(line);
  driveTranscript.scrollTop = driveTranscript.scrollHeight;
}

/* ---------- Interactive cards (approvals & reviews) ---------- */

function showNextRequest() {
  const next = requests.values().next().value;
  if (!next) {
    activeRequestId = null;
    cardEl.classList.add('hidden');
    document.body.classList.remove('plan'); // the wide window goes with the plan card
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
  petEl.classList.add('hidden');
  menuEl.classList.add('hidden');

  // Every card starts folded, however the last one was left.
  cardEl.classList.remove('reading');
  cardDetail.style.maxHeight = '';
  cardMore.classList.add('hidden');

  const isApproval = next.type === 'approval';
  const isAnswer = next.type === 'answer';
  const isPlan = next.variant === 'plan';
  // A plan is a page, not a blurb: the card grows (clippy.css) and syncMode
  // asks main for a window wide and tall enough to read it in.
  document.body.classList.toggle('plan', isPlan);
  showQueueDepth();
  cardTitle.textContent = next.title;

  // Answerable multiple-choice question — option buttons. The answer is fed
  // straight back to the agent (Claude: updatedInput.answers; Codex: the
  // consumed request_user_input result), so the terminal picker never appears.
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
  // The review card leads with its two actions; the feedback box only appears
  // once "Send feedback" is clicked. Approvals keep the always-there box — the
  // note rides along with whichever button you press.
  cardInput.classList.toggle('hidden', !isApproval);
  btnSubmit.classList.add('hidden');
  btnDismiss.classList.add('hidden');

  setMarkdown(cardDetail, next.detail || '');
  cardDetail.classList.toggle('hidden', !next.detail);
  offerTheRest(next);
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
  // On a review card the first click on "Send feedback" opens the box, so the
  // button starts enabled; once the box is open it disables until there's text.
  btnFeedback.disabled = false;

  cardEl.classList.remove('hidden');
  syncMode();
  setExcited(true);
}

/**
 * "read all" is offered only when there really is more of the message than the
 * card is showing, which happens two ways: main cut it before sending (a plan
 * past 4000 characters, a sign-off past 600), or it arrived whole and doesn't
 * fit the box. The second one has to be measured — the text is whatever the
 * agent wrote, and the box is a fixed 190px.
 */
function offerTheRest(req) {
  const boxed =
    !cardDetail.classList.contains('hidden') &&
    cardDetail.scrollHeight > cardDetail.clientHeight + 2;
  cardMore.classList.toggle('hidden', !(req.truncated || boxed));
}

cardMore.addEventListener('click', async () => {
  const req = requests.get(activeRequestId);
  // Only the cut ones need a round trip; the rest are already here in full and
  // just need the room.
  if (req && req.truncated) {
    cardMore.disabled = true;
    cardMore.textContent = 'reading…';
    const whole = await window.clippyAPI.cardFull(req.id);
    cardMore.disabled = false;
    cardMore.textContent = 'read all';
    if (whole) {
      req.detail = whole;
      req.truncated = false;
      setMarkdown(cardDetail, whole);
      cardDetail.classList.remove('hidden');
    }
  }
  cardMore.classList.add('hidden');
  cardEl.classList.add('reading');
  // Unfolded, the card can want more window than the screen has, and a window
  // clamped shorter than its contents loses the *top* of them — the title and
  // the queue go off-screen and you're left reading the middle of a message.
  // So the box only grows into the room that is actually there: everything
  // else on the stage, measured, subtracted from the screen.
  const rest = contentHeight() - cardDetail.clientHeight;
  const room = Math.max(120, (window.screen?.availHeight || 900) - rest - 24);
  if (room < cardDetail.clientHeight) cardDetail.style.maxHeight = `${room}px`;
  syncMode(); // the window grows to whatever the unfolded card now needs
});

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
    // Deadline-less cards (reviews) sit for as long as the user does.
    if (req.expiresAt && now - req.expiresAt > GHOST_GRACE_MS) {
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
  countdownBar.classList.toggle('hidden', !req.expiresAt);
  if (!req.expiresAt) return;
  const left = Math.max(0, req.expiresAt - now);
  countdownFill.style.width = `${Math.min(100, (left / req.holdMs) * 100)}%`;
}, 200);

/* ---------- Event handling from main process ---------- */

window.clippyAPI.onSettings((s) => {
  settings = s;
  applyCharacter();
  applyIdentity();
  render();
});

window.clippyAPI.onIdentity((id) => {
  Object.assign(me, id);
  applyIdentity();
});

function handleEvent(evt) {
  if (evt.status) myStatus = evt.status;
  if (evt.agent && evt.agent !== me.agent) {
    me.agent = evt.agent;
    applyIdentity();
  }
  // The workbench's private pose event describes artwork, not a session. Older
  // benches put that pose in `name`, so explicitly keep it away from identity.
  if (evt.kind !== 'pose' && evt.name && evt.name !== me.name) {
    me.name = evt.name;
    applyIdentity();
  }
  refreshIdentity();

  switch (evt.kind) {
    case 'approval':
    case 'review': {
      // A review card carries no deadline (expiresAt 0): the hook was already
      // answered, so the card can wait for as long as the user does.
      requests.set(evt.requestId, {
        id: evt.requestId,
        type: evt.kind,
        variant: evt.variant || 'tool',
        noPass: !!evt.noPass,
        name: evt.name,
        title: evt.kind === 'approval' ? evt.title : evt.message,
        detail: evt.detail || '',
        // Main kept the rest of it; "read all" comes and gets it.
        truncated: !!evt.truncated,
        expiresAt: evt.expiresAt || 0,
        holdMs: evt.expiresAt ? Math.max(1, evt.expiresAt - Date.now()) : 1,
      });
      if (!activeRequestId) showNextRequest();
      else showQueueDepth(); // another one queued behind the open card
      break;
    }
    case 'answer': {
      // An answerable multiple-choice question (option buttons). Comes from
      // Claude's AskUserQuestion, Codex's request_user_input, or Drive mode.
      const expiresAt = evt.expiresAt || Date.now() + 300000;
      requests.set(evt.requestId, {
        id: evt.requestId,
        type: 'answer',
        noPass: !!evt.noPass,
        name: evt.name,
        title: evt.title || `${evt.agentName || 'The agent'} is asking you`,
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
      document.body.classList.toggle('docked', Boolean(evt.docked));
      // Compact is about size, not about being perched — a corner buddy is a
      // bare paperclip too until it has something to show.
      document.body.classList.toggle('compact', Boolean(evt.compact));
      // Clicking a compact buddy opens the panel before main has grown the
      // window, and a display:none textarea can't take the caret — so the
      // composer claims it here, once the panel is actually on screen (and
      // only in the expanded view, where the composer exists).
      if (!evt.compact && usageExpanded && !usageEl.classList.contains('hidden')) {
        usageInput.focus({ preventScroll: true });
      }
      break;
    }
    case 'pose': {
      // A dev hook: the test bench uses it to look at one animation. Nothing in
      // the app sends this — the buddy picks its own pose from what it knows.
      setPose(evt.pose || evt.name || 'idle');
      return; // render() would immediately replace this forced pose from state
    }
    case 'side': {
      // Main saw the window cross the middle of its display: where he settles
      // when nothing else is pulling him has changed.
      side = evt.side === 'left' ? 'left' : 'right';
      applyFacing();
      break;
    }
    case 'walk': {
      // Main is stepping the window across the terminal; all we do is put him
      // in a walking pose, facing the way he's going.
      document.body.classList.add('walking');
      // A missing heading means "stand as you were drawn" — that's how the end
      // of a stroll puts him back to his usual stance.
      face(evt.facing === 'left' || evt.facing === 'right' ? evt.facing : null);
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
      // Surface-only fallback for disabled or malformed questions.
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
let contextCheckInFlight = false;

async function checkContext() {
  // Hidden buddy windows do not need to reread transcripts just to choose a
  // pose nobody can see. Visibility changes trigger a fresh check below, so a
  // buddy still has the right expression as soon as it appears.
  if (document.hidden || contextCheckInFlight) return;
  contextCheckInFlight = true;
  let data = null;
  try {
    // Context pressure only needs this session's latest transcript state. The
    // full usage call also aggregates a week of every session on the machine
    // and is reserved for the panel the user explicitly opens.
    data = await window.clippyAPI.context();
  } catch {
    return; // no transcript yet, or main is busy — try again next time
  } finally {
    contextCheckInFlight = false;
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
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkContext();
});
if (!document.hidden) checkContext();

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
// Two-step on the review card: the first click opens the feedback box (it is
// hidden until then), the second — once there's text — sends the note back to
// Claude through the same decide('feedback', …) wiring as before.
btnFeedback.addEventListener('click', () => {
  if (cardInput.classList.contains('hidden')) {
    cardInput.classList.remove('hidden');
    btnFeedback.disabled = true; // nothing typed yet
    syncMode(); // the card just got taller — the window follows
    cardInput.focus({ preventScroll: true });
    return;
  }
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
// A button that says "go to terminal" goes to the terminal and nothing else —
// the buddy keeps his spot. Walking him down to the prompt is what "Ask me in
// terminal" does, where handing the question back *is* the action.
btnQgoto.addEventListener('click', () => window.clippyAPI.openWindow());

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

// Raise this session's terminal window from a card: "this needs you — take me
// to that terminal". Clippy rides along on its top-right corner.
btnGoto.addEventListener('click', () => window.clippyAPI.openWindow());

document.getElementById('btn-usage-close').addEventListener('click', hideUsage);

/* ---------- Talking back: the composer at the foot of the panel ---------- */

/**
 * An empty composer is an invitation, not a form: one line tall, no Send
 * button. Both appear the moment there are words in it — and both change how
 * tall the panel is, so main is told either way.
 */
function syncComposing(el, box) {
  const composing = Boolean(el.value.trim());
  if (composing === box.classList.contains('composing')) return;
  box.classList.toggle('composing', composing);
  syncMode();
}

function sendPrompt() {
  const text = usageInput.value.trim();
  if (!text) return;
  window.clippyAPI.sendPrompt(text);
  usageInput.value = '';
  usageEl.classList.remove('composing');
  hideUsage();
  // The visible confirmation is the terminal raising and the text appearing
  // on its own prompt line — a cheer here bridges the half-second gap.
  pettedUntil = Date.now() + 1200;
  refreshPose();
  setTimeout(refreshPose, 1300);
}

usageInput.addEventListener('input', () => syncComposing(usageInput, usageEl));

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
 * seen yet wins (it's why the buddy is bouncing), otherwise the session's
 * status summary opens — "how is this session doing?", with ▾ for the
 * spend and a box to type the next prompt into. Everything else is a
 * right-click away.
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
  // A panel that stepped aside when you left comes back the way you left it —
  // on this click, never on a hover. Reopening it under a passing pointer
  // resizes the window out from under the cursor, and that resize fires the
  // very enter/leave pair that would park and unpark it again, and again.
  clearTimeout(parkTimer);
  parkTimer = null;
  const parked = parkedPanel;
  parkedPanel = null;
  if (parked === 'pet') {
    showPet();
    return;
  }
  showUsage();
}

/* ---------- Resting the pointer on him ----------
   Three seconds without moving on is a deliberate look, not a pointer passing
   through, so it opens exactly what a click opens. Anything shorter changes
   nothing: opening a panel resizes the window under the cursor, and doing that
   to someone who was only on their way somewhere is the flicker that parking
   exists to avoid. */
const DWELL_MS = 3000;
let dwellTimer = null;

function cancelDwell() {
  clearTimeout(dwellTimer);
  dwellTimer = null;
}

function anyPanelOpen() {
  return PANELS.some((id) => !document.getElementById(id).classList.contains('hidden'));
}

clippyEl.addEventListener('mouseenter', () => {
  cancelDwell();
  dwellTimer = setTimeout(() => {
    dwellTimer = null;
    // Not while he's being carried, not over a card that wants an answer, and
    // never on top of something already open.
    if (dragFrom || activeRequestId || anyPanelOpen()) return;
    primaryAction();
  }, DWELL_MS);
});

clippyEl.addEventListener('mouseleave', cancelDwell);

/* ---------- Dragging the buddy, by hand ----------
   #clippy is deliberately NOT an app-region drag handle: Electron never
   delivers left-clicks to drag regions, which made clicking the buddy dead.
   So the drag is ours: past a small threshold the window follows the mouse
   via IPC deltas, and a mouseup that ends a real drag swallows the click that
   the browser fires right after it. */
const DRAG_THRESHOLD_PX = 4;
let dragFrom = null; // {x, y} in screen coords while the button is down
let suppressClickUntil = 0;

clippyEl.addEventListener('mousedown', (e) => {
  cancelDwell(); // you've made your move; the slow way in isn't needed
  if (e.button !== 0) return;
  dragFrom = { x: e.screenX, y: e.screenY, moved: false };
});

let settleFacing = null; // puts him back to his usual stance after a carry

window.addEventListener('mousemove', (e) => {
  if (!dragFrom) return;
  const dx = e.screenX - dragFrom.x;
  const dy = e.screenY - dragFrom.y;
  if (!dragFrom.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return;
  dragFrom.moved = true;
  dragFrom.x = e.screenX;
  dragFrom.y = e.screenY;
  // Face the way he's being pulled, like the walk does — a couple of pixels of
  // sideways intent before flipping, so a shaky vertical carry doesn't flicker.
  if (Math.abs(dx) >= 2) face(dx < 0 ? 'left' : 'right');
  window.clippyAPI.moveBy(dx, dy);
});

window.addEventListener('mouseup', () => {
  if (dragFrom?.moved) {
    suppressClickUntil = Date.now() + 250;
    // He keeps looking the way he went for a beat, then settles back.
    clearTimeout(settleFacing);
    settleFacing = setTimeout(() => face(null), 500);
  }
  dragFrom = null;
});

// Click Clippy: straight to the useful thing, not a menu you have to read
// first. `e.detail` is the browser's own click count for this burst of clicks
// on the same element — skipping anything past the first lets a double-click
// go straight to dblclick below instead of also firing the primary action.
clippyEl.addEventListener('click', (e) => {
  if (Date.now() < suppressClickUntil) return; // that was a drag, not a click
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
/* ---------- Parking: the panel steps aside when you do ----------
   Move the mouse away (or click into another window) and whatever's open over
   the buddy's head — the info panel or the menu — hides. Clicking the buddy
   brings it back as it was; hovering deliberately does not, because opening a
   panel resizes the window under the pointer and the resize fires its own
   enter/leave events. Held cards are exempt: they're waiting on a decision and
   have countdowns, so they stay put no matter where the mouse goes. */
let parkedPanel = null; // 'usage' | 'menu' — what to bring back on re-enter
let parkTimer = null;

function parkPanels() {
  if (activeRequestId) return;
  // Mid-thought in either box — the composer or the pet — so stay put.
  if (usageInput.value.trim() || petInput.value.trim()) return;
  if (petThinking) return; // an answer is on its way; don't shut the door on it
  if (!usageEl.classList.contains('hidden')) {
    usageEl.classList.add('hidden');
    parkedPanel = 'usage';
    // Stepping aside folds it: you looked away, so the next look starts at the
    // summary rather than dropping you back into the bars and the composer.
    usageExpanded = false;
    applyUsageExpansion();
    syncMode();
  } else if (!petEl.classList.contains('hidden')) {
    petEl.classList.add('hidden');
    parkedPanel = 'pet';
    syncMode();
  } else if (menuOpen()) {
    menuEl.classList.add('hidden');
    parkedPanel = 'menu';
    syncMode();
  }
}

// A short fuse on leave, so skimming the window's edge doesn't flicker. There
// is no matching handler on enter: see primaryAction, which is where a parked
// panel comes back.
document.documentElement.addEventListener('mouseleave', () => {
  // Resizing the window slides the whole layout out from under a pointer that
  // never moved, and the browser reports that as a leave. Folding the panel did
  // exactly that — the buttons travelled, the "leave" landed, and 250ms later
  // the panel you had just folded put itself away. Our own resize is not you
  // walking off, so a leave in its wake is ignored.
  if (Date.now() - resizedAt < RESIZE_SETTLE_MS) return;
  clearTimeout(parkTimer);
  parkTimer = setTimeout(parkPanels, 250);
});
window.addEventListener('blur', parkPanels);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenu();
    hideUsage();
    hidePet();
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
refreshIdentity({ force: true });
