'use strict';

const { setMarkdown } = window.ClippyMarkdown;

document.addEventListener('click', (event) => {
  const link = event.target.closest?.('a[data-clippy-external]');
  if (!link) return;
  event.preventDefault();
  window.clippyAPI.openExternal(link.href);
});

const REMIND_AFTER_MS = 90 * 1000; // re-bounce if a session is still ignored
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
const cardPager = document.getElementById('card-pager');
const cardWhere = document.getElementById('card-where');
const cardTitle = document.getElementById('card-title');
const cardPromptRow = document.getElementById('card-prompt-row');
const cardPromptPreview = document.getElementById('card-prompt-preview');
const cardResponseLabel = document.getElementById('card-response-label');
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
const btnCardX = document.getElementById('btn-card-x');
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
const btnUsageSize = document.getElementById('btn-usage-size');

const feedEl = document.getElementById('feed');
const feedSrc = document.getElementById('feed-src');
const feedNote = document.getElementById('feed-note');
const feedLog = document.getElementById('feed-log');

const petEl = document.getElementById('pet');
const petWho = document.getElementById('pet-who');
const petLog = document.getElementById('pet-log');
const petTo = document.getElementById('pet-to');
const petInput = document.getElementById('pet-input');

const stageEl = document.getElementById('stage');
const controlsEl = document.getElementById('controls');

const menuEl = document.getElementById('menu');
const menuName = document.getElementById('menu-name');
const menuStatus = document.getElementById('menu-status');
const menuWaiting = document.getElementById('menu-waiting');
const menuFeed = document.getElementById('menu-feed');
// The two ways in to the same panel, revealed together whenever there turns
// out to be something to show. Held here because a busy session reaches for
// them on every transcript event.
const btnMessages = document.getElementById('btn-messages');
const menuSleep = document.getElementById('menu-sleep');
const menuSleepOptions = document.getElementById('menu-sleep-options');

const sheetEl = document.getElementById('buddy-sheet');
const vectorEl = document.getElementById('buddy-vector');
let sheetTimer = null;
let pose = 'idle'; // what the buddy is doing right now, by name
let pointing = false; // standing on a prompt
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
const deedsEl = document.getElementById('deeds');
const qcardEl = document.getElementById('qcard');
const qcardTitle = document.getElementById('qcard-title');
const qcardDetail = document.getElementById('qcard-detail');
const btnQgoto = document.getElementById('btn-qgoto');

// sessionId -> { message, urgency, name, lastNudge, snoozedUntil, acknowledged }
const pending = new Map();
// requestId -> { id, type: 'approval'|'review'|'answer'|'failure', name, title,
// detail, expiresAt, holdMs }
const requests = new Map();
let activeRequestId = null;
let myStatus = 'idle';
let sleepingUntil = 0;

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
  appearanceSound: 'pop',
  character: 'clip',
  size: 'medium',
  // Enough of a roster to paint the default buddy correctly on the very first
  // frame; main replaces all of it a moment later.
  characters: [{ id: 'clip', label: 'Clippy', perColour: true }],
  sizes: [{ id: 'medium', buddy: 96 }],
};
let lastExtendAt = 0;
let canOpen = false; // do we know which terminal window this session lives in?
// Where this session actually lives, as main resolved it: a terminal, an agent
// app (ChatGPT, Claude), or a tmux pane Clippy started. `goLabel` is the words
// on the button that takes you there — "go to terminal" is the wrong noun for
// two of those three, and that button is the one thing on a card that moves
// you somewhere.
let source = { kind: 'unknown', name: '', goLabel: 'go to terminal ↗' };

/* ---------- Window size: a paperclip until there's something to read ---------- */

let modeSent = null;
let heightSent = 0;
let widthSent = 0;

// How wide the window has to be while a plan card is up: the plan panel
// (--plan-w in clippy.css) plus the same slack the normal window keeps around
// the normal panel. Every other card leaves the width alone (0 = default).
/**
 * How much wider than its panel a window has to be.
 *
 * Everything drawn outside the panel's own box lives in this margin: the
 * offset shadow to its right, and the sheets stacked past its top-left corner
 * when several messages are waiting. It is the same figure main builds WIN_W
 * from (`--panel-w` + this), and the plan card needs it too — that one was
 * left on the old 10px total when WIN_W grew, so a plan's shadow and sheets
 * were drawn outside its window and simply cut off.
 */
const WIN_MARGIN = 42;

/** The plan card is a page, so its window is the wide panel plus that margin. */
const PLAN_WIN_W = 500 + WIN_MARGIN;

// Everything that can occupy the space above the buddy's head. Held as
// elements, not ids: syncMode runs on every event this window hears, and asks
// three separate questions of this list each time.
const PANELS = [cardEl, bubbleEl, qcardEl, usageEl, petEl, driveEl, feedEl, menuEl];

// When we last asked main for a different window, and how long afterwards a
// mouseleave is treated as the layout moving rather than the pointer.
let resizedAt = 0;
const RESIZE_SETTLE_MS = 400;

/**
 * How tall the window has to be for everything on the stage to fit. Measured
 * rather than guessed: a one-line approval and a 40-line plan are very
 * different windows, and the fixed size used to cut the taller one off.
 */
function contentHeight(panelShowing = true) {
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
  //
  // Only when there *is* a panel. With nothing but the buddy on the stage this
  // was ten pixels of nothing, and because the stage is bottom-aligned it sat
  // above his head — where, since macOS will not put a window above the menu
  // bar, it became ten pixels he could never be dragged into.
  return Math.ceil(h) + (panelShowing ? 10 : 0);
}

/**
 * Clippy's window is only as big as it needs to be. Main owns the geometry, so
 * the renderer just says which of the two sizes its current contents want, and
 * how tall the full one has to be.
 */
/* Panels that are themselves a decision waiting on you. While one of these is
   up the action bar steps aside — it would be one more thing to read at the
   moment you can least afford it. Everything else (stats, chat, the feed) is
   something you opened, and the bar stays available underneath. */
const DEMANDING = [cardEl, qcardEl, menuEl];

const isOpen = (el) => !el.classList.contains('hidden');

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
  // The bar lives under the buddy and stays there. It used to be re-parented
  // into whichever panel was open, so the same two buttons appeared in a
  // different place depending on what you had up — and while a card was
  // showing they vanished entirely.
  //
  // Under his feet, too, rather than over his head: floating above him the row
  // reserved 32px of stage even while invisible (it is opacity-0 until you
  // point at him), and since macOS will not put a window above the menu bar,
  // that was exactly how far short of the top he stopped when dragged up.
  if (controlsEl.parentElement !== stageEl) stageEl.insertBefore(controlsEl, whoEl);
  // A card or a question is a set of actions already waiting on an answer;
  // a second row underneath is one more thing to read at the worst moment.
  const demanding = DEMANDING.some(isOpen);
  controlsEl.classList.toggle('hidden', demanding);
  // Reading something you opened: keep the bar up without needing the pointer
  // on the buddy, since the pointer is on the panel.
  document.body.classList.toggle('reading', !demanding && PANELS.some(isOpen));
}

function syncMode() {
  // The target row sits above the chat panel rather than inside it, so it has
  // to be tied to it here: several panels take the chat's space by hiding it
  // directly, and each of them would otherwise leave a row of agent pills
  // floating over the buddy. One rule, in the place every panel change passes
  // through, rather than seven places remembering.
  if (petEl.classList.contains('hidden')) petTo.classList.add('hidden');

  const showing = PANELS.some(isOpen);
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
  // Compact is measured too: the window is otherwise a fixed box taller than
  // the buddy standing in it, and since the stage is bottom-aligned that slack
  // sits *above* him — invisible, but the first thing to hit the top of the
  // screen when you drag him up.
  const height = contentHeight(showing);
  // Only the plan card asks for extra width; 0 means "the usual".
  const width = want === 'full' && document.body.classList.contains('plan') ? PLAN_WIN_W : 0;
  if (want === modeSent && Math.abs(height - heightSent) < 6 && width === widthSent) return;
  modeSent = want;
  heightSent = height;
  widthSent = width;
  resizedAt = Date.now();
  window.clippyAPI.setMode(want, height, width, buddyAnchor());
}

/**
 * Where the buddy will stand inside the window we are about to ask for.
 *
 * Main keeps *this point* still on screen when it resizes, so opening a panel
 * grows the window around him instead of dragging him along with it. Before
 * this, a window anchored by its right edge grew 152px leftwards for a panel
 * and took the buddy 76px with it — he jumped out from under the pointer that
 * had just clicked him, which is most of why opening anything felt jumpy.
 *
 * Measured rather than assumed: he is horizontally centred, but what sits
 * under his feet (the name plate, the activity line) changes with the mode,
 * and the answer has to be right in both.
 *
 * @param {number} height  the window height being asked for, since the stage
 *   is bottom-aligned and the current window may still be the old size.
 */
function buddyAnchor() {
  const box = clippyEl.getBoundingClientRect();
  const stage = stageEl.getBoundingClientRect();
  // Both measurements are *relative*, because at this moment the window is
  // still the old size — the resize we are asking for has not happened yet.
  // An absolute centre measured here would describe the window we are leaving
  // and be exactly one resize out of date, which is the bug this replaced.
  //
  // `dx` is his offset from the middle (zero while the stage centres him), and
  // `fromBottom` is how far his middle sits above the foot of the content. The
  // stage is bottom-aligned, so neither changes when the window grows — main
  // applies them to the size it actually settles on.
  return {
    dx: Math.round(box.left + box.width / 2 - (stage.left + stage.width / 2)),
    fromBottom: Math.round(stage.bottom - (box.top + box.height / 2)),
    // His own size, so main can keep *him* on screen rather than the window.
    // The window is a good deal taller than he is and the slack sits above his
    // head, so clamping the window is what stopped him reaching the top.
    halfW: Math.round(box.width / 2),
    halfH: Math.round(box.height / 2),
  };
}

/* ---------- UI helpers ---------- */

function applyIdentity() {
  const character = settings.characters.find((candidate) => candidate.id === settings.character);
  const buddyName = character?.label || 'Buddy';
  const harness = HARNESS_NAMES[me.agent] || HARNESS_NAMES.claude;
  const model = shortModel(me.model);
  const solo = document.body.classList.contains('solo');
  // The pet's own name leads; under it, the folder this session is in and the
  // model spending in it. The model goes on in full — `gpt-5.6-sol`, not the
  // `claude-` stripped label the panels use — because on the plate it is the
  // only thing that says which model this session is actually costing you.
  whoPet.textContent = me.pet;
  // A session Clippy started says so on the plate: ⧉ for one in tmux here, ⇅
  // for one on another machine. Both are "mine", which is worth knowing before
  // you wonder why it has no terminal window.
  const owned = me.owned ? (me.host ? `⇅ ${me.host} · ` : '⧉ ') : '';
  // The shared main buddy is a stable companion, not a session label: only
  // its own name belongs on its plate. A session buddy names itself, project,
  // and model so parallel agents remain distinguishable at a glance.
  whoSub.textContent = solo ? '' : owned + (me.model ? `${me.name} · ${me.model}` : me.name);
  const where = me.owned
    ? me.host
      ? ` in tmux over ${me.host}`
      : ` in tmux (${me.tmux || 'started by Clippy'})`
    : '';
  whoEl.title = solo
    ? `${me.pet} the ${buddyName}`
    : `${me.pet} the ${buddyName}, on “${me.name}”${where} — running ${harness} with ${model}`;
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

/** Enough of this buddy's current look to draw it in the review window. */
function readerBuddy() {
  const sheet = currentSheet();
  const vector = currentVector();
  return {
    kind: vector ? 'vector' : sheet ? 'sheet' : 'image',
    src: !vector && !sheet ? buddyArt(poseFor('excited')) : '',
    vector: vector || '',
    sheet: sheet || null,
    color: me.color,
    label: me.pet,
  };
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
/**
 * Being ignored for this long is the only thing worth sulking about.
 *
 * A tool failing is not: agents retry, and a buddy that pulls a face every
 * time a grep comes back empty is a buddy you stop looking at. Wanting your
 * attention is not either — that is what `excited` is for, and it is meant to
 * be inviting rather than cross.
 */
const SULK_AFTER_MS = 5 * 60 * 1000;

/** When the oldest thing still waiting on you turned up. 0 when nothing is. */
let waitingSince = 0;

function poseForState() {
  if (document.body.classList.contains('walking')) return 'walk';
  if (pettedUntil > Date.now()) return 'cheer'; // you just double-clicked him
  if (clickedUntil > Date.now()) return 'wave'; // you just clicked him once
  if (pointing) return 'point';
  if (greetingUntil > Date.now()) return 'wave';

  // Ignored for five minutes, or the context is about to run out and the
  // session is genuinely in trouble. Those two, and nothing else.
  const ignored = waitingSince > 0 && Date.now() - waitingSince > SULK_AFTER_MS;
  if (ignored || contextTight) return 'stress';

  // Something needs you: be interesting about it rather than cross.
  if (activeRequestId || currentUrgent()) return 'excited';
  if (myStatus === 'working') return 'think';
  if (myStatus === 'waiting') return 'sleep'; // finished — nothing left to do
  return 'idle';
}

/**
 * Start or stop the clock on being ignored.
 *
 * Started by the first thing that needs an answer and only cleared when the
 * last one is gone, so answering one of three does not buy another five
 * minutes of patience for the other two.
 */
function trackWaiting() {
  const anyWaiting = Boolean(activeRequestId) || currentUrgent() || requests.size > 0;
  if (!anyWaiting) waitingSince = 0;
  else if (!waitingSince) waitingSince = Date.now();
}

// The sulk threshold is a moment in time, and no event fires when it passes.
// Slow on purpose: this exists to notice five minutes going by, not to animate.
const SULK_CHECK_MS = 15 * 1000;
setInterval(() => {
  if (waitingSince) refreshPose();
}, SULK_CHECK_MS);

function refreshPose() {
  trackWaiting();
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
  // Escaped even though main vets sheet filenames: a quote would end the url().
  sheetEl.style.backgroundImage = `url("${CSS.escape(pose.file)}")`;
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
  armPanel(bubbleEl);
  showStack(); // before syncMode: the sheets need their room in the measurement
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
  const sleeping = sleepingUntil > Date.now();
  menuStatus.textContent = sleeping ? 'sleeping' : SHORT_STATUS[myStatus] || myStatus;
}

function openMenu() {
  // One thing above the buddy's head at a time: the menu replaces whatever
  // panel was up, instead of stacking under it and shoving it around.
  usageEl.classList.add('hidden');
  petEl.classList.add('hidden');
  bubbleEl.classList.add('hidden');
  menuSleepOptions.classList.add('hidden');
  menuSleep.querySelector('.caret').textContent = '›';
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

/**
 * How many messages are waiting on this buddy, counting the one on screen.
 *
 * Held cards and passive nudges together: with one buddy answering for every
 * agent they arrive from all of them, and "two things want you" is the same
 * fact whichever kind they are. The badge reads this combined total; the card
 * stack below deliberately does not, because it must only draw the cards that
 * are actually in that popup's queue.
 */
function waitingCount() {
  return [...pending.values()].filter((p) => !p.acknowledged).length + requests.size;
}

/**
 * Put the panel on screen on top of the ones behind it.
 *
 * Count the actual popup queue, not every unrelated nudge this shared buddy
 * has heard. One item is one sheet; two and three get exactly that many; a
 * larger queue stays at three sheets so it remains a readable stack.
 */
function showStack() {
  const setDepth = (el, count) => {
    const shown = Math.min(3, Math.max(1, count));
    el.classList.toggle('stacked', shown >= 2); // one sheet behind the front
    el.classList.toggle('deep', shown >= 3); // two sheets behind the front
  };
  // A decision card and a passive bubble are different queues. Do not make a
  // lone approval look like two cards just because another session has a
  // background "finished" nudge waiting.
  setDepth(cardEl, requests.size);
  setDepth(bubbleEl, [...pending.values()].filter((p) => !p.acknowledged).length);
}

/**
 * Name the place this session lives, everywhere it gets named.
 *
 * Four buttons lead to the same window and all four used to say "terminal".
 * For a session in the ChatGPT app or in Claude that is simply the wrong word,
 * and for one Clippy started in tmux there is no window to go to at all — you
 * attach one. Main works out which it is; this puts the word on the buttons.
 */
function applySource() {
  const go = source.goLabel || 'go to terminal ↗';
  // The card header has very little room. Its destination is explained by the
  // delayed tooltip; the control itself stays a stable, compact arrow.
  btnQgoto.textContent = go;
  const tip = source.name
    ? `Bring ${source.name} to the front`
    : "Bring this session's window to the front";
  btnGoto.dataset.tooltip = tip;
  btnGoto.setAttribute('aria-label', tip);
  btnQgoto.title = tip;
}

/**
 * How long a panel ignores clicks after appearing.
 *
 * Clippy pops up unannounced, over whatever you were doing, often directly
 * under the pointer — and a button that appears under a cursor mid-click
 * catches a click that was meant for something else entirely. On an approval
 * card the button nearest that corner is **Allow**, so the failure is not a
 * stray dismissal: it is silently approving a command nobody read. Caught in
 * testing as a real, trusted mousedown landing on Allow within a frame of the
 * card appearing.
 *
 * Long enough to outlast a click already in flight, short enough that nobody
 * deliberately reaching for a button ever notices it — they have to see the
 * card and move to it first, which is far longer than this.
 */
const ARM_MS = 450;
const armTimers = new WeakMap();

/**
 * Make a panel's buttons inert for a moment after it appears.
 *
 * Swallowing the click rather than disabling the buttons: `disabled` would grey
 * them out for a fifth of a second, which reads as a broken card, and would
 * fight the several places that set `disabled` for their own reasons.
 */
function armPanel(el) {
  if (!el) return;
  el.classList.add('arming');
  clearTimeout(armTimers.get(el));
  armTimers.set(
    el,
    setTimeout(() => el.classList.remove('arming'), ARM_MS)
  );
}

/** What to call the place a card came from, mid-sentence. */
const there = (req) => req?.source?.name || source.name || 'terminal';

/**
 * The button that hands a held question back instead of answering it here. It
 * names where the question would then be waiting — which is the whole point of
 * pressing it, and was "terminal" even when the answer was going to appear in
 * the ChatGPT app.
 */
function applyPassLabel(req, { move = false } = {}) {
  const where = there(req);
  btnPass.textContent = canOpen
    ? `${move ? 'Move to' : 'Ask me in'} ${where} ↗`
    : `Ask me in ${where}`;
}

/**
 * "billing-api · Claude · Ghostty" — who is asking, and from where.
 *
 * Built from the card's own source rather than the window's: one buddy answers
 * for every agent, so the window's idea of "where" belongs to whichever session
 * spoke last, not to the card being read.
 */
function paintWhere(req) {
  const line = [req?.name, req?.agentName, req?.source?.name].filter(Boolean).join(' · ');
  cardWhere.textContent = line;
  cardWhere.style.setProperty('--card-agent', req?.color || me.color);
  cardWhere.classList.toggle('hidden', !line);
}

function render() {
  const open = waitingCount();
  badgeEl.textContent = String(open);
  badgeEl.classList.toggle('hidden', open === 0);
  showStack();

  // This window speaks for one session only, so the status line is about it.
  statusEl.textContent = STATUS_TEXT[myStatus] || myStatus;

  // Every route to the terminal window needs to know we can find it.
  btnGoto.classList.toggle('hidden', !canOpen);
  btnQgoto.classList.toggle('hidden', !canOpen);
  applySource();

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
  const icon = !activity.ok ? '⚠' : activity.state === 'done' ? '✓' : '⚙';
  latestActivity = `${icon} ${activity.label}`;
  activityEl.textContent = `${icon} ${name} — ${activity.label}`;
  activityEl.classList.toggle('failed', !activity.ok);
  activityEl.classList.remove('hidden');
}

/* ---------- What the buddy has actually done ----------
   The activity line above says what is happening *right now* and forgets it
   the instant it changes, so looking away meant never finding out that Clippy
   allowed a command, handed a question back, or what the last turn ended with.
   These are the deeds themselves: kept in state (so a panel opening and
   closing does not lose them), capped, newest first. */

const DEEDS_KEPT = 50;
const DEEDS_PREVIEW = 2;
const deeds = [];

/** hh:mm — the day is never in question for something this recent. */
const deedClock = (at) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Record something the buddy did.
 *
 * `who` is the agent it was about — with one buddy answering for several, "I
 * allowed that" is meaningless without saying whose.
 */
function noteDeed(text, { who = '' } = {}) {
  if (!text) return;
  // Whose face the card wears, worked out now rather than at render time: the
  // roster moves, and a deed is a record of something that already happened.
  const mine = !who || who === me.name;
  const from = mine
    ? { character: settings.character, color: me.color, name: me.name }
    : petRoster.find((a) => a.name === who) || { name: who, color: me.color };
  deeds.unshift({ text, who, at: Date.now(), from });
  deeds.length = Math.min(deeds.length, DEEDS_KEPT);
  renderDeeds();
}

function renderDeeds() {
  deedsEl.replaceChildren();
  for (const deed of deeds.slice(0, DEEDS_PREVIEW)) {
    deedsEl.append(makeDeed(deed));
  }
  if (deeds.length > DEEDS_PREVIEW) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'deed-more';
    more.textContent = '...';
    more.title = `Show all ${deeds.length} activity log entries`;
    more.setAttribute('aria-label', `Show all ${deeds.length} activity log entries`);
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      openAllDeeds();
    });
    deedsEl.append(more);
  }
  deedsEl.classList.toggle('hidden', deeds.length === 0);
}

/** One activity chip. Click it to read the uncropped entry in its own window. */
function makeDeed(deed) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'deed';
  card.title = 'Open full activity entry';
  card.setAttribute('aria-label', `Open activity: ${deed.text}`);
  card.addEventListener('click', (event) => {
    event.stopPropagation();
    openDeed(deed);
  });

  const face = document.createElement('span');
  face.className = 'deed-face';
  face.style.setProperty('--clip', deed.from.color || me.color);
  face.append(faceOf(deed.from));

  const body = document.createElement('div');
  body.className = 'deed-body';
  const what = document.createElement('span');
  what.className = 'deed-what';
  what.textContent = deed.text;
  // One buddy can be answering for several agents, so the card names the
  // session — except when it is the one the plate underneath already names.
  const meta = document.createElement('span');
  meta.className = 'deed-meta';
  meta.textContent = [deed.who && deed.who !== me.name ? deed.who : '', deedClock(deed.at)]
    .filter(Boolean)
    .join(' · ');
  body.append(what, meta);

  card.append(face, body);
  return card;
}

function openDeed(deed) {
  const label = [deed.who && deed.who !== me.name ? deed.who : me.name, deedClock(deed.at)]
    .filter(Boolean)
    .join(' · ');
  window.clippyAPI.openActivityReader(label || 'Activity log', deed.text);
}

function openAllDeeds() {
  const text = deeds
    .map((deed) => {
      const label = [deed.who && deed.who !== me.name ? deed.who : me.name, deedClock(deed.at)]
        .filter(Boolean)
        .join(' · ');
      return `## ${label}\n\n${deed.text}`;
    })
    .join('\n\n---\n\n');
  window.clippyAPI.openActivityReader('Activity log', text);
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
  armPanel(qcardEl);
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
    // What's left is the number you act on, so it leads — and it is the one
    // thing in this panel worth reading at a glance, so it is set big enough
    // to be read at a glance. The rest is the working underneath it.
    usageContext.replaceChildren();
    const strong = document.createElement('b');
    strong.textContent = `${fmtTokens(left)} left`;
    const rest = document.createElement('span');
    rest.className = 'ctx-rest';
    rest.textContent = `${fmtTokens(session.context)} used of ${fmtTokens(session.contextLimit)} · ${pct}%`;
    usageContext.append(strong, rest);
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

// Same window, grown or shrunk — the bars were rendered when the panel opened,
// so this only reveals or hides them and asks main for the window that fits.
// Never a second panel.
btnUsageSize.addEventListener('click', () => {
  usageExpanded = !usageExpanded;
  applyUsageExpansion();
  syncMode();
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

/**
 * Who the next thing typed goes to.
 *
 * '' means the buddy itself; anything else is a session id. Sharing one buddy
 * between every agent means it has to be able to speak *to* them, not only for
 * them — otherwise the chat is a pet that knows things and can't pass them on.
 */
let petTarget = '';

/** Everyone the chat could be addressed to, as main last described them. */
let petRoster = [];

/** `/Users/me/projects/api` -> `~/projects/api`, so the path fits a 300px row. */
const shortPath = (dir) => String(dir || '').replace(/^\/Users\/[^/]+/, '~');

/** "Claude Code" / "Codex" — which harness this session is, spelled out. */
const harnessOf = (agent) => HARNESS_NAMES[agent && agent.agent] || 'Claude Code';

const petChip = document.getElementById('pet-to-chip');

/**
 * Light the pill for whoever the next message is going to.
 *
 * Three things set the target — the pills themselves, an @ mention, and the
 * chip's way back to the buddy — and all three have to leave the row agreeing
 * with `petTarget`, or two places disagree about where a prompt is headed.
 */
function markPetTarget(value) {
  for (const button of petTo.children) {
    const on = button.dataset.to === value;
    button.classList.toggle('on', on);
    button.setAttribute('aria-checked', String(on));
  }
}

/**
 * A small standing portrait of one agent's buddy.
 *
 * The same artwork the buddy on screen is drawn from, at thumbnail size: the
 * built-in SVG ones are drawn live in that session's colour, the rest have a
 * GIF per pose and `idle` is the one that reads as a portrait.
 */
function faceOf(agent) {
  const character = (settings.characters || []).find((c) => c.id === agent.character) || null;
  const colour = agent.color || me.color;
  if (character && character.vector && window.ClippyVectors) {
    const art = window.ClippyVectors.create(character.vector, 'idle', colour);
    if (art) return art;
  }
  // A dropped-in sprite pack has no per-pose GIF at all — its art is one sheet
  // and a row of frames. Standing still on the first frame of `idle` is the
  // portrait; the sheet's own animation is for the buddy, not for a thumbnail.
  const sheet = character && character.sheet;
  if (sheet) {
    const pose = sheet.poses.idle || Object.values(sheet.poses)[0];
    const cell = document.createElement('span');
    cell.className = 'chip-sheet';
    cell.style.backgroundImage = `url("${CSS.escape(pose.file)}")`;
    cell.style.backgroundSize = `${sheet.columns * 100}% ${sheet.rows * 100}%`;
    cell.style.backgroundPosition = `0% ${sheet.rows > 1 ? (pose.row / (sheet.rows - 1)) * 100 : 0}%`;
    return cell;
  }
  const img = document.createElement('img');
  const tint = character && character.perColour ? `${colour.replace('#', '')}-` : '';
  img.src = `assets/themes/${agent.character || 'clip'}/${tint}idle.gif`;
  img.alt = '';
  // Art that was never generated for this character and colour: fall back to a
  // dot in the session's own colour rather than leaving a broken image, or the
  // empty ring that a bare `remove()` left behind.
  img.addEventListener('error', () => {
    img.parentElement?.classList.add('plain');
    img.remove();
  });
  return img;
}

/**
 * Say who the next thing typed is going to, right beside the box.
 *
 * `null` means the buddy itself, and the chip disappears — talking to your own
 * pet is the resting state and does not need labelling.
 */
function showChatTarget(agent) {
  petChip.replaceChildren();
  if (!agent) {
    petChip.classList.add('hidden');
    petEl.classList.remove('addressing');
    return;
  }
  const face = document.createElement('span');
  face.className = 'chip-face';
  face.style.setProperty('--clip', agent.color || me.color);
  face.append(faceOf(agent));
  const name = document.createElement('span');
  name.className = 'chip-name';
  name.textContent = agent.name;
  petChip.append(face, name);
  petChip.title = `Talking to ${agent.name} (${harnessOf(agent)}${agent.cwd ? ` · ${shortPath(agent.cwd)}` : ''}) — click to talk to ${me.pet} instead`;
  petChip.classList.remove('hidden');
  // The panel takes on that session's colour while you are addressing it, so
  // "this is not your pet" is visible without reading anything.
  petEl.classList.add('addressing');
  petEl.style.setProperty('--addressing', agent.color || me.color);
}

function renderPetTargets(roster) {
  petTo.replaceChildren();
  // One buddy answers for every agent, so the row is the whole roster: the
  // buddy, or any session running right now. It used to be hidden when the
  // window spoke for a single session, because the status panel carried a box
  // that talked to that agent — and that box is gone, so this is now the only
  // way to reach it.
  const agents = (roster && roster.agents) || [];
  petRoster = agents;
  if (!agents.length) {
    petTo.classList.add('hidden');
    petTarget = '';
    return;
  }

  const choose = (value) => {
    petTarget = value;
    markPetTarget(value);
    const to = agents.find((a) => a.sessionId === value) || null;
    petInput.placeholder = to ? `Type to ${to.name}…` : 'Say hi';
    showChatTarget(to);
  };

  const add = (value, label, title, enabled = true) => {
    const button = document.createElement('button');
    button.className = 'pet-target';
    button.dataset.to = value;
    button.textContent = label;
    button.title = title;
    button.setAttribute('role', 'radio');
    button.disabled = !enabled;
    button.addEventListener('click', () => choose(value));
    petTo.appendChild(button);
    return button;
  };

  // The buddy itself leads the row, and wears the crown when it is the one
  // answering for everybody — the same mark it wears on its name plate, so
  // "the main one" is one idea with one symbol rather than two.
  const solo = document.body.classList.contains('solo');
  const buddy = add(
    '',
    `${solo ? '👑 ' : ''}${me.pet || 'the buddy'}`,
    solo
      ? `${me.pet} is your main buddy — it speaks for every agent. Talking here reaches none of them.`
      : `Chat with ${me.pet || 'your buddy'} — this never reaches a session`
  );
  buddy.classList.add('main');

  for (const agent of agents) {
    add(
      agent.sessionId,
      agent.name,
      agent.reachable
        ? `Type this into ${agent.name}'s session (${harnessOf(agent)}${agent.cwd ? ` · ${shortPath(agent.cwd)}` : ''})`
        : `${agent.name} has no window or tmux session Clippy can type into`,
      agent.reachable
    );
  }
  petTo.classList.remove('hidden');
  // Keep talking to whoever you were, if they are still there.
  const stillThere = petTarget && agents.some((a) => a.sessionId === petTarget);
  choose(stillThere ? petTarget : '');
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
  refreshPetTargets({ force: true });
}

// Sessions start and end while the panel sits open, and a row of agents that
// is a minute old is worse than none: it offers people who have gone and hides
// people who have arrived. Refreshed on open and on activity, but not on every
// tool event a busy session produces.
let petTargetsAt = 0;
const PET_TARGETS_EVERY_MS = 3000;

let petTargetsTimer = null;

function refreshPetTargets({ force = false } = {}) {
  if (petEl.classList.contains('hidden')) return;
  const now = Date.now();
  const since = now - petTargetsAt;
  if (!force && since < PET_TARGETS_EVERY_MS) {
    // Too soon — but a session really did just start or end, so this has to
    // happen eventually. Dropping it left the row a session out of date until
    // something else happened to come along.
    if (!petTargetsTimer) {
      petTargetsTimer = setTimeout(() => {
        petTargetsTimer = null;
        refreshPetTargets({ force: true });
      }, PET_TARGETS_EVERY_MS - since);
    }
    return;
  }
  if (petTargetsTimer) {
    clearTimeout(petTargetsTimer);
    petTargetsTimer = null;
  }
  petTargetsAt = now;
  window.clippyAPI
    .agents()
    .then((roster) => {
      renderPetTargets(roster);
      syncMode();
    })
    .catch(() => renderPetTargets(null));
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

/**
 * "Was that meant for one of them?"
 *
 * Said to the buddy with nobody selected, a message might still be work for an
 * agent — "the tests are failing on billing-api" is not small talk. Main asks
 * the pet model (src/delegate.js) and answers with a *proposal*.
 *
 * It is never sent from here. A prompt typed into a session becomes work in
 * somebody's repository and cannot be recalled, so the choice is shown with the
 * reason for it and a button, and the button is the user's. Nothing appears at
 * all when the model is unsure — a question you did not ask for is noise, and
 * the chat has already answered.
 */
async function proposeAgent(text) {
  let picked = null;
  try {
    picked = await window.clippyAPI.delegate(text);
  } catch {
    return; // routing is a nicety; failing at it must not disturb the chat
  }
  if (!picked || !picked.agent || petEl.classList.contains('hidden')) return;

  const row = document.createElement('div');
  row.className = 'pet-line offer';
  const said = document.createElement('span');
  said.textContent = picked.why
    ? `Sounds like ${picked.agent.name} — ${picked.why}`
    : `Sounds like ${picked.agent.name}.`;
  const send = document.createElement('button');
  send.className = 'offer-send';
  send.textContent = `send to ${picked.agent.name}`;
  send.addEventListener('click', () => {
    window.clippyAPI.sendPrompt(text, picked.agent.sessionId);
    row.replaceChildren(document.createTextNode(`sent to ${picked.agent.name}`));
    row.className = 'pet-line waiting';
    noteDeed(`passed a message to ${picked.agent.name}`, { who: picked.agent.name });
    syncMode();
  });
  const no = document.createElement('button');
  no.className = 'offer-no';
  no.textContent = 'no';
  no.addEventListener('click', () => {
    row.remove();
    syncMode();
  });
  row.append(said, send, no);
  petLog.append(row);
  petLog.scrollTop = petLog.scrollHeight;
  syncMode();
}

/* ---------- @ — addressing an agent by name ----------
   The pills above the box are fine for two or three agents and useless for a
   dozen: they are one row, they truncate, and two projects called "api" look
   identical on them. Typing @ opens the same roster as a list instead, with
   the folder and the harness under each name — which is the only way to tell
   ~/work/api from ~/side/api apart. Picking one sets the same target the pills
   set, so the two can never disagree about where a message is going. */

const picker = document.getElementById('pet-picker');
let pickerHits = []; // what @ is currently offering
let pickerAt = -1; // which of them is highlighted

/** The `@fragment` immediately before the caret, or null. */
function mentionBeforeCaret() {
  const upto = petInput.value.slice(0, petInput.selectionStart ?? petInput.value.length);
  const m = /@([^\s@]*)$/.exec(upto);
  return m ? { start: upto.length - m[0].length, query: m[1] } : null;
}

function hidePicker() {
  if (picker.classList.contains('hidden')) return;
  picker.classList.add('hidden');
  picker.replaceChildren();
  pickerHits = [];
  pickerAt = -1;
  syncMode();
}

function highlightPicker(next) {
  if (!pickerHits.length) return;
  // Wraps, so holding ↓ never dead-ends at the bottom of a long list.
  pickerAt = (next + pickerHits.length) % pickerHits.length;
  [...picker.children].forEach((row, i) => row.classList.toggle('on', i === pickerAt));
  picker.children[pickerAt]?.scrollIntoView({ block: 'nearest' });
}

/**
 * Offer whoever matches what has been typed after the @.
 *
 * Unreachable agents are listed but not selectable: seeing that a session is
 * there and cannot be typed into is more use than it silently missing from the
 * list, which reads as "Clippy has forgotten about it".
 */
function refreshPicker() {
  const mention = mentionBeforeCaret();
  if (!mention) return hidePicker();

  const q = mention.query.toLowerCase();
  const hits = petRoster.filter(
    (a) =>
      !q ||
      a.name.toLowerCase().includes(q) ||
      shortPath(a.cwd).toLowerCase().includes(q) ||
      harnessOf(a).toLowerCase().includes(q)
  );
  if (!hits.length) return hidePicker();

  pickerHits = hits;
  picker.replaceChildren();
  for (const [i, agent] of hits.entries()) {
    const row = document.createElement('div');
    row.className = `pick${agent.reachable ? '' : ' off'}`;
    row.setAttribute('role', 'option');

    const name = document.createElement('span');
    name.className = 'pick-name';
    name.textContent = agent.name;

    const meta = document.createElement('span');
    meta.className = 'pick-meta';
    meta.textContent = agent.reachable
      ? `${harnessOf(agent)}${agent.cwd ? ` · ${shortPath(agent.cwd)}` : ''}`
      : `${harnessOf(agent)} · no window to type into`;

    row.append(name, meta);
    // mousedown, not click: the box must not lose the caret before we put the
    // name into it.
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (agent.reachable) takeMention(agent);
    });
    row.addEventListener('mouseenter', () => highlightPicker(i));
    picker.appendChild(row);
  }
  picker.classList.remove('hidden');
  // First reachable one, so Enter lands somewhere useful straight away.
  highlightPicker(Math.max(0, hits.findIndex((a) => a.reachable)));
  syncMode();
}

/** Put the chosen agent's name in the box and point the message at them. */
function takeMention(agent) {
  const mention = mentionBeforeCaret();
  if (!mention) return hidePicker();
  const before = petInput.value.slice(0, mention.start);
  const after = petInput.value.slice(petInput.selectionStart ?? petInput.value.length);
  const token = `@${agent.name} `;
  petInput.value = before + token + after;
  const caret = before.length + token.length;
  petInput.setSelectionRange(caret, caret);
  hidePicker();
  petTarget = agent.sessionId;
  // The pills are the same setting seen another way, so they move with it.
  markPetTarget(petTarget);
  petInput.placeholder = `Type to ${agent.name}…`;
  showChatTarget(agent);
  petInput.focus();
  syncComposing(petInput, petEl);
}

/**
 * Strip the address off the front of a message.
 *
 * `@billing-api deploy it` is addressed to billing-api and says "deploy it" —
 * sending the @ along would put Clippy's own routing syntax into somebody's
 * prompt.
 */
function withoutMention(text) {
  const named = (name) => petRoster.some((a) => a.name === name);
  // Only an address and nothing else: you have said who, not what, so there is
  // nothing to send yet.
  const bare = /^@(\S+)\s*$/.exec(text);
  if (bare && named(bare[1])) return '';
  const m = /^@(\S+)\s+([\s\S]+)$/.exec(text);
  if (!m) return text;
  return named(m[1]) ? m[2] : text;
}

async function sayToPet() {
  const text = withoutMention(petInput.value.trim());
  if (!text || petThinking) return;
  hidePicker();

  // Addressed to an agent: this is not small talk, it goes to their session
  // exactly as the status card's composer would send it.
  if (petTarget) {
    petInput.value = '';
    petEl.classList.remove('composing');
    petLine(text, 'mine');
    window.clippyAPI.sendPrompt(text, petTarget);
    const to = [...petTo.children].find((b) => b.dataset.to === petTarget);
    petLine(`sent to ${to ? to.textContent : 'the agent'}`, 'waiting');
    syncMode();
    return;
  }

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

petInput.addEventListener('input', () => {
  syncComposing(petInput, petEl);
  refreshPicker();
});
// Moving the caret can leave (or enter) an @ without changing a character.
petInput.addEventListener('click', refreshPicker);
petInput.addEventListener('blur', hidePicker);

petInput.addEventListener('keydown', (e) => {
  // While the picker is up it owns the keys that mean "choose": Enter would
  // otherwise send a half-typed @name as a message.
  if (!picker.classList.contains('hidden')) {
    if (e.key === 'ArrowDown') return e.preventDefault(), highlightPicker(pickerAt + 1);
    if (e.key === 'ArrowUp') return e.preventDefault(), highlightPicker(pickerAt - 1);
    if (e.key === 'Enter' || e.key === 'Tab') {
      const agent = pickerHits[pickerAt];
      if (agent && agent.reachable) {
        e.preventDefault();
        takeMention(agent);
        return;
      }
    }
    if (e.key === 'Escape') {
      // The picker first, the panel second: one Escape should not do both.
      e.preventDefault();
      hidePicker();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sayToPet();
  }
  if (e.key === 'Escape') hidePet();
});

document.getElementById('pet-close').addEventListener('click', hidePet);

// The chip is a way out as well as a label: one click and you are talking to
// your own buddy again, without hunting for its pill.
petChip.addEventListener('click', () => {
  petTarget = '';
  markPetTarget('');
  petInput.placeholder = 'Say hi';
  showChatTarget(null);
  petInput.focus();
});
document.getElementById('feed-close').addEventListener('click', hideFeed);
/**
 * The action bar under the buddy.
 *
 * Each of these was already reachable — two as floating word-buttons that a
 * panel would adopt as its footer, the rest only by knowing to right-click. The
 * bar is the one surface now; the context menu stays as a shortcut for people
 * who already reach for it, and both drive the same functions.
 *
 * stopPropagation throughout: a click that reaches the buddy underneath would
 * also run primaryAction and open something else on top of what was just asked
 * for.
 */
const onAction = (id, run) =>
  document.getElementById(id).addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });

onAction('btn-chat', togglePet);
onAction('btn-stats', () => {
  if (usageEl.classList.contains('hidden')) showUsage();
  else hideUsage();
});
onAction('btn-messages', () => {
  if (feedEl.classList.contains('hidden')) showFeed();
  else hideFeed();
});
onAction('btn-settings', () => window.clippyAPI.openSettings());

/* ---------- Drive mode panel (Clippy-driven Agent SDK session) ---------- */

function openDrive(evt) {
  driveTitle.textContent = `Driving “${evt.name}”`;
  driveTranscript.replaceChildren();
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

/* ---------- Recent messages (sessions Clippy started) ---------- */

// Enough to see how a turn went without the panel becoming a scrollback log.
const FEED_MAX = 12;
// Turns this buddy has said, newest last, keyed so a turn that arrives twice
// (a Claude response is written across several lines) merges instead of repeats.
const feedTurns = [];

/** Merge a batch of turns in, replacing any we have already seen by id. */
function mergeFeed(turns) {
  for (const turn of turns || []) {
    if (!turn || !turn.text) continue;
    const at = feedTurns.findIndex((seen) => seen.id === turn.id);
    if (at === -1) feedTurns.push(turn);
    else feedTurns[at] = turn;
  }
  if (feedTurns.length > FEED_MAX) feedTurns.splice(0, feedTurns.length - FEED_MAX);
}

function renderFeed() {
  feedLog.replaceChildren();
  if (!feedTurns.length) {
    const empty = document.createElement('div');
    empty.className = 'feed-line system';
    empty.textContent = 'Nothing said yet.';
    feedLog.appendChild(empty);
    return;
  }

  for (const turn of feedTurns) {
    const line = document.createElement('div');
    line.className = `feed-line ${turn.role}`;

    const label = document.createElement('span');
    label.className = 'feed-role';
    label.textContent = turn.role === 'user' ? 'you:' : `${me.name}:`;
    line.appendChild(label);

    const copy = document.createElement('div');
    if (turn.source === 'pane') {
      // Reconstructed from the terminal, not read from the transcript. It is
      // rendered output, not markdown, and pretending otherwise mangles it.
      const pre = document.createElement('pre');
      pre.className = 'pane';
      pre.textContent = turn.text;
      copy.appendChild(pre);
      copy.className = 'feed-copy';
    } else {
      copy.className = 'feed-copy markdown';
      setMarkdown(copy, turn.text);
    }
    line.appendChild(copy);

    if (turn.tools && turn.tools.length) {
      const tools = document.createElement('span');
      tools.className = 'feed-tools';
      tools.textContent = turn.tools.join(' · ');
      line.appendChild(tools);
    }
    feedLog.appendChild(line);
  }
  feedLog.scrollTop = feedLog.scrollHeight;
}

async function showFeed() {
  // Everything wants the same space above the buddy's head.
  usageEl.classList.add('hidden');
  bubbleEl.classList.add('hidden');
  qcardEl.classList.add('hidden');
  petEl.classList.add('hidden');
  menuEl.classList.add('hidden');
  renderFeed();
  feedEl.classList.remove('hidden');
  syncMode();

  // The pushes only carry what arrived while we were listening; opening the
  // panel is the moment to go and read the rest.
  try {
    const history = await window.clippyAPI.feed();
    if (!history) return;
    if (history.source) feedSrc.textContent = history.source;
    mergeFeed(history.turns);
    if (!feedEl.classList.contains('hidden')) {
      renderFeed();
      syncMode();
    }
  } catch {
    // Nothing to read is a normal state, not an error worth a bubble.
  }
}

function hideFeed() {
  feedEl.classList.add('hidden');
  syncMode();
}

/* ---------- Interactive cards (approvals & reviews) ---------- */

/**
 * Show one of the queued cards — by default the one at the front.
 *
 * `id` names a specific card, which is how paging works: reading what else is
 * waiting used to mean *answering* the card in front of it, since this always
 * took `requests.values().next()`. The buddy advertised the others with a
 * count badge, a "+N more" chip and a stack of paper behind the card, and gave
 * you no way to reach any of them.
 */
function showNextRequest(id = null) {
  const queue = [...requests.values()];
  const next = (id && requests.get(id)) || queue[0];
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
  const isReview = next.type === 'review';
  const isFailure = next.type === 'failure';
  const isPlan = next.variant === 'plan';
  // A plan is a page, not a blurb: the card grows (clippy.css) and syncMode
  // asks main for a window wide and tall enough to read it in.
  document.body.classList.toggle('plan', isPlan);
  showQueueDepth();
  // Whose card this is, before what it says: one buddy can be answering for
  // several agents, and "which of them is this" is the first thing to know.
  // The card carries its own — reading it off the window would name whichever
  // session that window heard from most recently.
  if (next.source) source = { ...source, ...next.source };
  applySource();
  const closeTip =
    isReview || isFailure
      ? 'Close'
      : `Close — ${there(next)} will ask you there instead`;
  btnCardX.dataset.tooltip = closeTip;
  btnCardX.setAttribute('aria-label', closeTip);
  paintWhere(next);
  cardTitle.textContent = isReview ? `${next.agentName || 'Claude'} Finished` : next.title;
  cardEl.classList.toggle('review', isReview);
  cardEl.classList.toggle('failure', isFailure);

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
    applyPassLabel(next, { move: true });
    btnPass.classList.toggle('hidden', !!next.noPass);
    btnSubmit.classList.remove('hidden');
    cardEl.classList.remove('hidden');
    armPanel(cardEl);
    syncMode();
    setExcited(true);
    return;
  }

  cardOptions.classList.add('hidden');
  cardOptions.replaceChildren();
  // The review card leads with its two actions; the feedback box only appears
  // once "Send feedback" is clicked. Approvals keep the always-there box — the
  // note rides along with whichever button you press.
  cardInput.classList.toggle('hidden', !isApproval);
  btnSubmit.classList.add('hidden');

  // A glance, not a page: the rest is a button away, in a window that can hold
  // it. `next.detail` is kept whole so the reader has something to show even
  // when main had nothing left to send.
  const promptShown = isReview ? summarise(next.prompt || '', 110).replace(/\s+/g, ' ') : '';
  cardPromptPreview.textContent = promptShown;
  cardPromptRow.classList.toggle('hidden', !promptShown);
  cardResponseLabel.classList.toggle('hidden', !isReview);
  const shown = summarise(next.detail || '', isReview ? 150 : isFailure ? 180 : 220);
  if (isReview) cardDetail.textContent = shown.replace(/\s+/g, ' ');
  else setMarkdown(cardDetail, shown);
  cardDetail.classList.toggle('hidden', !shown);
  cardMore.textContent = isReview || isFailure ? 'Read' : 'read it all ↗';
  offerTheRest({ ...next, truncated: next.truncated || shown !== (next.detail || '') });
  cardInput.value = next.draft || '';
  cardInput.placeholder = isPlan
    ? 'optional: what to change before approving (Revise sends this back)…'
    : isApproval
    ? 'optional: tell Claude why, or what to do instead…'
    : 'type feedback to send Claude back to work…';
  // Plan approvals reuse the allow/deny path but read better as Approve/Revise.
  btnAllow.textContent = isPlan ? 'Approve plan' : 'Allow';
  btnDeny.textContent = isPlan ? 'Revise' : 'Deny';
  applyPassLabel(next);
  btnAllow.classList.toggle('hidden', !isApproval);
  btnDeny.classList.toggle('hidden', !isApproval);
  btnPass.classList.toggle('hidden', !isApproval || next.noPass); // Drive has no terminal
  btnGood.classList.toggle('hidden', isApproval || isFailure);
  btnFeedback.classList.toggle('hidden', isApproval || isFailure);
  // On a review card the first click on "Send feedback" opens the box, so the
  // button starts enabled; once the box is open it disables until there's text.
  btnFeedback.disabled = false;

  cardEl.classList.remove('hidden');
  armPanel(cardEl);
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
/**
 * Offer the whole thing when the card is only showing part of it.
 *
 * Either main cut it before sending (a plan past 4000 characters, a sign-off
 * past 600) or it arrived whole and does not fit the box — which has to be
 * measured, since the text is whatever the agent wrote and the box is a fixed
 * height.
 */
function offerTheRest(req) {
  // A finished-response card is deliberately only one line. Reading is always
  // available beside it, even when the complete answer happened to be short.
  if (req.type === 'review' || req.type === 'failure') {
    cardMore.classList.toggle('hidden', !req.detail);
    return;
  }
  const boxed =
    !cardDetail.classList.contains('hidden') &&
    cardDetail.scrollHeight > cardDetail.clientHeight + 2;
  cardMore.classList.toggle('hidden', !(req.truncated || boxed));
}

/**
 * The first line or two of a message, for the card.
 *
 * The summary is the agent's own opening — free, and already what the review
 * card's headline does. The alternative was a summarising call through the pet
 * model, which reads better and costs a request per message; if that is ever
 * wanted, this is the one place to change.
 */
function summarise(text, cap = 220) {
  const clean = String(text || '').trim();
  if (clean.length <= cap) return clean;
  // Prefer a sentence or paragraph boundary within reach of the cap, so the
  // summary ends somewhere a person would have stopped.
  const window = clean.slice(0, cap + 60);
  const stop = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n\n'));
  return `${(stop > cap * 0.5 ? window.slice(0, stop + 1) : clean.slice(0, cap)).trim()}…`;
}

cardMore.addEventListener('click', () => {
  // Open it in a window instead of growing this one.
  //
  // "read all" used to unfold the card in place: the same floating panel got
  // taller until it ran out of screen, could not be moved to another display,
  // and went away the moment the card was answered. A long message wants a
  // page, and a page wants a window.
  const req = requests.get(activeRequestId);
  if (req) {
    if (req.type === 'failure') {
      window.clippyAPI.openActivityReader(req.title || 'Failure details', req.detail || req.title);
      return;
    }
    window.clippyAPI.openReader(req.id, {
      title: req.title,
      prompt: req.prompt || '',
      text: req.detail || req.title,
      sessionId: req.sessionId || '',
      buddy: readerBuddy(),
    });
  }
});

/** "+2 more": how many held requests are stacked up behind this card. */
function showQueueDepth() {
  const queue = [...requests.keys()];
  const at = queue.indexOf(activeRequestId);
  const many = queue.length > 1;
  // Where you are, not only how many are left — the point of being able to
  // move is knowing whether there is anything behind you.
  cardQueue.classList.toggle('hidden', !many);
  cardQueue.textContent = many ? `${at + 1} of ${queue.length}` : '';
  cardPager.classList.toggle('hidden', !many);
  // The sheets behind the card say the same thing without being read. Set
  // here as well as in render(), because a card is shown straight from
  // showNextRequest and the window is measured immediately after.
  showStack();
}

/**
 * Step to the card `by` places along, wrapping.
 *
 * Nothing is resolved by moving: every card keeps its deadline running and its
 * half-typed reason, and comes back exactly as it was left.
 */
function pageCards(by) {
  const queue = [...requests.keys()];
  if (queue.length < 2) return;
  // Whatever is in the box belongs to the card being left, not to the box.
  const leaving = requests.get(activeRequestId);
  if (leaving) leaving.draft = cardInput.value;
  const at = queue.indexOf(activeRequestId);
  showNextRequest(queue[(at + by + queue.length) % queue.length]);
}

// answers map for the active answer card: questionText -> label | [labels]
let answerState = {};

function renderAnswerOptions(req) {
  answerState = {};
  cardOptions.replaceChildren();
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

const DEED_WORDS = {
  allow: 'allowed',
  deny: 'denied',
  pass: 'handed back',
  dismiss: 'waved away',
  answer: 'answered',
  feedback: 'sent feedback on',
  ok: 'signed off',
};

function decide(action, message = '') {
  if (!activeRequestId) return;
  const req = requests.get(activeRequestId);
  if (req) {
    const what = req.type === 'review' ? 'the last turn' : req.title || 'a request';
    noteDeed(`${DEED_WORDS[action] || action} ${what}`, { who: req.name });
  }
  window.clippyAPI.decide(activeRequestId, action, message);
  const queue = [...requests.keys()];
  const at = queue.indexOf(activeRequestId);
  requests.delete(activeRequestId);
  // Stay where you were in the queue rather than snapping back to the front:
  // answering the third of four should show you the fourth, not the first.
  const rest = [...requests.keys()];
  showNextRequest(rest[Math.min(at, rest.length - 1)] || null);
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
    // A card can now expire while you are reading a different one. Only move
    // if the one you are *on* is the one that went; otherwise stay put, or
    // paging would yank you elsewhere every time something behind you timed
    // out.
    if (!requests.has(activeRequestId)) showNextRequest();
    else showQueueDepth(); // the position it shows has shifted underneath it
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
  // Only the window that actually speaks for everybody wears the crown and
  // keeps its plate up — not every buddy that happens to exist while the mode
  // says 'one'.
  document.body.classList.toggle('solo', s.isSolo === true);
  applyCharacter();
  applyIdentity();
  render();
});

window.clippyAPI.onIdentity((id) => {
  const wasColor = me.color;
  Object.assign(me, id);
  // The clip sprites are drawn per session colour, so a buddy that just
  // changed which session it speaks for needs its artwork re-picked, not just
  // its name re-lettered.
  if (id.color && id.color !== wasColor) applyCharacter();
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
  // Whoever is running may have changed; the chat's target row should agree.
  refreshPetTargets();

  switch (evt.kind) {
    case 'appearance':
      window.ClippySounds.play(evt.sound || settings.appearanceSound);
      break;

    case 'approval':
    case 'review': {
      if (evt.kind === 'review') {
        // The turn ending is worth remembering whether or not the card is
        // ever answered — it is the "we completed this" line.
        const said = (evt.message || '').replace(/^.*? finished:?\s*/i, '').trim();
        noteDeed(said ? `finished: ${said.slice(0, 70)}` : 'finished a turn', { who: evt.name });
      }
      // A review card carries no deadline (expiresAt 0): the hook was already
      // answered, so the card can wait for as long as the user does.
      requests.set(evt.requestId, {
        id: evt.requestId,
        type: evt.kind,
        variant: evt.variant || 'tool',
        noPass: !!evt.noPass,
        name: evt.name,
        // Kept per card, not per window: one buddy answers for every agent, so
        // the next card up may well be a different one in a different app.
        sessionId: evt.sessionId || '',
        agentName: evt.agentName || '',
        source: evt.source || null,
        color: evt.color || me.color,
        title: evt.kind === 'approval' ? evt.title : evt.title || evt.message,
        prompt: evt.prompt || '',
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
    case 'failure': {
      const activity = evt.activity || {};
      showActivity(evt.name, activity);
      const id = evt.requestId || `failure-${evt.sessionId || 'session'}-${Date.now()}`;
      requests.set(id, {
        id,
        type: 'failure',
        name: evt.name,
        sessionId: evt.sessionId || '',
        agentName: evt.agentName || '',
        source: evt.source || null,
        color: evt.color || me.color,
        title: evt.title || `${activity.tool || 'Tool'} failed`,
        detail: evt.detail || activity.error || evt.message || activity.label || 'The tool failed.',
        expiresAt: 0,
        holdMs: 1,
      });
      if (!activeRequestId) showNextRequest(id);
      else showQueueDepth();
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
        sessionId: evt.sessionId || '',
        agentName: evt.agentName || '',
        source: evt.source || null,
        color: evt.color || me.color,
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
      if (evt.source) source = { ...source, ...evt.source };
      applySource();
      // Which app a session lives in takes a process-table walk to work out, so
      // the first card of a session is usually built before the answer lands.
      // When it does, the card on screen gets the better name rather than
      // keeping the generic one until it is dismissed.
      const open = requests.get(activeRequestId);
      if (open && evt.source && open.sessionId === evt.sessionId) {
        open.source = { ...open.source, ...evt.source };
        paintWhere(open);
        applyPassLabel(open);
      }
      break;
    }
    case 'dock': {
      // Perched on the session's terminal window: happy, small, and quiet
      // until something actually needs an answer.
      document.body.classList.toggle('docked', Boolean(evt.docked));
      // Compact is about size, not about being perched — a corner buddy is a
      // bare paperclip too until it has something to show.
      document.body.classList.toggle('compact', Boolean(evt.compact));
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
    case 'open-usage': {
      showUsage();
      break;
    }
    case 'request-closed': {
      // resolved elsewhere: timeout, terminal answer, or session moved on
      if (requests.has(evt.requestId) && evt.timedOut) {
        noteDeed(`ran out of time on ${requests.get(evt.requestId).title || 'a request'}`, {
          who: requests.get(evt.requestId).name,
        });
      }
      if (requests.delete(evt.requestId)) {
        // Only move if the card that went is the one being read. Now that the
        // queue can be paged, something timing out three cards behind you must
        // not drag you back to the front — but the position it shows has
        // changed underneath, so that is redrawn either way.
        if (evt.requestId === activeRequestId) showNextRequest();
        else showQueueDepth();
        render();
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
        snoozedUntil: sleepingUntil,
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
    // A session Clippy started, read out of its own transcript. Ambient by
    // design: it never steals the window from a card you have to answer.
    case 'transcript': {
      const wasEmpty = !feedTurns.length;
      mergeFeed(evt.turns);
      menuFeed.classList.remove('hidden'); // there is something to show now
      btnMessages.classList.remove('hidden');
      if (evt.source) feedSrc.textContent = evt.source;
      if (!feedEl.classList.contains('hidden')) renderFeed();

      // The newest thing it said, in the bubble — but only when the panel is
      // closed, nothing is being asked of the user, and this is news rather
      // than the backlog we read on the way in.
      const said = [...(evt.turns || [])].reverse().find((t) => t.role === 'assistant' && t.text);
      // A watcher cold-starts from the transcript tail. For a prompt just sent
      // through this buddy, that first read is a live reply, not old history.
      const isNews = evt.directReply || (!evt.cold && !wasEmpty);
      const quiet = feedEl.classList.contains('hidden') && !activeRequestId && isNews;
      if (said && quiet) {
        showBubble(said.text);
        setTimeout(() => {
          if (!activeRequestId && ![...pending.values()].some((p) => !p.acknowledged)) hideBubble();
        }, 6000);
      }
      break;
    }

    // This buddy's session is one Clippy started, not one it noticed.
    case 'ownership':
      me.owned = Boolean(evt.owned);
      me.host = evt.host || '';
      me.tmux = evt.tmux || '';
      document.body.classList.toggle('owned', me.owned);
      if (me.owned) {
        menuFeed.classList.remove('hidden');
        btnMessages.classList.remove('hidden');
      }
      feedSrc.textContent = me.host ? `via ${me.host}` : me.tmux ? `tmux · ${me.tmux}` : '';
      applyIdentity();
      break;

    // Whether we can still reach a remote transcript. A muted line in the
    // panel and nothing more — a flaky VPN must not make a paperclip bounce.
    case 'transcript-status': {
      const trouble = evt.state === 'unreachable';
      feedNote.textContent = trouble ? `can't reach ${evt.host || 'the session'} — retrying` : '';
      feedNote.classList.toggle('hidden', !trouble);
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

/**
 * Past this much of the context window used, the buddy looks stressed.
 *
 * This was 0.3, which meant a red pulse on every session that had been going
 * for ten minutes — permanently, with nothing wrong. A signal that is on
 * almost all the time is not a signal, and "why is it flashing red?" is the
 * only thing it actually communicated.
 *
 * Nine tenths full is the point where it is worth knowing: a turn or two left
 * before the agent starts forgetting the beginning of the conversation. Until
 * then a filling context window is information, and it already has a bar in
 * the panel saying so.
 */
const CONTEXT_STRESS = 0.9;
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
/**
 * The corner (x) on a held card.
 *
 * Never an answer. Whatever kind of card it is, closing hands the decision
 * back to the agent — which then asks in its own terminal, exactly as it would
 * have if Clippy had not been running. That is what makes an (x) safe to put on
 * a card at all: the alternative was a fifth button that resolved a permission
 * request without saying which way you meant it.
 *
 * A review card holds nothing open, so there is nothing to hand back and this
 * is a plain close.
 */
document.getElementById('card-prev').addEventListener('click', () => pageCards(-1));
document.getElementById('card-next').addEventListener('click', () => pageCards(1));

// Arrows page the queue while a card is up — but never while something is
// being typed into it, where they mean "move the caret".
document.addEventListener('keydown', (e) => {
  if (!activeRequestId || requests.size < 2) return;
  if (e.target === cardInput || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    pageCards(-1);
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    pageCards(1);
  }
});

btnCardX.addEventListener('click', () => {
  const req = requests.get(activeRequestId);
  if (!req) return;
  if (req.type === 'review') return decide('ok');
  if (req.type === 'failure') {
    requests.delete(activeRequestId);
    showNextRequest();
    render();
    return window.clippyAPI.hide();
  }
  // An answerable question is waved away; an approval is passed back. Both end
  // up as {} on the wire — the agent asks for itself.
  decide(req.type === 'answer' ? 'dismiss' : 'pass');
});

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

// The corner (x) on a question: put it away and show them where to answer.
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

onAction('btn-hide', () => window.clippyAPI.hide());

// Raise this session's terminal window from a card: "this needs you — take me
// to that terminal". Clippy rides along on its top-right corner.
btnGoto.addEventListener('click', () => window.clippyAPI.openWindow());

document.getElementById('btn-usage-close').addEventListener('click', hideUsage);

/* ---------- Talking back ---------- */

/**
 * An empty box is an invitation, not a form: one line tall until there are
 * words in it, then three. Growing changes how tall the panel is, so main is
 * told either way.
 */
function syncComposing(el, box) {
  const composing = Boolean(el.value.trim());
  if (composing === box.classList.contains('composing')) return;
  box.classList.toggle('composing', composing);
  syncMode();
}


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

  // The chat is the one panel you compose in, so clicking the buddy must not
  // quietly swap it for something else. It used to: a waiting message won this
  // race, the bubble took the panel's place, and a half-typed sentence went
  // with it — you clicked the animal you were talking to and it changed the
  // subject. Clicking him now closes the chat, the same way 💬 does, and
  // mid-sentence it stays put — the rule parking already follows.
  if (!petEl.classList.contains('hidden')) {
    if (petInput.value.trim() || petThinking) return;
    hidePet();
    return;
  }

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
  return PANELS.some(isOpen);
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
  // Still pointing at it. A leave can be reported for reasons that are not the
  // user walking away — the window resizing under a stationary cursor is the
  // usual one — and putting the panel away while they are reading it is what
  // made opening anything feel like a flicker: open, vanish, open again. If
  // anything in this window is under the pointer, they have not left.
  if (document.querySelector(':hover')) return;
  // Mid-thought in the chat box, so stay put.
  if (petInput.value.trim()) return;
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

menuSleep.addEventListener('click', () => {
  const opening = menuSleepOptions.classList.contains('hidden');
  menuSleepOptions.classList.toggle('hidden', !opening);
  menuSleep.querySelector('.caret').textContent = opening ? '⌄' : '›';
  syncMode();
});

document.querySelectorAll('.menu-sleep-for').forEach((button) => {
  button.addEventListener('click', () => {
    const minutes = Number(button.dataset.minutes) || 5;
    sleepingUntil = Date.now() + minutes * 60 * 1000;
    for (const p of pending.values()) p.snoozedUntil = sleepingUntil;
    hideBubble();
    closeMenu();
    render();
  });
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

document.getElementById('menu-feed').addEventListener('click', () => {
  closeMenu();
  if (feedEl.classList.contains('hidden')) showFeed();
  else hideFeed();
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
