'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  dialog,
  screen,
  shell,
  systemPreferences,
  nativeImage,
  clipboard,
} = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHookServer } = require('./server');
const { SessionTracker, AGENTS, agentDisplayName, WORKING, WAITING } = require('./sessions');
const {
  DecisionBroker,
  toHookResponse,
  describeToolCall,
  FULL_DETAIL_MAX,
} = require('./decisions');
const { DriveSession } = require('./sdk-session');
const { PetChat } = require('./pet-chat');
const { checkDrift, checkCodexDrift, checkOpenclawDrift, installToFiles } = require('../bin/clippy-hooks');
const { identityFor, petNameFor } = require('./identity');
const { SIZES, sizeList, allCharacters, characterFor, sizeFor } = require('./characters');
const { windowActionFor } = require('./visibility');
const { SOLO_KEY, sharesWindow, windowKeyFor, successorFor } = require('./buddy-mode');
const { EDGE_OPTIONS, EDGE_IDS, edgeLineup, edgeHome } = require('./arrange');
const {
  terminalFromHeaders,
  parseProcessTable,
  resolveTarget,
  revealWindow,
  windowBounds,
  dockPosition,
  promptPosition,
  typeAndSubmit,
  appForPid,
  TERMINAL_APP,
  ITERM_APP,
} = require('./terminal');
const tmux = require('./tmux');
const { SpawnedSessions, buddyKeyFor, rememberProject } = require('./spawned');
const { chatWorkspace, ensureChatWorkspace } = require('./workspace');
const { TRUST_PROMPT, paneStartupState, prepareAgentWorkspace } = require('./agent-startup');
const { resolveSession, createReader, readTail, turnsFrom, lastSaid, lastPrompt } = require('./transcript');
const { createRemoteReader, controlPathFor, ensureControlDir } = require('./transport');
const { startAgentWatch } = require('./agent-watch');
const {
  sessionUsage,
  lastAssistantText,
  usageWindows,
  readOfficialUsage,
  modelFromTranscriptFile,
} = require('./usage');
const { checkForUpdates, localBuild } = require('./updates');
const { prepareInstall, launchInstall } = require('./auto-update');
const { lockPath, allowsMultiple, writeLock, holderOf, defend } = require('./single-instance');
const { sendFeedback } = require('./feedback');
const { DEV_SESSION, eventsFor, storyList, sandboxUsage } = require('./sandbox-scenarios');
const { startCompletionPoll, coalesceAsync } = require('./async-control');
const { createOutbox } = require('./outbox');
const { createFocusProbe, looksFocused } = require('./frontmost');
const { describeSource } = require('./source-app');
const { routingPrompt, parseChoice, routable } = require('./delegate');

const PORT = Number(process.env.CLIPPY_PORT || 43117);
let installingUpdate = false;

// Clippy is a small paperclip by default — the size it is when perched on a
// window — and only takes the full window when there's a card to read.
// Wider than the 300px panel inside it, and by enough for what is drawn
// outside the panel's own box: the offset shadow to its right, and — when
// several messages are waiting — the sheets stacked past its top-left corner
// (`.stacked` in clippy.css). Anything drawn past this is clipped by the
// window edge rather than shown.
const WIN_W = 342;
const WIN_H = 520; // fallback until the renderer reports what it needs
const WIN_GAP = 6;
const ROW_STEP = 160; // how far a second row of Clippys sits above the first

// How often a perched Clippy re-checks where its window went.
const DOCK_POLL_MS = 700;

// Walking over to the prompt to point at it: how long the stroll takes, how
// long he stands there pointing, and how many pixels of window the arrow under
// his feet needs.
const WALK_MS = 900;
const WALK_FRAME_MS = 40;
const POINT_MS = 5000;
const POINT_EXTRA_H = 30;

// How long interactive cards wait for a click before falling back to the
// normal terminal flow. They can be extended while the user is typing, but
// never past the broker's hard cap (which stays under the hook's curl -m).
const APPROVAL_HOLD_MS = Number(process.env.CLIPPY_APPROVAL_HOLD_SECS || 60) * 1000;
const QUESTION_HOLD_MS = Number(process.env.CLIPPY_QUESTION_HOLD_SECS || 90) * 1000;

// How often to drop sessions whose terminal went away without a SessionEnd.
const SWEEP_INTERVAL_MS = 60 * 1000;

const tracker = new SessionTracker();
const broker = new DecisionBroker({ hardCapMs: 100_000 });
let drive = null; // the active Clippy-driven (Agent SDK) session, if any
let tray = null;
let trayTextFallback = false; // the icon failed to render; the 📎 title stands in
// A card can only hold the hook for a short time. Keep its destination here
// after that hand-off so "I came back later" never turns into "where did that
// approval go?". This is intentionally runtime-only: once Clippy restarts it
// cannot know whether the terminal prompt is still live.
const attentionInbox = new Map(); // requestId -> { sessionId, name, agentName, title, state }
let hookDrift = null; // set when the installed hooks are older than this build
let hooksAbsent = false; // no agent has any Clippy hooks — a fresh (DMG) install

/* ---------------- Settings (persisted across restarts) ---------------- */

const settings = {
  approvals: true, // answer permission requests from the Clippy UI
  reviewOnStop: true, // offer a review box when Claude finishes a turn
  answerQuestions: true, // answer Claude/Codex multiple-choice questions in Clippy
  autoPerch: true, // appear on the session's own window, not the screen corner
  // Say nothing when you are already looking at the window that is asking: the
  // agent's own prompt is right there, so a buddy over the top of it is the app
  // getting in the way of the thing it exists to help with. Held cards are
  // handed straight back to that window instead of being kept here.
  quietWhenFocused: true,
  appearanceSound: 'pop', // short cue when a hidden buddy appears; '' is silent
  characterByProject: {}, // project name -> character id, when you've picked one
  sizeByProject: {}, // project name -> size id, likewise
  // …and the same two against one live session, so picking a pet for one row of
  // the settings window leaves the folder's other agents alone. Keyed by
  // session id, and capped, because sessions are many and short-lived.
  characterBySession: {},
  sizeBySession: {},
  // The face the one buddy always wears. '' means "let Clippy pick" — the same
  // casting a session would have got.
  soloCharacter: '',
  size: 'medium', // how big Clippy is drawn
  arrangeEdge: '', // screen edge new buddies line up on; '' = the classic corner
  // …and the sessions Clippy starts itself (see spawnAgent).
  defaultAgent: 'claude', // which agent a recent project re-opens with
  attachTerminal: 'terminal', // where "attach in terminal" opens the session
  recentProjects: [], // [{ path, host, remotePath, agent, at }] — the New agent menu
  spawnedSessions: [], // the tmux sessions we own, so they survive a restart
};

// Settings that aren't simple on/off switches, with the values they accept.
const CHOICES = {
  size: () => Object.keys(SIZES),
  arrangeEdge: () => EDGE_IDS,
  appearanceSound: () => ['', 'pop', 'chime', 'chirp'],
  soloCharacter: () => ['', ...characterIds()],
  defaultAgent: () => Object.keys(tmux.SPAWNABLE),
  attachTerminal: () => Object.keys(ATTACH_APPS),
};

// Where "attach in terminal" opens a tmux session.
const ATTACH_APPS = { terminal: 'Terminal', iterm: 'iTerm' };

/**
 * An agent id we can actually start, or ''.
 *
 * `Object.hasOwn`, not a truthiness test: `SPAWNABLE['constructor']` is
 * perfectly truthy, and the id arrives from a renderer form or from a settings
 * file anyone can edit before it reaches a tmux launch line.
 */
const spawnableAgent = (id) => (Object.hasOwn(tmux.SPAWNABLE, String(id)) ? String(id) : '');

// Settings a renderer must never set directly: each is a collection with its
// own writer (rememberRecentProject, saveSpawned) or, for the per-project
// casting maps, a leftover from when a session could be dressed on its own —
// still read by characterFor, no longer written by anyone.
const MANAGED = [
  'characterByProject',
  'sizeByProject',
  'characterBySession',
  'sizeBySession',
  'recentProjects',
  'spawnedSessions',
];

// The cast is read from disk so a sprite theme dropped into
// `src/renderer/assets/themes/` can be assigned without touching the code — but
// `allCharacters()` is a readdir plus a JSON parse per pack, and main asks for
// it several times per hook event (the shared buddy's face on every session
// switch, once per settings payload, once per chat turn). The folder only
// changes when a pack is installed, drawn or removed, so it is read once and
// forgotten exactly there.
let castCache = null;
const cast = () => (castCache ||= allCharacters());
const characterIds = () => cast().map((c) => c.id);

/** Read the folder again, and pick the shared buddy's face again with it. */
const forgetFaces = () => {
  castCache = null;
  soloFace = '';
};

const settingsFile = () => path.join(app.getPath('userData'), 'clippy-settings.json');

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    // Only the keys this build still has. A file written by an older one can
    // carry retired settings — `characterMode` and the single `character` it
    // picked, from when you chose *how* buddies were cast — and copying those
    // back in would keep writing them out forever.
    for (const key of Object.keys(settings)) {
      if (Object.hasOwn(saved, key)) settings[key] = saved[key];
    }
  } catch {
    // first run / unreadable -> defaults
  }
}

/**
 * Write the settings file whole, or not at all.
 *
 * Straight into the file meant that a crash, a full disk or a machine losing
 * power mid-write left half a JSON document behind — and half a document is
 * unreadable, so the next start silently reverted to defaults and every pet,
 * size and recent project the user had chosen was gone. Renaming a complete
 * file over the old one cannot end that way: the name always points at one
 * whole document or the other.
 */
function saveSettings() {
  const file = settingsFile();
  const scratch = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(scratch, JSON.stringify(settings, null, 2));
    fs.renameSync(scratch, file);
  } catch (err) {
    console.error('clippy: could not save settings', err);
    try {
      fs.rmSync(scratch, { force: true });
    } catch {
      // A leftover scratch file is untidy, never harmful — it is not the settings.
    }
  }
}

function setSetting(key, value) {
  // Object.hasOwn, not `in`: `'__proto__' in settings` is true of every plain
  // object, and a renderer naming one of those would be writing somewhere that
  // is not a setting at all.
  if (!Object.hasOwn(settings, key)) return;
  // Settings that are a collection rather than one value: they have their own
  // writers, and the Boolean() fallback below would flatten them to `true`.
  if (MANAGED.includes(key)) return;
  if (CHOICES[key]) {
    if (!CHOICES[key]().includes(value)) return;
    settings[key] = value;
  } else {
    settings[key] = Boolean(value);
  }
  saveSettings();
  pushSettingsState();
  sendSettings();
  // A different buddy size is a different window; the renderer will also ask
  // for a new height once it has re-measured, but this keeps the bare buddy
  // from sitting in the wrong box in the meantime.
  if (key === 'size') replaceAll();
  // A different face for the shared buddy is a look, not a rebuild — but the
  // window is holding the old one until it is told.
  if (key === 'soloCharacter') {
    soloFace = ''; // picked again from the new choice
    const solo = buddies.get(SOLO_KEY);
    if (solo && !solo.win.isDestroyed()) {
      solo.character = soloCharacter();
      post(solo, 'clippy-settings', settingsPayload(solo));
    }
  }
}

/**
 * What a renderer gets: the settings plus the rosters it builds menus from, so
 * the cast and the size steps are defined in exactly one place.
 *
 * A buddy is told which character *it* is, which is the only "selected
 * character" the app has. Concurrent sessions in one project are cast apart,
 * so the settings window is handed the sessions and their buddies instead.
 */
function settingsPayload(buddy) {
  return {
    ...settings,
    // A buddy is told its own casting and its own size; the settings window
    // gets the defaults, and reads the per-project maps for the rest.
    ...(buddy
      ? {
          character: buddy.character,
          size: sizeForBuddy(buddy),
          // Is *this* window the one that speaks for everybody? A sandbox
          // buddy has a window of its own and answers no.
          isSolo: buddies.get(SOLO_KEY) === buddy,
        }
      : null),
    characters: cast(),
    sizes: sizeList(),
  };
}

function sendSettings() {
  for (const buddy of buddies.values()) {
    post(buddy, 'clippy-settings', settingsPayload(buddy));
  }
}

/** Re-cast every buddy — a project was given a buddy of its own. */
function recast() {
  const usedByProject = new Map();
  for (const buddy of buddies.values()) {
    const used = usedByProject.get(buddy.name) || [];
    buddy.character = characterFor(settings, buddy.name, buddy.sessionId, used);
    used.push(buddy.character);
    usedByProject.set(buddy.name, used);
  }
}

/**
 * The window that holds nothing but the buddy, at the size that project picked.
 *
 * Takes a buddy rather than reading the one global setting, because size is per
 * project now: two sessions side by side can be XS and large at once.
 */
function compactSize(buddy) {
  return SIZES[sizeForBuddy(buddy)].win;
}

/** The shared buddy has its own optional size; a sandbox buddy is per-session. */
function sizeForBuddy(buddy) {
  return sizeFor(settings, buddy?.name || '', buddy?.sessionId || '');
}

/** Re-lay every buddy — the size setting changed under them. */
function replaceAll() {
  for (const buddy of buddies.values()) {
    if (!buddy.win.isDestroyed()) placeBuddy(buddy, buddy.mode || 'compact');
  }
}

/* ---------------- Settings window ---------------- */

let settingsWin = null;
let newAgentWin = null; // the "start an agent somewhere" form (see openNewAgentWindow)

/**
 * The window behind the 📎 in the menu bar: who the buddies are, what they cost
 * you in tokens, and what they do with a session. A normal window — this is the
 * one part of Clippy you sit and read. The on/off switches stay in the tray's
 * Quick settings, where they're reachable without opening anything.
 */
function openSettingsWindow(section) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    if (section) settingsWin.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#${section}`)};`);
    return settingsWin;
  }

  // Kept in a local as well as the module slot: the window can be closed (and
  // another opened) before it is ready to show, and a listener reaching back
  // through the slot would then show whichever window is there now.
  const win = new BrowserWindow({
    width: 940,
    height: 700,
    minWidth: 720,
    minHeight: 480,
    title: 'Clippy',
    titleBarStyle: 'hiddenInset', // the rail is the title bar
    backgroundColor: '#101217',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWin = win;
  win.loadFile(
    path.join(__dirname, 'renderer', 'settings.html'),
    section ? { hash: section } : undefined
  );
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    if (settingsWin === win) settingsWin = null;
  });
  return win;
}

/**
 * Tray-click behaviour only: the 📎 works like a switch — one click opens
 * settings, the next closes them. Every other entry point (right-click menu,
 * deep links into a section) still plainly opens.
 */
function toggleSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed() && settingsWin.isVisible()) {
    settingsWin.close();
    return;
  }
  openSettingsWindow();
}

/**
 * Where macOS thinks this app lives. Running from source that's Electron's own
 * bundle — which is why the Accessibility list says "Electron" and not
 * "Clippy", and why nobody can find it.
 */
function appBundlePath() {
  const exe = app.getPath('exe');
  const bundle = exe.indexOf('.app/Contents/MacOS/');
  return bundle === -1 ? exe : exe.slice(0, bundle + 4);
}

/** Download, verify, and stage a release before the helper replaces this app. */
async function installLatestUpdate() {
  if (installingUpdate) return { ok: false, error: 'An update is already being prepared.' };
  const root = path.join(__dirname, '..');
  const info = await checkForUpdates(root);
  if (info.source !== 'packaged') return { ok: false, error: 'Updates install automatically only from the DMG app.' };
  if (info.upToDate === true) return { ok: false, error: 'This is already the newest release.' };
  if (!info.release?.dmg || !info.release?.checksum) {
    return { ok: false, error: 'The newest release is missing its verified installer.' };
  }

  installingUpdate = true;
  try {
    const staged = await prepareInstall({ release: info.release, destination: appBundlePath() });
    launchInstall(staged.helper);
    // Let the renderer receive the success response before the updater starts
    // waiting on this process. The helper reopens Clippy after replacement.
    setTimeout(() => app.quit(), 250);
    return { ok: true, version: info.release.version };
  } catch (err) {
    return { ok: false, error: err.message || 'The update could not be installed.' };
  } finally {
    installingUpdate = false;
  }
}

/**
 * A packaged DMG build checks once shortly after launch, then daily. It only
 * fetches GitHub's small release record; the large installer is downloaded
 * only after the user presses Install and relaunch in Settings.
 */
async function checkForAutomaticUpdate() {
  const root = path.join(__dirname, '..');
  if (localBuild(root).source !== 'packaged') return;
  const info = await checkForUpdates(root);
  if (info.upToDate !== false || !info.release?.dmg || !info.release?.checksum) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: '📎 Clippy update ready',
    body: `v${info.release.version} is ready to install. Click to verify and relaunch.`,
    silent: true,
  });
  n.on('click', () => openSettingsWindow('updates'));
  n.show();
}

/** Everything the settings window draws itself from. */
function settingsState() {
  return {
    ...settingsPayload(),
    port: PORT,
    // Which copy of Clippy this is — the Updates section's offline half.
    build: localBuild(path.join(__dirname, '..')),
    // Can we raise other apps' windows? Everything about perching depends on it.
    windowAccess: canDriveWindows(),
    appName: path.basename(appBundlePath(), '.app'),
    appPath: appBundlePath(),
    // The shared buddy, for the row that stands in for it in Sessions. Its
    // face and name are worked out here because "Auto" means a casting rule
    // the settings window has no way to run for itself.
    solo: {
      character: soloCharacter(),
      pet: petNameFor(SOLO_KEY),
      color: identityFor(SOLO_KEY, 'clippy').color,
      // Who it is speaking for at the moment, if anyone.
      showing: buddies.get(SOLO_KEY)?.name || '',
    },
    sessions: tracker.list().map((s) => ({
      sessionId: s.sessionId,
      name: s.name,
      agent: s.agent,
      color: identityFor(s.sessionId, s.name).color,
      status: s.status,
      character: buddyOf(s.sessionId)?.character || characterFor(settings, s.name, s.sessionId),
      // The helpers this session has running, listed under it.
      subagents: (s.subagents || []).map((sub) => ({
        id: sub.id,
        type: sub.type,
        label: sub.activity?.label || '',
      })),
    })),
  };
}

function pushSettingsState() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('clippy-settings-state', settingsState());
  }
}

/* ---------------- One Clippy for every session ---------------- */

// key -> { win, slot, name, sessionId, pinned }. Every session that reports in
// lands in the one shared window, under SOLO_KEY: it wears the name, colour and
// character of whichever agent it is speaking for, so "approve", "go to
// terminal" and the token panel act on the agent you are looking at. Its
// `sessionId` is therefore not fixed — it is whoever it is showing right now.
// The sandbox is the exception: those keys get a window each (see sharesWindow).
const buddies = new Map();

/**
 * The buddy showing `key`.
 *
 * Falls back to the shared window so that every per-session lookup keeps
 * working without each of them having to know there is only one window.
 */
function buddyOf(key) {
  if (!key) return null;
  return buddies.get(key) || (sharesWindow(key) ? buddies.get(SOLO_KEY) || null : null);
}

/**
 * Bottom-right first, then leftwards, wrapping onto a row above. Windows are
 * anchored by their bottom-right corner: the bottom keeps his feet on the same
 * line, and the right edge is what lets a 268px panel open at all down here —
 * a paperclip tucked into the corner has nowhere near half a panel's width of
 * screen to his right, so the panel has to grow leftwards and he slides with
 * it. Preserving his centre instead (the way `draggedSpot` does, where the spot
 * is arbitrary and there is room on both sides) would mean parking the idle
 * buddy ~80px in from the corner he is meant to tuck into, which is a worse
 * trade than a shift while a card is open. The perch in `dockPosition` hugs the
 * terminal's own top-right corner for the same reason.
 */
function cornerBounds(slot, width, height) {
  const { workArea } = screen.getPrimaryDisplay();
  const perRow = Math.max(1, Math.floor(workArea.width / (WIN_W + WIN_GAP)));
  const col = slot % perRow;
  const row = Math.floor(slot / perRow);
  const right = workArea.x + workArea.width - WIN_GAP - col * (WIN_W + WIN_GAP);
  const bottom = workArea.y + workArea.height - WIN_GAP - row * ROW_STEP;
  // A tall card must not push the window off the top of the screen — that's
  // what used to cut the head off long plans on a short display.
  return { x: right - width, y: Math.max(workArea.y, bottom - height) };
}

/**
 * A buddy's default spot on screen: the classic bottom-right corner stack,
 * unless "Organize buddies" has made an edge the house style — then new (and
 * un-dragged) buddies file along that edge instead, until you pick another.
 */
function homeBounds(slot, width, height) {
  const edge = settings.arrangeEdge;
  if (!edge) return cornerBounds(slot, width, height);
  const { workArea } = screen.getPrimaryDisplay();
  // Slots step by the full panel width along horizontal edges (so an open card
  // never lands on the neighbour) and by the compact height along vertical
  // ones — the same pitches cornerBounds uses for its columns and rows.
  // The pitch is the default size's, not any one buddy's: a lineup has to be
  // evenly spaced, and sizes now vary from project to project.
  const [, compactH] = compactSize();
  const step = edge === 'top' || edge === 'bottom' ? WIN_W + WIN_GAP : compactH + WIN_GAP;
  return edgeHome(workArea, edge, slot, { width, height }, WIN_GAP, step);
}

/**
 * "Organize buddies" from the tray: line the buddies up along one edge of the
 * screen, evenly spaced, and remember the edge as the default spot for new
 * ones. Perched (docked) buddies are left alone — a perch tracks the terminal
 * window its session lives in, and yanking it to a screen edge would undo the
 * follow-the-window behaviour the user (or autoPerch) asked for. Only the
 * free-floating buddies fall in.
 */
function organizeBuddies(edge) {
  settings.arrangeEdge = edge;
  saveSettings();
  const free = [...buddies.values()].filter((b) => !b.dock && !b.win.isDestroyed());
  // Spots are laid out on the default footprint so the row stays evenly
  // spaced; each buddy is then parked on its spot at its *own* size.
  const [width, height] = compactSize();
  const { workArea } = screen.getPrimaryDisplay();
  const spots = edgeLineup(workArea, edge, free.length, { width, height }, WIN_GAP);
  free.forEach((buddy, i) => {
    stopWalking(buddy); // the lineup owns the window now, not the stroll
    // From here the lineup spot outranks the corner, exactly like a hand move:
    // cards and menus grow around it instead of snapping back.
    buddy.dragged = true;
    rehome(buddy); // a lineup is an explicit "stand here", not a resize
    const [ownW, ownH] = compactSize(buddy);
    // Park the compact footprint on the spot, then let placeBuddy re-grow any
    // open card around it — same as a card opening over a hand-placed buddy.
    setBuddyBounds(buddy, { ...spots[i], width: ownW, height: ownH });
    placeBuddy(buddy, buddy.mode || 'compact');
  });
}

/**
 * The one door in and out of moving a buddy's window. `lastPlaced` is what
 * tells the `moved` listener a bounds change was ours, not your hand on the
 * paperclip — so every programmatic move, including mid-walk, has to go
 * through here to keep that in sync.
 */
function setBuddyBounds(buddy, bounds) {
  buddy.win.setBounds(bounds);
  // Record where the window *landed*, not where it was sent. macOS nudges a
  // window that would hang off a display, and comparing against the ask made
  // the difference look like the user had dragged him — which then pinned him
  // to a spot he never chose.
  const [x, y] = buddy.win.getPosition();
  buddy.lastPlaced = { x, y };
  sendSide(buddy);
}

/**
 * Which half of its display a buddy is standing on.
 *
 * A buddy at rest turns to face inward — one standing on the left edge looking
 * further left has his back to everything you care about — and only main can
 * see where the window actually is, so it does the looking and the renderer
 * does the turning.
 */
function sideOfScreen(buddy) {
  const bounds = buddy.win.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  return bounds.x + bounds.width / 2 < workArea.x + workArea.width / 2 ? 'left' : 'right';
}

/**
 * Tell a buddy which side it is on — but only when the answer changes, because
 * this rides along with every frame of a stroll and every pixel of a drag.
 */
function sendSide(buddy) {
  if (!buddy || buddy.win.isDestroyed()) return;
  const side = sideOfScreen(buddy);
  if (side === buddy.side) return;
  buddy.side = side;
  send(buddy, { kind: 'side', side });
}

/**
 * Where a hand-dragged buddy grows from: his own centre line and his bottom
 * edge — so a card or the menu opening never yanks him back to the corner or
 * the perch he was moved away from, it just grows around wherever he is.
 *
 * The buddy is drawn centred in his window, so it has to be the centre and not
 * the left edge: anchoring the left edge held the *glass* still and slid the
 * paperclip half the growth (~80px) to the right every time the window went
 * from paperclip to panel width, which is exactly what you saw when the
 * right-click menu opened under a buddy you'd moved by hand. Only the clamps
 * still move him, and only far enough to keep a wide panel on screen.
 */
function draggedSpot(buddy, width, height, workArea) {
  const current = buddy.win.getBounds();
  const centre = current.x + current.width / 2;
  const bottom = current.y + current.height;
  // Clamped on the buddy, not the window: see keepBuddyOnScreen. Clamping the
  // window here is what stopped him reaching the top of the screen.
  return keepBuddyOnScreen(
    { x: Math.round(centre - width / 2), y: Math.round(bottom - height), width, height },
    workArea,
    buddy
  );
}

function nextFreeSlot() {
  const taken = new Set([...buddies.values()].map((b) => b.slot));
  let slot = 0;
  while (taken.has(slot)) slot++;
  return slot;
}

/**
 * The window for a session, created on first sight. Each one carries its own
 * identity (name + colour) so you can tell your agents apart at a glance.
 *
 * `identityKey` is what the colour and the pet name are derived from, and it
 * defaults to the buddy's key — which is right for a watched session, whose key
 * never changes. A session Clippy spawned is keyed by its tmux name until a
 * hook tells us its real session id, so it passes the tmux name here and keeps
 * the same face across that change, and across a restart.
 */
function buddyFor(key, name = '', agent = '', identityKey = key) {
  // Every session lands in the same window; `key` still says which session
  // this is *about*, and wearIdentity below makes the window look like it.
  const windowKey = windowKeyFor(key);
  const existing = buddies.get(windowKey);
  if (existing) {
    if (windowKey !== key) {
      wearIdentity(existing, key, name, agent);
      return existing;
    }
    if (name && name !== existing.name) {
      existing.name = name;
      post(existing, 'clippy-identity', { name });
    }
    if (agent && agent !== existing.agent) existing.agent = agent;
    return existing;
  }

  const slot = nextFreeSlot();
  // No buddy object yet, but its name and session id are what a size is kept
  // against, and this window is created at that size.
  const [compactW, compactH] = compactSize({ name, sessionId: key });
  const { x, y } = homeBounds(slot, compactW, compactH);
  const identity = identityFor(sharesWindow(key) ? SOLO_KEY : identityKey, name);
  const win = new BrowserWindow({
    width: compactW,
    height: compactH,
    x,
    y,
    // Clippy lives out of sight: the window is only revealed when this session
    // finishes a turn or asks the user something (see windowActionFor).
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: {
      session: key,
      name: identity.name,
      color: identity.color,
      agent: agent || 'claude',
      // The shared window is named after itself, not after whichever session
      // happened to open it — petNameOf says the same thing once it exists.
      pet: petNameFor(sharesWindow(key) ? SOLO_KEY : identityKey),
    },
  });
  // CLIPPY_SANDBOXTOOLS=1 npm start opens an inspector per buddy, detached so it
  // never fights the transparent always-on-top window for space — the fast
  // way to iterate on the cards/menu/bubble without a real Claude Code turn.
  if (process.env.CLIPPY_SANDBOXTOOLS) win.webContents.openDevTools({ mode: 'detach' });

  // Everything said to this window goes through here, so that saying it before
  // the page is listening is not the same as not saying it. See src/outbox.js:
  // a window is created and told about a held card in the same tick, and that
  // card used to be dropped on the floor.
  const outbox = createOutbox({
    send: (channel, payload) => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    },
    onDrop: (n) => console.warn(`clippy: dropped ${n} message(s) for a window that never loaded`),
  });

  win.webContents.on('did-finish-load', () => {
    const loaded = buddies.get(windowKey);
    // The shared window is often re-dressed for another session before it has
    // finished loading, and the query string it was opened with is then a
    // session ago. Whoever it is wearing now is who it should look like.
    if (loaded && loaded.sessionId !== key) sendIdentity(loaded);
    // Which way to face when there is nothing else to say.
    if (loaded) {
      loaded.side = null;
      sendSide(loaded);
    }
    outbox.open();
  });
  // A reload (a crash recovery, a devtools refresh) means the page that was
  // listening is on its way out; hold anything said in between for the new one.
  win.webContents.on('did-start-loading', () => outbox.close());
  win.on('closed', () => {
    buddies.get(windowKey)?.dock?.poll?.cancel();
    buddies.delete(windowKey);
  });
  // Every reposition we do ourselves goes through placeBuddy, which records
  // exactly where it put the window. A `moved` that lands anywhere else is
  // you dragging him by hand — from then on his own spot outranks the corner
  // or the perch anchor, until you explicitly ask him to go somewhere (go to
  // terminal, unperch).
  win.on('moved', () => {
    const b = buddies.get(windowKey);
    if (!b) return;
    const [x, y] = win.getPosition();
    const placed = b.lastPlaced;
    if (placed && x === placed.x && y === placed.y) return;
    b.dragged = true;
    // Carried by hand: wherever he was put is where he now lives, so the
    // anchor follows rather than pulling him back.
    const dragged = anchorPointOf(b, { ...win.getBounds(), x, y });
    if (dragged) b.anchorAt = dragged;
  });

  const buddy = {
    win,
    out: outbox,
    slot,
    name: identity.name,
    sessionId: key,
    // Bumped by every show/hide request. An async perch that resolves after
    // something else has changed its mind checks this before putting a window
    // on screen — see showBuddy.
    visibilityTurn: 0,
    // Which session this window is currently wearing. Equal to sessionId for a
    // sandbox buddy's own window, and moved by wearIdentity otherwise.
    showing: key,
    identityKey,
    agent: agent || 'claude',
    pinned: false,
    dock: null,
    dragged: false, // moved by hand — placeBuddy grows around that spot instead
    lastPlaced: { x, y }, // matches the constructor's own placement, above
    // Cast once, when this session first reports in, and only re-cast when you
    // give the project a buddy by hand.
    // The shared buddy wears one face whoever it speaks for; a per-session
    // buddy is cast against its siblings so two agents in one project differ.
    character: sharesWindow(key)
      ? soloCharacter()
      : characterFor(
          settings,
          identity.name,
          key,
          [...buddies.values()]
            .filter((other) => other.name === identity.name)
            .map((other) => other.character)
        ),
  };
  buddies.set(windowKey, buddy);
  // Said now rather than from the load handler, so that everything this window
  // needs in order to look right is already ahead of the first card in the
  // queue. Before the outbox these had to wait for did-finish-load, which is
  // also why a card sent in this same tick had nothing to arrive behind.
  primeWindow(buddy, key);
  pushSettingsState();
  return buddy;
}

/**
 * What a brand-new window needs to know before anything happens in it: how it
 * looks, whether there is somewhere to send the user, and whose session it is.
 */
function primeWindow(buddy, key) {
  post(buddy, 'clippy-settings', settingsPayload(buddy));
  sendCanOpen(buddy, key);
  // A buddy whose session Clippy started wears a mark, so "mine" and "one I
  // happened to notice" are not the same thing at a glance.
  const owned = tmuxRecordFor(key);
  if (owned) {
    send(buddy, { kind: 'ownership', owned: true, host: owned.host, tmux: owned.name });
  }
}

/**
 * Tell a window whether there is anywhere to send the user, and what to call
 * it. "go to terminal" is the wrong noun for a session in the ChatGPT app or
 * one in a tmux pane, and the button is the one thing on a card that moves you
 * somewhere — so the label travels with the fact rather than being guessed in
 * the renderer.
 */
function sendCanOpen(buddy, key) {
  const source = sourceFor(key);
  send(buddy, {
    kind: 'can-open',
    // Named so a card already on screen can tell whether this is about *it*:
    // resolving the owning app takes a moment, so the first card of a session
    // is often built before we know what to call the place it came from.
    sessionId: key,
    value: Boolean(tracker.terminalFor(key) || tmuxRecordFor(key)),
    source: { kind: source.kind, name: source.name, goLabel: source.goLabel },
  });
}

/**
 * Where this session lives, in words. Resolving the owning app means a walk up
 * the process table, so the answer is kept on the session's terminal record —
 * it cannot change without the terminal record changing too.
 */
function sourceFor(key) {
  const term = tracker.terminalFor(key);
  return describeSource({
    program: term?.program || '',
    app: term?.app || null,
    tmux: tmuxRecordFor(key),
  });
}

/**
 * Make the shared window wear one session's face.
 *
 * Only when the session actually changes — the two pushes below re-cast the
 * artwork and re-letter the name plate, which is not something to do on every
 * tool event. Identity goes first because the clip sprites are drawn per
 * session colour, so the character has to be applied against the colour it is
 * about to wear.
 */
function wearIdentity(buddy, sessionId, name = '', agent = '') {
  if (buddy.showing === sessionId) return buddy;
  buddy.showing = sessionId;
  // What "this buddy" means for approve, go-to-terminal and the token panel:
  // the agent it is speaking for right now.
  buddy.sessionId = sessionId;
  const label = name || tracker.cwdFor(sessionId).split('/').pop() || buddy.name;
  buddy.name = label;
  if (agent) buddy.agent = agent;
  // The manager keeps its own face. One buddy you learn the look of beats a
  // paperclip that turns into a fox mid-sentence; which agent it is speaking
  // for is said by the name plate and by the card, in words.
  buddy.character = soloCharacter();

  // A window that hasn't finished loading drops anything sent to it, and the
  // shared one is routinely re-dressed in the same tick it was created. The
  // did-finish-load handler replays this, so skipping here is not skipping.
  if (!buddy.win.isDestroyed() && !buddy.win.webContents.isLoading()) sendIdentity(buddy);

  // A session arriving makes no new window, so the settings window would
  // otherwise never hear about it: every other push happens on the creation
  // path this deliberately skips.
  pushSettingsState();
  return buddy;
}

/** Tell a window which session it is wearing: name, colour, pet, and artwork. */
function sendIdentity(buddy) {
  const solo = buddies.get(SOLO_KEY) === buddy;
  // The shared buddy is one character with one name and one colour, whoever it
  // happens to be speaking for; a per-session buddy *is* its session.
  const identityKey = solo ? SOLO_KEY : buddy.sessionId;
  const identity = identityFor(identityKey, buddy.name);
  post(buddy, 'clippy-identity', {
    // The plate's big line is who you are talking to; underneath it, `name` is
    // the project it is telling you about.
    name: buddy.name,
    color: solo ? identityFor(SOLO_KEY, 'clippy').color : identity.color,
    agent: buddy.agent,
    pet: petNameOf(buddy),
  });
  // Colour first, then artwork: the clips are drawn per session colour.
  post(buddy, 'clippy-settings', settingsPayload(buddy));
}

/**
 * The buddy's own name.
 *
 * The shared buddy is one animal with one name whoever it is speaking for, so
 * it is named after the shared window rather than after the session it happens
 * to be wearing. Everything that shows a pet name has to agree, or the plate
 * and the chat end up introducing two different creatures.
 */
function petNameOf(buddy) {
  if (!buddy) return '';
  if (buddies.get(SOLO_KEY) === buddy) return petNameFor(SOLO_KEY);
  return petNameFor(buddy.identityKey || buddy.sessionId);
}

/**
 * The face the shared buddy wears: the one you chose, or Clippy's own pick.
 *
 * Held rather than worked out each time. It does not depend on which session
 * the window is speaking for, but `wearIdentity` asked for it on every switch —
 * and the automatic pick walks the cast, which reads the themes folder off the
 * disk. It is dropped by `forgetFaces` wherever the answer could change: the
 * choice itself, the cast, or an assignment.
 */
let soloFace = '';
function soloCharacter() {
  if (soloFace) return soloFace;
  const chosen = settings.soloCharacter;
  const ids = characterIds();
  // Nothing picked: the app is named after the paperclip, so that is who the
  // one buddy is — not whichever face the cast happens to hash to.
  soloFace =
    chosen && ids.includes(chosen)
      ? chosen
      : ids.includes('clip')
        ? 'clip'
        : characterFor(settings, 'clippy', SOLO_KEY);
  return soloFace;
}

/** Which buddy does this renderer belong to? */
function buddyForSender(sender) {
  const win = BrowserWindow.fromWebContents(sender);
  return [...buddies.values()].find((b) => b.win === win) || null;
}

/**
 * Send an event to one session's Clippy, creating its window if needed.
 *
 * Every event carries where it came from, because a single window shows cards
 * from several agents: the card has to say whose it is, and the button on it
 * has to name the app *that* session lives in rather than whichever one the
 * window happened to hear about last.
 */
function sendTo(sessionId, event) {
  if (!sessionId) return null;
  const buddy = buddyFor(sessionId, event?.name, event?.agent);
  const source = sourceFor(sessionId);
  send(buddy, {
    ...event,
    sessionId,
    source: { kind: source.kind, name: source.name, goLabel: source.goLabel },
  });
  return buddy;
}

function closeBuddy(key) {
  const buddy = buddyOf(key);
  if (!buddy) return;
  forgetAttentionForSession(key);
  unwatchSpawned(key);
  // The quiet window only expires when something asks about it again, which a
  // finished session never does — so it is dropped with the session instead of
  // sitting in the map for the life of the app.
  justAnswered.delete(key);

  // The shared window belongs to every session, so one of them ending is not
  // a reason to take it away — it stays for the others and simply stops
  // wearing this one's face. It only goes when the last session does.
  if (buddies.get(SOLO_KEY) === buddy) {
    const survivor = successorFor(tracker.list(), key);
    if (survivor) {
      if (buddy.showing === key) wearIdentity(buddy, survivor.sessionId, survivor.name, survivor.agent);
      pushSettingsState();
      return;
    }
    buddies.delete(SOLO_KEY);
  } else {
    buddies.delete(key);
  }

  buddy.dock?.poll?.cancel();
  if (!buddy.win.isDestroyed()) buddy.win.destroy();
  pushSettingsState();
}

/**
 * Pop a Clippy up without stealing focus from the terminal. `pin` marks the
 * window as one the user asked to see (tray, Drive mode), so the ambient
 * hide-again rules leave it alone until they hide it themselves.
 */
function showBuddy(key, { pin = false, mode = 'full' } = {}) {
  const buddy = buddyOf(key);
  if (!buddy || buddy.win.isDestroyed()) return;
  const turn = ++buddy.visibilityTurn;
  if (pin) buddy.pinned = true;
  if (!buddy.win.isVisible() && settings.appearanceSound) {
    // The outbox holds this until the page can hear it, so a window that has
    // only just been created still gets its entrance rather than a silent one.
    send(buddy, { kind: 'appearance', sound: settings.appearanceSound });
  }

  // Perched or not, Clippy is a small paperclip until there's a card or a
  // message to read — then the window grows around him.
  if (buddy.dock || !settings.autoPerch || buddy.win.isVisible() || !tracker.terminalFor(key)) {
    placeBuddy(buddy, mode);
    buddy.win.showInactive();
    return;
  }

  // Appear on the window this session actually lives in rather than the corner
  // of the screen. Measuring the window takes a moment, so show it there in one
  // move instead of popping up first and jumping afterwards; if we can't find
  // the window (old hooks, no permission), fall back to the corner.
  perchOn(key, { auto: true, mode }).then((perched) => {
    // Measuring a window takes long enough for the answer to arrive after
    // someone changed their mind — the user hid this buddy, the card was
    // answered in the terminal, the session ended. Showing it now would be a
    // window appearing for a reason that has already passed, which is exactly
    // the "it pops up out of nowhere" complaint.
    if (perched || buddy.win.isDestroyed() || buddy.visibilityTurn !== turn) return;
    placeBuddy(buddy, mode);
    buddy.win.showInactive();
  });
}

/** Slip back out of sight once the moment has passed. */
function hideBuddy(key, { unpin = false, lookedAway = false } = {}) {
  const buddy = buddyOf(key);
  if (!buddy || buddy.win.isDestroyed()) return;
  // Whatever a perch measurement in flight was going to do, this outranks it.
  buddy.visibilityTurn++;
  if (unpin) {
    buddy.pinned = false;
    undock(buddy);
    buddy.win.hide();
    return;
  }
  // Something on this window is still waiting on the user — a held card, a
  // review, a nudge — and every session shares the window, so it may be
  // another agent's. Ambient chatter from one agent must not put away what
  // another is asking; the user looking away after dealing with it may.
  if (!lookedAway && windowHasBusiness(key)) return;
  if (buddy.dock && !buddy.dock.auto) {
    placeBuddy(buddy, 'compact'); // asked-for perch: stays, just gets smaller
    return;
  }
  if (buddy.dock) undock(buddy); // came for a card of its own accord — leave
  if (buddy.pinned) {
    placeBuddy(buddy, 'compact'); // kept on screen by hand: shrink back down
    return;
  }
  buddy.win.hide();
}

/**
 * Size and place a buddy: a bare paperclip ('compact') or the full window with
 * room for cards ('full'), either on its perch or in its corner of the screen.
 *
 * The renderer measures what its contents actually need and passes it as
 * `wantHeight`; a plan or a long diff is much taller than a one-line approval,
 * and a fixed window either cut them off or left a lot of empty glass. Main
 * still owns the geometry, so the ask is clamped to something that fits on the
 * display. `wantWidth` is the same deal sideways — only the plan card asks for
 * it, and 0 means "back to the usual width".
 */
function placeBuddy(buddy, mode, wantHeight, wantWidth) {
  if (buddy.win.isDestroyed()) return;
  // Mid-stroll the walk owns the window's position; whoever wants it back
  // calls stopWalking first. Remember what was asked for, though — a card
  // arriving mid-walk still needs its room, and stopWalking replays this.
  if (buddy.walk) {
    buddy.walk.missedPlacement = { mode, wantHeight, wantWidth };
    return;
  }
  buddy.mode = mode;
  // The two modes have their own measured heights: a full window is as tall as
  // its card, a compact one as tall as the buddy and his name plate.
  if (Number.isFinite(wantHeight) && wantHeight > 0) {
    if (mode === 'compact') buddy.compactHeight = wantHeight;
    else buddy.wantHeight = wantHeight;
  }
  // Unlike the height, an explicit 0 resets the width: the wide window belongs
  // to the plan card and goes away with it.
  if (Number.isFinite(wantWidth)) buddy.wantWidth = wantWidth > 0 ? wantWidth : 0;
  const compact = mode === 'compact';
  const [compactW, compactH] = compactSize(buddy);
  const workArea = buddy.dock
    ? screen.getDisplayMatching(buddy.dock.bounds).workArea
    : screen.getPrimaryDisplay().workArea;
  const width = compact
    ? compactW
    : Math.round(
        Math.min(Math.max(WIN_W, buddy.wantWidth || WIN_W), workArea.width - WIN_GAP * 2)
      );
  const height = compact
    ? // The configured compact size is a safe fallback, not a clipping ceiling.
      // The renderer includes the selected art, name plate, and controls in its
      // measurement; preserve all of it unless the display itself is shorter.
      Math.round(
        Math.min(
          workArea.height - WIN_GAP * 2,
          Math.max(compactH, buddy.compactHeight || compactH)
        )
      )
    : Math.round(
        // A full window is never smaller than the bare buddy needs.
        Math.max(compactH, Math.min(buddy.wantHeight || WIN_H, workArea.height - WIN_GAP * 2))
      );

  const spot = buddy.dragged
    ? draggedSpot(buddy, width, height, workArea)
    : buddy.dock
    ? dockPosition(
        buddy.dock.bounds,
        width,
        height,
        screen.getDisplayMatching(buddy.dock.bounds).workArea
      )
    : homeBounds(buddy.slot, width, height);

  setBuddyBounds(buddy, holdTheBuddyStill(buddy, { ...spot, width, height }, workArea));
  send(buddy, { kind: 'dock', docked: Boolean(buddy.dock), compact });
}

/**
 * Grow the window around the buddy, instead of taking him with it.
 *
 * The window is much wider with a panel open than without one — 342px against
 * 190 — and it used to be anchored by an edge, so opening anything slid the
 * buddy 76px sideways. He jumped out from under the pointer that had just
 * clicked him, hover and leave fired in the wake of it, and the whole thing
 * read as the app twitching rather than answering.
 *
 * So the fixed point is *him*, not a corner of the window: the renderer says
 * where he stands inside the layout it just measured (`anchorIn`), and
 * whatever the placement rules picked is shifted so that point lands where he
 * already was. The window may end up further left, right, up or down; he does
 * not move at all.
 *
 * The first placement has nothing to hold still — that is when his spot is
 * decided — and an explicit move (a drag, a perch, "organize") is a request
 * to put him somewhere else, so both re-anchor rather than resist.
 */
/**
 * Where the buddy's middle sits inside a window of this size.
 *
 * The renderer reports offsets rather than a point (see buddyAnchor in
 * clippy.js) — an offset from the centre, and a height above the foot of the
 * content — because at the moment it measures, the resize it is asking for
 * has not happened. Resolving them here, against the size actually chosen, is
 * the whole trick. One function so the two callers cannot drift apart, which
 * they promptly did the first time this was written twice.
 */
function anchorInside(buddy, size) {
  if (!buddy?.anchorIn) return null;
  return {
    x: size.width / 2 + buddy.anchorIn.dx,
    y: size.height - buddy.anchorIn.fromBottom,
  };
}

/**
 * Keep the *buddy* inside the work area — not the window he stands in.
 *
 * The window is much taller than he is, and because the stage is bottom-aligned
 * that slack sits above his head: invisible, but it is what a clamp on the
 * window's top edge actually stops. So dragging him upwards halted with his
 * head some way below the menu bar, by a margin that changed with his size and
 * with whatever the renderer last measured — which is why it read as
 * "sometimes I can move him higher".
 *
 * Clamping on his own box lets the window hang above the work area while he
 * himself stays on screen, which is the thing anybody actually cares about.
 * Falls back to clamping the window when we have not been told his size yet.
 */
function keepBuddyOnScreen(bounds, workArea, buddy) {
  const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)));
  const inside = anchorInside(buddy, bounds);

  /**
   * Where this edge may sit, on one axis.
   *
   * The window comes first: it holds the card, and half a card off the side of
   * the display is unreadable. Clamping on the *buddy* instead — which is what
   * this did at first, so he could be carried right up to the menu bar — let a
   * 542px window sit 223px off the left edge with most of the panel outside the
   * screen. He is 96px wide and the window around him five times that.
   *
   * He still reaches the top: the dead space that used to sit above his head (a
   * hidden button row, and slack meant for a panel's shadow) is gone, so the
   * window's own top edge is now a pixel above him and clamping the window puts
   * him against the menu bar anyway.
   *
   * Only when the window cannot fit at all does the buddy set the limit — then
   * something must hang off, and he is the part worth keeping, because he is
   * how you reach any of it.
   */
  const fit = (pos, size, start, span, centre, half) => {
    const lo = start;
    const hi = start + span - size;
    if (lo <= hi) return clamp(pos, lo, hi);
    if (!Number.isFinite(centre) || !half) return Math.round(lo);
    return clamp(pos, start - (centre - half), start + span - (centre + half));
  };

  return {
    ...bounds,
    x: fit(bounds.x, bounds.width, workArea.x, workArea.width, inside?.x, buddy.anchorIn?.halfW),
    y: fit(bounds.y, bounds.height, workArea.y, workArea.height, inside?.y, buddy.anchorIn?.halfH),
  };
}

/** Where he is standing on screen, for a window at these bounds. */
function anchorPointOf(buddy, bounds) {
  const inside = anchorInside(buddy, bounds);
  return inside ? { x: Math.round(bounds.x + inside.x), y: Math.round(bounds.y + inside.y) } : null;
}

function holdTheBuddyStill(buddy, bounds, workArea) {
  const inWindow = anchorInside(buddy, bounds);
  if (!inWindow) return bounds;
  const where = (b) => anchorPointOf(buddy, { ...b, width: bounds.width, height: bounds.height });
  if (!buddy.anchorAt || buddy.rehome) {
    buddy.rehome = false;
    buddy.anchorAt = where(bounds);
    return bounds;
  }

  const shifted = keepBuddyOnScreen(
    {
      ...bounds,
      x: Math.round(buddy.anchorAt.x - inWindow.x),
      y: Math.round(buddy.anchorAt.y - inWindow.y),
    },
    workArea,
    buddy
  );
  // Clamping at a screen edge means he could not stay exactly where he was;
  // remember where he actually ended up, or every later resize would keep
  // trying to drag him back off the display.
  buddy.anchorAt = where(shifted);
  return shifted;
}

/** The next placement decides his spot afresh, rather than preserving it. */
function rehome(buddy) {
  if (buddy) buddy.rehome = true;
}

/* ---------------- Perching on a session's terminal window ---------------- */

/**
 * Park Clippy on the top-right corner of the window its session runs in, and
 * follow that window while it's there.
 *
 * `raise` brings the terminal to the front too — that's the "go to terminal"
 * button. Without it we only *measure* the window, which is how a buddy can
 * pop up on the right screen without stealing focus from whatever you're doing.
 *
 * @returns {Promise<boolean>} did we manage to perch?
 */
async function perchOn(key, { raise = false, auto = false, mode = null } = {}) {
  const buddy = buddyOf(key);
  if (!buddy || buddy.win.isDestroyed()) return false;

  // A detached tmux pane has no window to sit on. Said out loud only when the
  // user asked; the automatic perch just declines.
  if (tmuxRecordFor(key)) {
    if (!auto) {
      tellBuddy(key, `“${buddy.name}” runs in tmux — there's no window to perch on, but you can attach one.`);
    }
    return false;
  }

  // Already perched: a "go to terminal" click just raises the window again.
  if (buddy.dock) {
    if (raise) {
      buddy.dock.auto = false; // now it's a perch you asked for
      buddy.pinned = true;
      buddy.dragged = false; // "go to terminal" means go back to the perch
      const { bounds } = await revealTarget(buddy, key);
      if (bounds) {
        buddy.dock.bounds = bounds;
        placeBuddy(buddy, buddy.mode || 'compact');
      } else {
        // The perch is riding a window we can no longer raise — let go and try
        // again from scratch rather than pretending the click did something.
        undock(buddy);
        return perchOn(key, { raise, auto, mode });
      }
    }
    return true;
  }

  const term = tracker.terminalFor(key);
  if (!term) {
    if (!auto) {
      tellBuddy(
        key,
        "I don't know which window this session is in. Re-run `npm run hooks:install`, " +
          'then restart that Claude Code session so its hooks report the terminal.',
        { sticky: true }
      );
    }
    return false;
  }

  if (!canDriveWindows()) {
    if (!auto) askForWindowAccess(key);
    return false;
  }

  try {
    const { bounds } = raise ? await revealTarget(buddy, key) : await measureTarget(buddy, key);
    if (!bounds) {
      if (!auto) {
        // The app is running but shows no windows at all — either it really has
        // none, or macOS is quietly withholding them from us.
        const appPid = buddy.target?.app?.pid;
        tellBuddy(
          key,
          appPid && isRunning(appPid)
            ? `“${buddy.name}” is running but macOS won't show me its windows. ` +
                'Check Clippy (Electron) under Privacy & Security → Accessibility — ' +
                'switching it off and on again fixes a stale one.'
            : "I couldn't find that session's window — is the terminal still open?",
          { sticky: true, fix: appPid && isRunning(appPid) ? 'accessibility' : null }
        );
      }
      return false;
    }
    if (buddy.win.isDestroyed()) return false;

    const dock = { target: buddy.target, bounds, misses: 0, lastError: '', auto, poll: null };
    buddy.dock = dock;
    rehome(buddy); // the perch decides where he sits, not where he was
    if (!auto) buddy.pinned = true; // asked for by hand -> stays until dismissed
    if (raise) buddy.dragged = false; // asked to go to the terminal -> that's where he goes
    // A held card needs the full window; a quiet perch is just the paperclip.
    placeBuddy(buddy, mode || (broker.hasPending(key) ? 'full' : 'compact'));
    buddy.win.showInactive();
    dock.poll = startCompletionPoll(() => followWindow(key, dock), DOCK_POLL_MS, {
      onError: (err) => console.warn('clippy: could not follow the terminal window:', err.message),
    });
    return true;
  } catch (err) {
    console.warn('clippy: could not reach the terminal window:', err.message);
    if (auto) return false;
    // osascript exits non-zero for two very different reasons: macOS hasn't
    // granted control (fixable, worth opening the pane) or the window/app is
    // simply gone (nothing to grant). Only the first one is a permissions
    // problem — asking for permission we already have is how this used to spin.
    if (!canDriveWindows()) askForWindowAccess(key);
    else {
      tellBuddy(
        key,
        `I couldn't reach “${buddy.name}”'s window — it may have closed, or its app ` +
          'is busy. Try again in a moment.',
        { sticky: true }
      );
    }
    return false;
  }
}

/**
 * Raise a session's window and ride over to it. `point` follows that up with
 * the walk to the prompt — used when the reason you're going there is that
 * something is waiting to be answered on that line.
 */
/**
 * Bring this session's terminal to the front, and leave the buddy exactly where
 * he is.
 *
 * "Go to terminal" is a request about the *terminal*: the thing you want is
 * that window, in front of you. It used to be served by perching, which raised
 * the window and then moved Clippy onto its corner — undoing whatever spot you
 * had dragged him to, every single time you followed a card back to its
 * session. Raising is the whole job. A buddy already perched still rides along,
 * because riding along is what a perch is.
 */
async function raiseTerminal(key) {
  const buddy = buddyOf(key);
  if (!buddy || buddy.win.isDestroyed()) return false;

  // A session Clippy started has no window of its own — it has a tmux session,
  // which the user can attach a terminal to. Checked before the Accessibility
  // gate below, because attaching needs no permission at all.
  const record = tmuxRecordFor(key);
  if (record) return attachSpawned(buddy, record);

  if (!tracker.terminalFor(key)) {
    tellBuddy(
      key,
      "I don't know which window this session is in. Re-run `npm run hooks:install`, " +
        'then restart that Claude Code session so its hooks report the terminal.',
      { sticky: true }
    );
    return false;
  }
  if (!canDriveWindows()) {
    askForWindowAccess(key);
    return false;
  }

  try {
    const { bounds, activated } = await revealTarget(buddy, key);
    if (!bounds) {
      // The app came forward but we could not pick its window: that needs
      // Accessibility, and an agent app like ChatGPT or Claude is one most
      // people have never granted it to. It is in front of them now, so saying
      // "I couldn't find it" would contradict what they can see.
      if (activated) return true;
      const where = sourceFor(key);
      tellBuddy(key, `I couldn't find ${where.label} — is it still open?`, { sticky: true });
      return false;
    }
    // A perched buddy follows his window, so tell the perch where it ended up
    // rather than making the follow-poll notice a beat later. Anyone standing
    // somewhere of his own is not touched at all.
    if (buddy.dock) buddy.dock.bounds = bounds;
    return true;
  } catch (err) {
    console.warn('clippy: could not reach the terminal window:', err.message);
    if (!canDriveWindows()) askForWindowAccess(key);
    else {
      tellBuddy(
        key,
        `I couldn't reach “${buddy.name}”'s window — it may have closed, or its app ` +
          'is busy. Try again in a moment.',
        { sticky: true }
      );
    }
    return false;
  }
}

/**
 * Raise the session's window — and, when the answer has to be typed on its
 * prompt line, put Clippy on that window first so he can walk down and point at
 * it. That walk is the one reason this ever moves him.
 */
const openSessionWindow = (key, { point = false } = {}) =>
  (point ? perchOn(key, { raise: true }) : raiseTerminal(key)).then((ok) => {
    if (ok && point) hintAtTerminal(key);
    return ok;
  });

// How long to let macOS settle focus on the freshly-raised terminal before
// typing into it — keystrokes go to whichever window is key *right now*, so
// typing into a window still mid-raise would spray text somewhere else.
const TYPE_SETTLE_MS = 450;

/**
 * Type a prompt into this session's terminal and press Return — the closest
 * thing to "talk to your agent from Clippy" a watch-mode session allows.
 * There is no API into someone else's interactive CLI; raising the window
 * and typing, like a human would, is the honest mechanism, and everything
 * that can go wrong with it (no window, no accessibility) already has a
 * Clippy message.
 */
async function sendPromptToTerminal(key, text) {
  const buddy = buddyOf(key);
  const prompt = String(text || '').trim();
  if (!buddy || !prompt) return false;

  // Ours to drive: tmux takes the text directly, so there is no window to
  // raise, no keystrokes to aim, and nothing for macOS to block.
  const record = tmuxRecordFor(key);
  if (record) return sendToSpawned(buddy, record, prompt);

  if (!canDriveWindows()) {
    askForWindowAccess(key);
    return false;
  }
  try {
    // Typing needs the *window*, not just the app: keystrokes go wherever
    // focus actually landed, so an app we could only bring forward is not
    // good enough here — unlike "go to", which is done the moment it is up.
    const { bounds } = await revealTarget(buddy, key);
    if (!bounds) {
      tellBuddy(key, `I couldn't find ${sourceFor(key).label} to type into — is it still open?`, {
        sticky: true,
      });
      return false;
    }
    await new Promise((r) => setTimeout(r, TYPE_SETTLE_MS));
    await typeAndSubmit(prompt);
    return true;
  } catch (err) {
    console.warn('clippy: could not type into the terminal:', err.message);
    tellBuddy(
      key,
      `I couldn't type into “${buddy.name}”'s window — macOS may be blocking keystrokes. ` +
        'Check Clippy (Electron) under Privacy & Security → Accessibility.',
      { sticky: true, fix: 'accessibility' }
    );
    return false;
  }
}

const AX_PANE =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

// How long to keep an eye on the Accessibility switch after asking for it, and
// how often to look. Long enough to find the pane and flip it, then we stop.
const AX_WATCH_MS = 3 * 60 * 1000;
const AX_POLL_MS = 1500;
const AX_ASK_COOLDOWN_MS = 60 * 1000;
let axWatch = null;
let lastAxAsk = 0;

/**
 * Wait for the user to flip the switch, then pick up where we left off — no
 * restart, no second click. macOS hands the running process the new grant, so
 * polling `isTrustedAccessibilityClient` is all it takes.
 */
function watchForAccess(key) {
  if (axWatch) return;
  const started = Date.now();
  axWatch = setInterval(() => {
    if (canDriveWindows()) {
      clearInterval(axWatch);
      axWatch = null;
      pushSettingsState();
      // buddyOf, not buddies.has: every watched session shares one window, so
      // the map is keyed by that window and never by a session id. Asking the
      // map directly meant this branch was dead for real sessions — the switch
      // was granted and nothing picked up where it left off.
      if (key && buddyOf(key)) {
        tellBuddy(key, 'Got it — thanks. Taking you to that terminal now.');
        // `auto` so that a retry which fails for some *other* reason reports it
        // quietly instead of asking for permission all over again.
        perchOn(key, { raise: true, auto: true }).then((perched) => {
          if (!perched) tellBuddy(key, "Hmm — still can't reach that window. Try the menu again.");
        });
      }
      return;
    }
    if (Date.now() - started > AX_WATCH_MS) {
      clearInterval(axWatch);
      axWatch = null;
    }
  }, AX_POLL_MS);
  axWatch.unref?.();
}

/**
 * Reaching into another app's windows needs Accessibility. macOS answers a
 * denied request with an *empty* window list rather than an error, so an
 * un-granted Clippy looks exactly like a session whose terminal vanished —
 * check the grant up front and ask for it instead of guessing.
 */
function canDriveWindows({ prompt = false } = {}) {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(prompt);
}

/**
 * Ask macOS for Accessibility.
 *
 * An app can't grant itself this — the list lives in a SIP-protected database
 * and only the user (or an MDM profile) can write to it. What the prompt *does*
 * do is put us in the list, so it's one switch rather than hunting for the app
 * with the + button. After that we watch for the switch to flip and carry on
 * where we left off, instead of making anyone restart.
 */
function askForWindowAccess(key, { force = false } = {}) {
  // Opening System Settings is the loudest thing this app does, so it happens
  // once per cooldown however many times we're asked. Without this, a failure
  // that *isn't* about permissions bounces between the pane and the app.
  // `force` is for the buttons — you clicked it, you meant it.
  const now = Date.now();
  if (force || now - lastAxAsk > AX_ASK_COOLDOWN_MS) {
    lastAxAsk = now;
    canDriveWindows({ prompt: true }); // adds us to the list, with macOS's own dialog
    shell.openExternal(AX_PANE).catch(() => {});
    watchForAccess(key);
  }
  if (key) {
    tellBuddy(
      key,
      `macOS has to let me control other apps first. I opened the right pane — ` +
        `look for “${path.basename(appBundlePath(), '.app')}”, not “Clippy”. ` +
        'Settings ▸ Sessions has the full instructions.',
      { sticky: true, fix: 'accessibility' }
    );
  }
}

// Fallback for terminals we track by tty rather than by app pid: let go of the
// perch after this many unreadable polls. The script retries internally too, so
// this is several seconds of blindness.
const DOCK_MISS_LIMIT = 8;

/** Is that process still around? (`kill -0`: no signal, just a liveness test.) */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // alive, just not ours to signal
  }
}

/** Keep up with a window that the user moved, resized, or closed. */
async function followWindow(key, expectedDock = null) {
  const buddy = buddyOf(key);
  if (
    !buddy ||
    !buddy.dock ||
    (expectedDock && buddy.dock !== expectedDock) ||
    buddy.win.isDestroyed()
  )
    return;
  const dock = buddy.dock;
  let bounds = null;
  try {
    bounds = await windowBounds(dock.target);
  } catch (err) {
    // permission revoked, app quit, or a transient AppleEvent error
    dock.lastError = err.message;
  }
  if (buddy.dock !== dock) return; // undocked (or re-docked) while we were asking
  if (!bounds) {
    // Minimised, on another Space, or the app is mid-redraw: hold the perch
    // where it is. Only an app that has actually quit ends it.
    buddy.dock.misses++;
    const appPid = buddy.dock.target?.app?.pid;
    const gone = appPid ? !isRunning(appPid) : buddy.dock.misses >= DOCK_MISS_LIMIT;
    if (!gone) return;
    console.warn(
      `clippy: “${buddy.name}”'s window is gone — unperching`,
      buddy.dock.lastError || '(no window)'
    );
    undock(buddy);
    // The window we were riding is gone; go back to the normal rules rather
    // than sitting in the corner forever (a pending card still keeps us up).
    buddy.pinned = false;
    hideBuddy(key);
    return;
  }
  buddy.dock.misses = 0;
  rehome(buddy); // riding a window means going where it goes
  const same =
    bounds.x === buddy.dock.bounds.x &&
    bounds.y === buddy.dock.bounds.y &&
    bounds.width === buddy.dock.bounds.width;
  buddy.dock.bounds = bounds;
  if (!same) {
    stopWalking(buddy); // the window moved out from under the stroll
    placeBuddy(buddy, buddy.mode);
  }
}

/** Back to a free-floating Clippy in its own corner of the screen. */
function undock(buddy) {
  if (!buddy?.dock) return;
  rehome(buddy); // letting go sends him back to his own corner
  stopWalking(buddy);
  buddy.dock.poll?.cancel();
  buddy.dock = null;
  buddy.dragged = false; // letting go is its own fresh start, back in the corner
  placeBuddy(buddy, buddy.mode || 'compact');
}

/**
 * Find this session's window, raise it, and report where it ended up.
 *
 * The resolved target (app pid, tty) is cached because the process-tree walk
 * isn't free — but a cached target goes stale the moment you close that
 * terminal and open another, and a stale one fails *silently*: AppleScript
 * happily does nothing to a window that isn't there. That's why "go to
 * terminal" would sometimes just… not. So: try the cache, and if that comes
 * back empty, throw it away and resolve again before giving up.
 */
async function revealTarget(buddy, key, { measureOnly = false } = {}) {
  const hint = path.basename(tracker.cwdFor(key) || '') || buddy.name;
  let lastError = null;
  let activated = false;

  for (const fresh of [false, true]) {
    if (fresh) buddy.target = null;
    const term = tracker.terminalFor(key);
    if (!term) return { bounds: null, activated };

    try {
      // The project name goes along for the ride: an editor with several
      // project windows open titles each one after its folder, which is how we
      // pick the right one instead of guessing.
      buddy.target ||= await resolveTarget(term, hint);
      if (!buddy.target) continue;
      if (measureOnly) {
        const bounds = await windowBounds(buddy.target);
        if (bounds) return { bounds, activated };
      } else {
        const shown = await revealWindow(buddy.target);
        activated = activated || shown.activated;
        if (shown.bounds) return { bounds: shown.bounds, activated };
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  return { bounds: null, activated };
}

const measureTarget = (buddy, key) => revealTarget(buddy, key, { measureOnly: true });

/* ---------------- Walking over to point at the prompt ---------------- */

/**
 * When a question or an approval goes back to the terminal, the answer is now
 * somewhere you aren't looking: the input line at the bottom of that window.
 * So if we're already perched on it, Clippy walks down from his corner, stands
 * on the prompt and points at it — then strolls back to his perch.
 *
 * Only ever a hint: he never covers the line he's pointing at, and anything
 * that needs the window back (a new card, the window moving, undocking) calls
 * stopWalking and takes over.
 */
function pointAtPrompt(key) {
  const buddy = buddyOf(key);
  if (!buddy || buddy.win.isDestroyed() || !buddy.dock || !buddy.win.isVisible()) return;
  if (buddy.mode !== 'compact') return; // a card is up; that's the louder hint
  stopWalking(buddy);

  const [w, h] = compactSize(buddy);
  const tall = h + POINT_EXTRA_H;
  const area = screen.getDisplayMatching(buddy.dock.bounds).workArea;
  // Home is wherever he actually is — the perch anchor, or a spot you dragged
  // him to — not necessarily the corner the dock math would pick.
  const perch = buddy.dragged ? draggedSpot(buddy, w, h, area) : dockPosition(buddy.dock.bounds, w, h, area);
  const spot = promptPosition(buddy.dock.bounds, w, tall, area);

  buddy.walk = { phase: 'out', timer: null, hold: null };
  setBuddyBounds(buddy, { ...perch, width: w, height: tall });
  send(buddy, { kind: 'walk', facing: spot.x < perch.x ? 'left' : 'right' });

  strollTo(buddy, perch, spot, () => {
    send(buddy, { kind: 'point', on: true });
    buddy.walk.hold = setTimeout(() => {
      send(buddy, { kind: 'point', on: false });
      // The way back is the way out, reversed — hardcoding "right" here had him
      // moonwalking home whenever the prompt sat to the right of his perch.
      send(buddy, { kind: 'walk', facing: perch.x < spot.x ? 'left' : 'right' });
      strollTo(buddy, spot, perch, () => {
        stopWalking(buddy);
        placeBuddy(buddy, buddy.mode || 'compact');
      });
    }, POINT_MS);
  });
}

/** Step a window from one spot to another, easing in and out. */
function strollTo(buddy, from, to, done) {
  const steps = Math.max(1, Math.round(WALK_MS / WALK_FRAME_MS));
  let i = 0;
  const { width, height } = buddy.win.getBounds();
  buddy.walk.timer = setInterval(() => {
    if (buddy.win.isDestroyed() || !buddy.walk) return stopWalking(buddy);
    i++;
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    setBuddyBounds(buddy, {
      x: Math.round(from.x + (to.x - from.x) * ease),
      y: Math.round(from.y + (to.y - from.y) * ease),
      width,
      height,
    });
    if (i >= steps) {
      clearInterval(buddy.walk.timer);
      buddy.walk.timer = null;
      done();
    }
  }, WALK_FRAME_MS);
}

function stopWalking(buddy) {
  if (!buddy?.walk) return;
  clearInterval(buddy.walk.timer);
  clearTimeout(buddy.walk.hold);
  const missed = buddy.walk.missedPlacement;
  buddy.walk = null;
  // No heading: the stroll is over, so he stands the way his art is drawn.
  send(buddy, { kind: 'walk', facing: null });
  send(buddy, { kind: 'point', on: false });
  // A card that arrived mid-stroll asked for a window size it never got: the
  // walk owns the geometry while it runs, so placeBuddy could only decline.
  // Declining used to be the end of it, which left the buddy standing at the
  // old size with a card drawn outside its own window.
  if (missed) placeBuddy(buddy, missed.mode, missed.wantHeight, missed.wantWidth);
}

/**
 * "It's over there now" — the card just went back to the terminal. Give the
 * renderer a moment to shrink back to a bare buddy, then walk him to the
 * prompt if we're perched on that window.
 */
function hintAtTerminal(key) {
  setTimeout(() => pointAtPrompt(key), 400);
}

/**
 * Say something to a buddy's window on any channel.
 *
 * Everything main says to a renderer goes through here. The outbox holds
 * anything said before the page is listening and delivers it the moment it is
 * — which is the normal path, not an edge case, since a window is routinely
 * created and told about a card in the same tick.
 */
function post(buddy, channel, payload) {
  if (!buddy || buddy.win.isDestroyed()) return;
  buddy.out.post(channel, payload);
}

/** Send straight to a buddy we already have in hand. */
function send(buddy, event) {
  post(buddy, 'clippy-event', event);
}

/**
 * Say something in the buddy's speech bubble.
 *
 * `sticky` is for the messages you have to act on — a permission macOS won't
 * grant, a window we can't find. Those used to fade after four seconds, which
 * is exactly long enough to read half of it and not long enough to do anything
 * about it, so they now sit there until dismissed.
 */
function tellBuddy(key, message, { sticky = false, fix = null } = {}) {
  const buddy = buddyOf(key);
  if (!buddy || buddy.win.isDestroyed()) return;
  placeBuddy(buddy, 'full');
  send(buddy, { kind: 'info', message, sticky, fix });
  buddy.win.showInactive();
}

/* ---------------- Sessions Clippy starts (tmux) ---------------- */

/**
 * Watch mode waits for an agent to report in. This is the other direction:
 * Clippy starts the agent, in a tmux session it owns.
 *
 * tmux is the point. It gives a session Clippy can type into without an
 * Accessibility grant or a visible window, that the user can attach a real
 * terminal to whenever they want to take over, and that outlives Clippy itself
 * — quitting the app leaves the work running.
 *
 * What such a session does *not* have is hooks, at least not at first: there is
 * no SessionStart hook, so nothing is heard until the first prompt, and an
 * agent over ssh reports to its own machine and never will. So everything these
 * buddies know about what their agent is saying comes from reading the
 * transcript it writes (see transcript.js).
 */

// Populated from the settings file once it has been read (see whenReady):
// this runs at module load, when `settings` is still the defaults.
const spawned = new SpawnedSessions();
// Buddy key -> { watch, record }. Rekeyed alongside the buddy on adoption.
const watchers = new Map();
// Codex rollouts record their cwd on line one, which never changes.
const codexMetaCache = new Map();
// How much of a session's talk to keep for the "recent messages" panel.
const FEED_TURNS = 12;

function saveSpawned() {
  settings.spawnedSessions = spawned.toJSON();
  saveSettings();
}

/** A path as the agent will see it: symlinks resolved, or unchanged if it's gone. */
function canonicalPath(dir) {
  try {
    return dir ? fs.realpathSync(dir) : '';
  } catch {
    return dir;
  }
}

function rememberRecentProject(entry) {
  settings.recentProjects = rememberProject(settings.recentProjects, { ...entry, at: Date.now() });
  saveSettings();
}

/** Where this session's transcript is — what the hooks said, or what we found. */
function transcriptPathFor(key) {
  return tracker.transcriptFor(key) || spawned.forKey(key)?.transcript || '';
}

/** Is this buddy one we started, and can therefore drive through tmux? */
const tmuxRecordFor = (key) => spawned.forKey(key);

/**
 * The last thing this session said, for the status summary.
 *
 * A remote session's transcript is on the other machine, so there is nothing
 * local to open — the watcher's last reading is the only copy we have.
 */
async function recapFor(key) {
  const record = spawned.forKey(key);
  if (record && record.host) return (record.lastSay || '').slice(0, 200);
  return lastAssistantText(transcriptPathFor(key), { maxChars: 200 });
}

/**
 * A reader that finds its own transcript.
 *
 * A freshly spawned agent has not written anything yet, and a Codex session has
 * to be searched for by cwd, so resolution cannot happen at spawn time. It
 * happens on the first poll that succeeds, and again if the file ever goes away
 * — a /clear starts a new session id, which is a new file at a new path.
 */
function spawnedReader(record) {
  // A session on another machine writes its transcript over there, so reading
  // it is one ssh command per poll rather than a local file handle. Everything
  // downstream sees the same shape either way.
  if (record.host) {
    return createRemoteReader({
      host: record.host,
      agent: record.agent,
      cwd: record.remotePath,
      sessionId: record.sessionId,
      // The same socket the session's own ssh is holding open, so a poll costs
      // a round trip rather than a handshake and an authentication.
      controlPath: controlPathFor(),
      turnsFrom,
      clip: (turn) => (turn.text.length > 4000 ? { ...turn, text: `${turn.text.slice(0, 4000)}…` } : turn),
    });
  }

  let reader = null;
  return {
    async poll() {
      if (!reader) {
        const found = await resolveSession({
          agent: record.agent,
          cwd: record.cwd,
          sessionId: record.sessionId,
          roots: { claudeProjects: CLAUDE_PROJECTS_DIR, codexSessions: CODEX_SESSIONS_DIR },
          sinceMs: record.createdAt,
          cache: codexMetaCache,
        });
        if (!found) return { turns: [], changed: false };
        record.transcript = found.path;
        reader = createReader({ path: found.path, agent: record.agent });
      }
      const result = await reader.poll();
      if (result.gone) {
        reader = null;
        record.transcript = '';
      }
      return result;
    },
  };
}

/** Start following what a spawned session is saying. */
function watchSpawned(record) {
  const key = buddyKeyFor(record);
  if (watchers.has(key)) return watchers.get(key);

  const watch = startAgentWatch({
    reader: spawnedReader(record),
    remote: Boolean(record.host),
    onTurns: (turns, meta) => {
      const said = lastSaid(turns);
      if (said) record.lastSay = said;
      const directReply = Boolean(
        record.awaitingReply && (turns || []).some((turn) => turn.role === 'assistant' && turn.text)
      );
      if (directReply) {
        record.awaitingReply = false;
        record.lastDirectReplyAt = Date.now();
      }
      // Kept because a remote transcript cannot be re-read from here: for an
      // SSH session this is the only copy of what it has been saying.
      record.recentTurns = [...(record.recentTurns || []), ...turns].slice(-FEED_TURNS);
      send(buddyOf(buddyKeyFor(record)), {
        kind: 'transcript',
        turns,
        // A first read is the backlog, not news — the buddy files it away
        // rather than announcing it.
        cold: Boolean(meta && meta.cold),
        directReply,
        source: record.host ? `via ${record.host}` : `tmux · ${record.name}`,
      });
    },
    onStatus: (status) => {
      // Quietly: a flaky connection must not make a paperclip bounce.
      send(buddyOf(buddyKeyFor(record)), {
        kind: 'transcript-status',
        state: status.state,
        host: record.host,
      });
    },
  });

  const entry = { watch, record };
  watchers.set(key, entry);
  return entry;
}

function unwatchSpawned(key) {
  const entry = watchers.get(key);
  if (!entry) return;
  entry.watch.stop();
  watchers.delete(key);
}

/** Something happened in this session — look at its transcript sooner. */
const pokeWatch = (key) => watchers.get(key)?.watch?.poke?.();

/**
 * Move a buddy from one key to another, in place.
 *
 * A spawned Codex session lives under `tmux:<name>` until a hook tells us its
 * real session id; from then on everything — the tracker, the decision broker,
 * the settings maps — keys off that id, so the buddy has to move with it. The
 * renderer never sends its own key back (windows are resolved with
 * buddyForSender), so this really is just a map move.
 */
function rekeyBuddy(from, to) {
  if (!from || !to || from === to) return false;

  // The transcript watcher moves first, and unconditionally. It is keyed by
  // whatever `buddyKeyFor` says the session is called, and that name changes on
  // adoption — so a watcher left behind under the old key is one nothing can
  // poke and nothing will ever stop, polling a finished session for as long as
  // the app runs.
  const entry = watchers.get(from);
  if (entry) {
    watchers.delete(from);
    watchers.set(to, entry);
  }

  // The window map is keyed by *window*, and every watched session shares one —
  // so there is usually nothing here to move. A sandbox buddy, which does have
  // a window of its own, still does.
  const buddy = buddies.get(from);
  if (buddy && !buddies.has(to)) {
    buddies.delete(from);
    buddy.sessionId = to;
    buddies.set(to, buddy);
  }
  // The shared window is left wearing the old name on purpose: the next event
  // for this session goes through wearIdentity, which re-dresses it properly —
  // plate, colour and all — and would skip that work if the name were changed
  // out from under it here.
  pushSettingsState();
  return true;
}

/**
 * A hook arrived from a session we may have started. Claude sessions are
 * spawned already knowing their id, so this is really about Codex.
 */
async function adoptSpawned(sessionId) {
  if (!sessionId || spawned.forSession(sessionId) || !spawned.hasUnadopted()) return;
  const pid = tracker.terminalFor(sessionId)?.pid;
  if (!pid) return;

  let table;
  try {
    table = parseProcessTable(await tmux.run('/bin/ps', ['-Ao', 'pid=,ppid=,comm='], { timeout: 4000 }));
  } catch {
    return;
  }
  const record = spawned.matchHookPid(pid, table);
  if (!record) return;

  const from = buddyKeyFor(record);
  spawned.adopt(record.name, sessionId);
  rekeyBuddy(from, sessionId);
  saveSpawned();
}

/**
 * The agent in a spawned session ended, but the pane did not — the launch
 * command drops to a shell rather than dying, so the session is still there and
 * still attachable. Hand it back to its tmux name instead of closing the buddy.
 *
 * @returns {boolean} true if the caller should leave this buddy alone.
 */
function unadoptBuddy(sessionId) {
  const record = spawned.forSession(sessionId);
  if (!record) return false;
  spawned.release(sessionId);
  rekeyBuddy(sessionId, buddyKeyFor(record));
  saveSpawned();
  return true;
}

const CHAT_SEND_READY_ATTEMPTS = 1200; // two minutes at the startup helper's 100ms interval

/** Deliver one queued prompt once the owned pane is genuinely ready for it. */
async function deliverToSpawned(buddy, record, prompt) {
  try {
    const bin = await tmux.findTmux();
    const target = record.paneId || `=${record.name}`;
    const isChat =
      !record.host && canonicalPath(record.cwd) === canonicalPath(chatWorkspace(os.homedir()));

    // A restored chat from an older Clippy may still be parked at Claude's
    // trust screen. This folder is ours, so finish preparing it before typing.
    // The same wait is the chat queue: while an answer is still being written,
    // do not paste into a TUI that will ignore Return and strand the text.
    if (isChat) {
      tellBuddy(buddy.sessionId, `Queued for ${tmux.SPAWNABLE[record.agent].label} — waiting for its prompt…`);
      const prepared = await prepareAgentWorkspace({
        capture: () => tmux.capturePane(bin, target, { lines: 40 }),
        confirmTrust: () => tmux.pressEnter(bin, target),
        continueWithoutHooks: () => tmux.pressKeys(bin, target, 'Down', 'Down', 'Enter'),
        dismissSurvey: () => tmux.pressKeys(bin, target, '0'),
        attempts: CHAT_SEND_READY_ATTEMPTS,
      });
      if (!prepared.ready) {
        tellBuddy(
          buddy.sessionId,
          `${tmux.SPAWNABLE[record.agent].label} never returned to its prompt, so I did not send that message. ` +
            'Attach a terminal from my menu to see what it needs.',
          { sticky: true }
        );
        return false;
      }
    } else if (
      ['trust', 'hooks'].includes(
        paneStartupState(await tmux.capturePane(bin, target, { lines: 40 }))
      )
    ) {
      tellBuddy(
        buddy.sessionId,
        `${tmux.SPAWNABLE[record.agent].label} needs you to trust this project before I can send that. ` +
          'Attach a terminal from my menu to choose.',
        { sticky: true }
      );
      return false;
    }

    await tmux.sendPrompt(bin, target, prompt, { clearFirst: isChat });
    record.awaitingReply = true;
    pokeWatch(buddy.sessionId);
    tellBuddy(buddy.sessionId, `Sent to ${tmux.SPAWNABLE[record.agent].label} — waiting for a reply…`);
    return true;
  } catch (err) {
    console.warn('clippy: could not send to tmux:', err.message);
    tellBuddy(buddy.sessionId, `I couldn't reach “${record.name}” — is the tmux session still there?`, {
      sticky: true,
    });
    return false;
  }
}

/**
 * Type into a spawned session's pane. Chat prompts serialize per pane, so two
 * quick sends cannot paste over each other or land while the agent is busy.
 */
function sendToSpawned(buddy, record, prompt) {
  const previous = record.sendQueue || Promise.resolve();
  const sending = previous.catch(() => false).then(() => deliverToSpawned(buddy, record, prompt));
  record.sendQueue = sending;
  sending.finally(() => {
    if (record.sendQueue === sending) delete record.sendQueue;
  });
  return sending;
}

/**
 * Open a real terminal attached to a spawned session.
 *
 * A `.command` file handed to `open` rather than AppleScript's `do script`:
 * that needs the Automation consent, which is a different grant from the
 * Accessibility one the perch uses, with its own dialog and its own silent
 * failure — and askForWindowAccess would send the user to the wrong pane.
 * `open` is what a double-click does and needs nothing at all, and the terminal
 * runs the file in a login shell, where tmux is on PATH for the same reason the
 * agent binary is.
 */
async function attachSpawned(buddy, record) {
  let bin;
  try {
    bin = await tmux.findTmux();
  } catch {
    offerTmuxInstall();
    return false;
  }

  const command = tmux.attachCommand(bin, record.name);
  try {
    const file = path.join(app.getPath('userData'), 'attach', `${record.name}.command`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\nexec ${command}\n`, { mode: 0o755 });
    await tmux.run('/usr/bin/open', ['-a', ATTACH_APPS[settings.attachTerminal] || 'Terminal', file]);
    return true;
  } catch (err) {
    console.warn('clippy: could not open a terminal:', err.message);
    clipboard.writeText(command);
    tellBuddy(buddy.sessionId, "I couldn't open your terminal — the attach command is on your clipboard.", {
      sticky: true,
    });
    return false;
  }
}

// Claude Code asks whether you trust a folder the first time it runs in one,
// and that prompt swallows whatever is typed at it — so a first prompt sent
// from the buddy would vanish without explanation.
// Long enough for the TUI to have drawn something, short enough to still be
// ahead of the user typing their first prompt.
const TRUST_CHECK_MS = 6000;

/**
 * Say so if the agent is sitting on its trust prompt. Deliberately only says
 * so: answering a security question on the user's behalf is not Clippy's to do.
 */
async function warnIfAwaitingTrust(bin, record, label) {
  await new Promise((r) => setTimeout(r, TRUST_CHECK_MS));
  const key = buddyKeyFor(record);
  // buddyOf, not buddies.has: a spawned session's key is its tmux name, and the
  // window it lives in is the shared one — so the map never holds that key, and
  // this warning never reached anybody.
  if (!buddyOf(key)) return;
  const pane = await tmux.capturePane(bin, record.paneId || `=${record.name}`, { lines: 40 }).catch(() => '');
  if (!TRUST_PROMPT.test(pane)) return;
  tellBuddy(
    key,
    `${tmux.SPAWNABLE[record.agent].label} is asking whether you trust “${label}” before it will start. ` +
      'Attach a terminal from my menu to answer it — that one is yours, not mine.',
    { sticky: true }
  );
}

/**
 * The window for starting an agent somewhere.
 *
 * The tray handles the one-click chat case and project folders directly. This
 * window presents those choices together and covers the case a menu cannot
 * express: an SSH target needs a host *and* a path typed in, and Electron has
 * no text-input dialog.
 */
function openNewAgentWindow() {
  if (newAgentWin && !newAgentWin.isDestroyed()) {
    newAgentWin.show();
    newAgentWin.focus();
    return newAgentWin;
  }

  const win = new BrowserWindow({
    width: 480,
    height: 460,
    resizable: false,
    title: 'New agent',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f7f2e8',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-newagent.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  newAgentWin = win;
  win.loadFile(path.join(__dirname, 'renderer', 'new-agent.html'));
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    if (newAgentWin === win) newAgentWin = null;
  });
  return win;
}

const closeNewAgentWindow = () => {
  if (newAgentWin && !newAgentWin.isDestroyed()) newAgentWin.close();
};

function offerTmuxInstall() {
  dialog.showMessageBox({
    type: 'info',
    message: 'Starting an agent needs tmux',
    detail:
      'Clippy runs the agents it starts inside tmux, so they survive quitting the app and you can ' +
      'attach a terminal to them whenever you like.\n\nInstall it with:  brew install tmux',
    buttons: ['OK'],
  });
}

/** Start an agent in a folder (or on another machine) and give it a buddy. */
async function spawnAgent({
  path: rawCwd = '',
  host = '',
  remotePath = '',
  agent,
  remember = true,
  autoTrust = false,
} = {}) {
  // Two fallbacks deep: the id comes from a renderer form, and the default it
  // falls back to comes from a settings file anyone can edit — and every
  // message below reads `SPAWNABLE[kind].label` without asking.
  const kind = spawnableAgent(agent) || spawnableAgent(settings.defaultAgent) || 'claude';
  // The agent will record its *resolved* working directory, and Claude Code
  // derives its transcript directory from that — so a path through a symlink
  // (every /var/… on macOS, and plenty of people's ~/work) has to be
  // canonicalized here or the transcript is looked for somewhere it isn't.
  const cwd = canonicalPath(rawCwd);
  let bin;
  try {
    bin = await tmux.findTmux();
  } catch {
    offerTmuxInstall();
    return null;
  }

  if (!host && (!cwd || !fs.existsSync(cwd))) {
    dialog.showMessageBox({
      type: 'warning',
      message: 'That folder has moved',
      detail: cwd ? `${cwd} isn't there any more.` : 'No folder was chosen.',
      buttons: ['OK'],
    });
    return null;
  }

  const label = host ? host.replace(/^.*@/, '') : path.basename(cwd);
  let name = tmux.sessionName(label);
  for (let seq = 1; seq < 50 && (await tmux.hasSession(bin, name)); seq++) {
    name = tmux.sessionName(label, { seq });
  }

  // Claude lets us pick the session id, which makes its buddy correctly keyed
  // from the start and its transcript path a certainty rather than a search.
  const sessionId = kind === 'claude' ? crypto.randomUUID() : '';
  const command = tmux.launchCommand({
    agent: kind,
    cwd,
    sessionId,
    host,
    remotePath,
    // The pane's ssh opens the connection the transcript probe reuses.
    controlPath: host ? ensureControlDir(fs.mkdirSync) && controlPathFor() : '',
  });

  let pane;
  try {
    pane = await tmux.newSession(bin, { name, cwd: host ? os.homedir() : cwd, command });
    if (!pane) throw new Error('tmux did not report a pane');
    if (autoTrust) {
      await prepareAgentWorkspace({
        capture: () => tmux.capturePane(bin, pane.paneId, { lines: 40 }),
        confirmTrust: () => tmux.pressEnter(bin, pane.paneId),
        continueWithoutHooks: () => tmux.pressKeys(bin, pane.paneId, 'Down', 'Down', 'Enter'),
        dismissSurvey: () => tmux.pressKeys(bin, pane.paneId, '0'),
      });
    }
  } catch (err) {
    await tmux.killSession(bin, name).catch(() => {});
    dialog.showMessageBox({
      type: 'warning',
      message: `Could not start ${tmux.SPAWNABLE[kind].label}`,
      detail: err.message,
      buttons: ['OK'],
    });
    return null;
  }

  const record = spawned.add({
    name,
    cwd,
    agent: kind,
    host,
    remotePath,
    sessionId,
    paneId: pane.paneId,
    panePid: pane.panePid,
    createdAt: Date.now(),
  });
  if (remember) rememberRecentProject({ path: cwd, host, remotePath, agent: kind });
  saveSpawned();

  const buddy = buddyFor(buddyKeyFor(record), label, kind, record.name);
  buddy.pinned = true; // a session you started is one you meant to see
  showBuddy(buddy.sessionId, { pin: true });
  watchSpawned(record);
  tellBuddy(
    buddy.sessionId,
    `Starting ${tmux.SPAWNABLE[kind].label} in “${label}”. Type below, or attach a terminal from my menu.`
  );
  warnIfAwaitingTrust(bin, record, label).catch(() => {});
  updateTray();
  return record;
}

/** Start a subscription-backed agent in Clippy's private, persistent chat folder. */
async function spawnChat(agent) {
  let cwd;
  try {
    cwd = ensureChatWorkspace(os.homedir());
  } catch (err) {
    dialog.showMessageBox({
      type: 'warning',
      message: 'Could not create the Clippy chat folder',
      detail: err.message,
      buttons: ['OK'],
    });
    return null;
  }
  // A conversation is not a project, so do not crowd the recent-project list.
  return spawnAgent({ path: cwd, agent, remember: false, autoTrust: true });
}

/**
 * tmux outliving Clippy is the whole point, so on launch we go and find the
 * sessions still running and give them their buddies back.
 */
async function restoreSpawned() {
  if (!spawned.list().length) return;
  let bin;
  try {
    bin = await tmux.findTmux();
  } catch {
    return; // tmux gone: leave the registry alone rather than forgetting real work
  }

  const live = await tmux.listSessions(bin).catch(() => null);
  if (!live) return;
  // Prune before asking about panes, so a dead session is never queried.
  for (const gone of spawned.keep(live)) {
    fs.rmSync(path.join(app.getPath('userData'), 'attach', `${gone.name}.command`), { force: true });
  }

  for (const record of spawned.list()) {
    // Pane ids and pids are from a previous run of the app, and pids get reused.
    const [pane] = await tmux.listPanes(bin, record.name).catch(() => []);
    if (pane) Object.assign(record, pane);
    const label = record.host ? record.host.replace(/^.*@/, '') : path.basename(record.cwd);
    const buddy = buddyFor(buddyKeyFor(record), label, record.agent, record.name);
    buddy.pinned = true;
    showBuddy(buddy.sessionId, { pin: true });
    watchSpawned(record);
  }
  saveSpawned();
  updateTray();
}

/**
 * This buddy's pet model, made on demand.
 *
 * Shared by the chat and by routing — routing used to require that you had
 * already talked to the pet at least once, which made "just tell Clippy" work
 * only for people who had happened to say hello first.
 */
function chatFor(buddy) {
  if (!buddy.chat) {
    buddy.chat = new PetChat({
      // Read fresh every turn: the model and the status move under the pet
      // while you're talking to it.
      context: () => ({
        pet: petNameOf(buddy),
        character: cast().find((c) => c.id === buddy.character)?.label || 'desk buddy',
        project: buddy.name,
        cwd: tracker.cwdFor(buddy.sessionId),
        agent: agentDisplayName(buddy.agent),
        model: tracker.modelFor(buddy.sessionId),
        status: tracker.statusFor(buddy.sessionId),
      }),
    });
  }
  return buddy.chat;
}

/* ---------------- Reading something at length ---------------- */

// Card titles worth putting on a reader's header, kept beside the whole
// messages they belong to and pruned by the same cap.
const readerTitles = new Map();

let readerWin = null;
let readerSessionId = '';
let readerRequestId = '';

/**
 * A focused window for a long message or finished-turn review.
 *
 * One at a time, reused: opening a second card's text replaces what is in it
 * rather than littering the desktop with paperclip windows. Deliberately not
 * always-on-top — the point is that it can be left open, dragged to another
 * display, and read comfortably. A review temporarily takes over from the mini
 * card and carries that buddy and the two review actions.
 */
function openReader(payload) {
  readerSessionId = String(payload.sessionId || '');
  readerRequestId = payload.review ? String(payload.requestId || '') : '';
  if (!readerWin || readerWin.isDestroyed()) {
    readerWin = new BrowserWindow({
      width: 620,
      height: 640,
      minWidth: 340,
      minHeight: 240,
      show: false,
      title: payload.title || 'Clippy',
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#f9f6ef',
      webPreferences: {
        preload: path.join(__dirname, 'preload-reader.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    readerWin.on('closed', () => {
      const restore = readerRequestId && pendingReviews.has(readerRequestId);
      const sessionId = readerSessionId;
      readerWin = null;
      readerSessionId = '';
      readerRequestId = '';
      if (restore && sessionId) showBuddy(sessionId);
    });
    readerWin.loadFile(path.join(__dirname, 'renderer', 'reader.html'));
  }
  const win = readerWin;
  const send = () => {
    if (!win.isDestroyed()) win.webContents.send('clippy-reader-text', payload);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
  // The review moves into this window. Its mini card remains alive underneath
  // so minimizing or closing without a decision can restore it unchanged — but
  // the session may have ended between the click and here, taking its window.
  const mini = payload.review ? buddyOf(readerSessionId) : null;
  if (mini && !mini.win.isDestroyed()) mini.win.hide();
  win.show();
  win.focus();
}

/* ---------------- Token usage (right-click) ---------------- */

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const USAGE_CACHE_MS = 60 * 1000;
const usageCache = new Map();
// One coalesced sweep per agent: concurrent right-clicks share a single
// directory walk instead of each paying for their own.
const usageRefreshers = new Map();
function refreshUsageWindowsFor(agent) {
  let refresh = usageRefreshers.get(agent);
  if (!refresh) {
    const dir = agent === 'codex' ? CODEX_SESSIONS_DIR : CLAUDE_PROJECTS_DIR;
    refresh = coalesceAsync((now) => usageWindows(dir, now));
    usageRefreshers.set(agent, refresh);
  }
  return refresh;
}

/**
 * What this session (and the machine) has spent. Session context comes straight
 * from this session's transcript; the windows `/usage` reports on need a sweep
 * of every recent transcript, so they are cached for a minute — right-clicking
 * repeatedly shouldn't cost anything.
 *
 * The allowance those windows are measured against can only come from the
 * settings window, because Claude Code never writes it down: `/usage` asks the
 * API. When nobody has told us, `limits` is null and the panel says so instead
 * of inventing a percentage.
 */
async function collectUsage(key) {
  const agent = tracker.agentFor(key);
  const transcriptSession = await sessionUsage(transcriptPathFor(key));
  const trackedModel = tracker.modelFor(key);
  const session = transcriptSession
    ? { ...transcriptSession, model: transcriptSession.model || trackedModel }
    : trackedModel
    ? { model: trackedModel, context: 0, contextLimit: 0, totals: {}, turns: 0 }
    : null;
  const now = Date.now();
  let cached = usageCache.get(agent);
  if (!cached || now - cached.at > USAGE_CACHE_MS) {
    cached = { at: now, windows: await refreshUsageWindowsFor(agent)(now) };
    usageCache.set(agent, cached);
  }
  return {
    name: buddyOf(key)?.name || '',
    agent,
    // The percentages Claude Code itself cached from /usage — the real
    // allowance, shown first whenever it exists.
    official: agent === 'claude' ? await readOfficialUsage() : null,
    session,
    // What Claude said as its last turn ended — the status summary's "doing
    // right now" line falls back to it when no tool activity is fresher.
    recap: await recapFor(key),
    windows: cached.windows,
    now,
  };
}

/* ---------------- Tray ---------------- */

/** A short, stable label for a menu item that needs the user's attention. */
function attentionLabel(item) {
  const subject = String(item.title || (item.kind === 'question' ? 'a question' : 'an approval'))
    .replace(/\s+/g, ' ')
    .trim();
  const prefix = item.state === 'terminal' ? '↗ Answer in terminal' : '📎 Open in Clippy';
  const who = item.name || item.agentName || 'this session';
  return `${prefix} — ${who}: ${subject.slice(0, 88)}${subject.length > 88 ? '…' : ''}`;
}

function attentionItems() {
  return [...attentionInbox.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function rememberAttention(item) {
  attentionInbox.set(item.id, { ...item, state: 'clippy', updatedAt: Date.now() });
  updateTray();
}

function forgetAttention(id) {
  if (attentionInbox.delete(id)) updateTray();
}

function moveAttentionToTerminal(id) {
  const item = attentionInbox.get(id);
  if (!item) return;
  attentionInbox.set(id, { ...item, state: 'terminal', updatedAt: Date.now() });
  updateTray();
}

function forgetAttentionForSession(sessionId) {
  let changed = false;
  for (const [id, item] of attentionInbox) {
    if (item.sessionId !== sessionId) continue;
    attentionInbox.delete(id);
    changed = true;
  }
  if (changed) updateTray();
}

/** Show a session, already opened to the context and usage summary. */
function showUsageFor(key) {
  if (!buddyOf(key)) return;
  sendTo(key, { kind: 'open-usage' });
  showBuddy(key, { pin: true });
}

function trayMenu() {
  const attention = attentionItems();
  const sessionItems = [...buddies.values()].map((b) => ({
    label: b.name,
    submenu: [
      { label: 'Show Clippy', click: () => showBuddy(b.sessionId, { pin: true }) },
      { label: 'Context & usage', click: () => showUsageFor(b.sessionId) },
      {
        label: tmuxRecordFor(b.sessionId)
          ? 'Attach in Terminal'
          : b.dock
          ? 'Open window again'
          : 'Open session window',
        enabled: Boolean(tracker.terminalFor(b.sessionId) || tmuxRecordFor(b.sessionId)),
        click: () => openSessionWindow(b.sessionId),
      },
      ...(b.dock
        ? [{ label: 'Unperch', click: () => hideBuddy(b.sessionId, { unpin: true }) }]
        : []),
    ],
  }));

  return Menu.buildFromTemplate([
    ...(attention.length
      ? [
          { label: `Needs attention (${attention.length})`, enabled: false },
          ...attention.map((item) => ({
            label: attentionLabel(item),
            click: () => {
              if (item.state === 'terminal') openSessionWindow(item.sessionId, { point: true });
              else showBuddy(item.sessionId, { pin: true });
            },
          })),
          { type: 'separator' },
        ]
      : []),
    { label: 'Settings…', click: () => openSettingsWindow() },
    // Straight to the panel: the deep-link already exists, and burying feedback
    // three scrolls into a settings window is how you never hear any.
    { label: 'Send feedback…', click: () => openSettingsWindow('feedback') },
    { type: 'separator' },
    {
      label: buddies.size ? `Show all (${buddies.size})` : 'No sessions yet',
      enabled: buddies.size > 0,
      click: () => {
        for (const b of buddies.values()) showBuddy(b.sessionId, { pin: true });
      },
    },
    {
      label: 'Hide all until next update',
      enabled: buddies.size > 0,
      click: () => {
        for (const b of buddies.values()) hideBuddy(b.sessionId, { unpin: true });
      },
    },
    {
      // Lines the free-floating buddies up along an edge, and makes that edge
      // the default spot for new ones. Perched buddies stay on their windows.
      label: 'Organize buddies',
      submenu: EDGE_OPTIONS.map(({ id, label }) => ({
        label,
        type: 'radio',
        checked: settings.arrangeEdge === id,
        click: () => organizeBuddies(id),
      })),
    },
    ...(sessionItems.length ? [{ type: 'separator' }, ...sessionItems] : []),
    { type: 'separator' },
    { label: 'New agent', submenu: newAgentMenu() },
    drive
      ? { label: `Stop Clippy-driven session (${drive.name})`, click: stopDriveSession }
      : { label: 'New Clippy-driven session…', click: startDriveSession },
    { type: 'separator' },
    // The quick switches stay a click away; the window has the rest.
    { label: 'Quick settings', submenu: globalSettingsMenu() },
    { type: 'separator' },
    ...(hooksAbsent
      ? [
          { label: '📎 Install hooks — Clippy can’t see sessions yet', click: installHooksNow },
          { type: 'separator' },
        ]
      : []),
    ...(hookDrift
      ? [
          { label: '⚠ Hooks are out of date — update them now', click: installHooksNow },
          { type: 'separator' },
        ]
      : []),
    { label: `Hook server: 127.0.0.1:${PORT}`, enabled: false },
    {
      label: 'Restart Clippy',
      click: () => {
        app.relaunch();
        app.exit(0);
      },
    },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

/** `~/projects/clippy — Claude Code`, or `box:/srv/app — Codex`. */
function recentLabel(entry) {
  const where = entry.host
    ? `${entry.host}:${entry.remotePath || '~'}`
    : entry.path.replace(os.homedir(), '~');
  return `${where} — ${tmux.SPAWNABLE[entry.agent]?.label || 'Claude Code'}`;
}

/** Ask for a folder, then start an agent in it. */
async function pickFolderAndSpawn(agent) {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: `Folder for the new ${tmux.SPAWNABLE[agent]?.label || 'agent'} session`,
    buttonLabel: 'Start here',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: settings.recentProjects.find((p) => !p.host)?.path || os.homedir(),
  });
  if (canceled || !filePaths?.length) return;
  await spawnAgent({ path: filePaths[0], agent });
}

/** The "New agent" submenu: chat immediately, pick a project, or reopen a recent one. */
function newAgentMenu() {
  const recents = settings.recentProjects.slice(0, 8);
  return [
    ...Object.entries(tmux.SPAWNABLE).map(([id, { label }]) => ({
      label: `Chat with ${label}`,
      click: () => spawnChat(id),
    })),
    { type: 'separator' },
    ...Object.entries(tmux.SPAWNABLE).map(([id, { label }]) => ({
      label: `${label} in a project…`,
      click: () => pickFolderAndSpawn(id),
    })),
    ...(recents.length
      ? [
          { type: 'separator' },
          { label: 'Recent', enabled: false },
          ...recents.map((entry) => ({
            label: recentLabel(entry),
            click: () => spawnAgent({ ...entry }),
          })),
        ]
      : []),
    { type: 'separator' },
    // A host and a path cannot be typed into a menu.
    { label: 'Over SSH…', click: openNewAgentWindow },
  ];
}

/**
 * Global settings — these apply to every session's buddy, which is why they
 * live in the menu bar rather than on one buddy's own menu.
 */
function globalSettingsMenu() {
  const radios = (key, options) =>
    options.map(({ id, label }) => ({
      label,
      type: 'radio',
      checked: settings[key] === id,
      click: () => setSetting(key, id),
    }));

  return [
    { label: 'Answer from Clippy', enabled: false },
    {
      label: 'Permission requests',
      type: 'checkbox',
      checked: settings.approvals,
      click: (item) => setSetting('approvals', item.checked),
    },
    {
      label: 'Questions',
      type: 'checkbox',
      checked: settings.answerQuestions,
      click: (item) => setSetting('answerQuestions', item.checked),
    },
    {
      label: 'Review when an agent finishes',
      type: 'checkbox',
      checked: settings.reviewOnStop,
      click: (item) => setSetting('reviewOnStop', item.checked),
    },
    { type: 'separator' },
    { label: 'Agents you start', enabled: false },
    {
      label: 'Default agent',
      submenu: radios(
        'defaultAgent',
        Object.entries(tmux.SPAWNABLE).map(([id, { label }]) => ({ id, label }))
      ),
    },
    {
      label: 'Attach in',
      submenu: radios(
        'attachTerminal',
        Object.entries(ATTACH_APPS).map(([id, label]) => ({ id, label }))
      ),
    },
    { type: 'separator' },
    { label: 'Appearance', enabled: false },
    // No global "Character" here: buddies are cast per session, and per-project
    // choices live in the settings window's cast (the retired `character`
    // setting made this menu a row of radios nothing ever checked).
    {
      label: 'Size',
      submenu: radios('size', [
        { id: 'small', label: 'Small' },
        { id: 'medium', label: 'Medium' },
        { id: 'large', label: 'Large' },
      ]),
    },
    {
      label: "Perch on the session's own window",
      type: 'checkbox',
      checked: settings.autoPerch,
      click: (item) => setSetting('autoPerch', item.checked),
    },
    {
      label: "Stay quiet when I'm already in that window",
      type: 'checkbox',
      checked: settings.quietWhenFocused,
      click: (item) => setSetting('quietWhenFocused', item.checked),
    },
    { type: 'separator' },
    {
      label: 'Fix window access (Accessibility)…',
      click: () => askForWindowAccess(null, { force: true }),
    },
  ];
}

/**
 * On macOS the menu bar item is the 📎 emoji itself, set as the tray title —
 * it's what the docs and the settings window mean by “📎 in the menu bar”,
 * and as full-colour emoji it reads the same on light and dark bars. Other
 * platforms never render tray titles, so they wear a drawn paperclip instead:
 * the same pixel grid the app icon uses, as a template image (black + alpha).
 */
function trayIcon() {
  try {
    const { encodePng, renderIconPixels } = require('../scripts/package-app');
    const size = 36; // rendered @2x for an 18pt menu bar item
    const black = new Array(16).fill([0, 0, 0]);
    const png = encodePng(size, size, renderIconPixels(size, undefined, black));
    const icon = nativeImage.createFromBuffer(png, { scaleFactor: 2 });
    icon.setTemplateImage(true);
    return icon;
  } catch (err) {
    console.warn('clippy: tray icon render failed, falling back to text:', err.message);
    return nativeImage.createEmpty();
  }
}

function createTray() {
  // A real image, always: an item with only a text title can be swallowed
  // whole by a full menu bar (or the notch), which reads as "Clippy isn't
  // running". The 📎 emoji title is the fallback when even the image fails.
  const icon = trayIcon();
  trayTextFallback = icon.isEmpty();
  tray = new Tray(icon);
  updateTray(); // paints the count (and the fallback clip if needed)
  tray.setToolTip('Clippy for Claude Code + Codex — click for settings');
  // Click toggles the settings window; right-click (or ctrl-click) drops the
  // menu. The menu is *not* attached with setContextMenu, because on macOS that
  // makes the icon swallow left-clicks and we'd never see one.
  tray.on('click', () => toggleSettingsWindow());
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
}

function updateTray() {
  if (!tray) return;
  const { total, waiting } = tracker.counts();
  const attention = attentionItems();
  const terminalAnswers = attention.filter((item) => item.state === 'terminal').length;
  // The dot is deliberately present even with no sessions: the clip is an app
  // icon, while ● says the hook server is awake and ready to hear one. The
  // number beside it remains the number of active sessions, not just whichever
  // ones happen to be waiting.
  const clip = trayTextFallback ? '📎 ' : '';
  tray.setTitle(total > 0 ? `${clip}● ${total}` : `${clip}●`);
  const sessions = `${total} open session${total === 1 ? '' : 's'}`;
  const waitingText = waiting > 0 ? `, ${waiting} waiting on you` : '';
  const attentionText = attention.length
    ? ` — ${attention.length} need${attention.length === 1 ? 's' : ''} attention${
        terminalAnswers ? ` (${terminalAnswers} in terminal)` : ''
      }`
    : '';
  tray.setToolTip(`Clippy is on — ${sessions}${waitingText}${attentionText}. Right-click for sessions.`);
}

function notify(title, body, { silent = true, sessionId, open = 'buddy' } = {}) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent });
  n.on('click', () => {
    if (open === 'terminal') openSessionWindow(sessionId, { point: true });
    else showBuddy(sessionId, { pin: true });
  });
  n.show();
}

/* ---------------- Drive mode (Agent SDK) ---------------- */

const DRIVE_KEY = 'drive';

async function startDriveSession() {
  if (drive) return;
  const picked = await dialog.showOpenDialog({
    title: 'Folder for the Clippy-driven Claude session',
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return;

  drive = new DriveSession({
    cwd: picked.filePaths[0],
    id: DRIVE_KEY,
    send: (event) => sendTo(DRIVE_KEY, { ...event, name: event.name || drive?.name }),
  });
  pushSettingsState();
  sendTo(DRIVE_KEY, { kind: 'drive-open', name: drive.name, cwd: drive.cwd });
  // A Clippy-driven session *is* the UI, so it stays up until the user hides it.
  showBuddy(DRIVE_KEY, { pin: true });
  try {
    await drive.start({ permissionMode: 'default' });
  } catch (err) {
    sendTo(DRIVE_KEY, {
      kind: 'drive-status',
      status: 'error',
      message:
        'Could not start the Agent SDK. Install it with `npm install @anthropic-ai/claude-agent-sdk` ' +
        'and make sure `claude` is logged in. ' +
        String(err && err.message),
    });
  }
}

function stopDriveSession() {
  if (!drive) return;
  drive.stop();
  drive = null;
  pushSettingsState();
  sendTo(DRIVE_KEY, { kind: 'drive-close' });
  hideBuddy(DRIVE_KEY, { unpin: true });
}

/* ---------------- Development mode (the Electron sandbox) ---------------- */

// `npm run dev` — a buddy with no Claude Code behind it, plus a control window
// listing every state it can be in. The browser bench (npm run demo:web) covers
// the same states faster, but only Electron has the real window: placement,
// growing to fit a card, perching, the actual preload bridge. This is where you
// check those.
const SANDBOX = Boolean(process.env.CLIPPY_SANDBOX);

let sandboxWin = null;

/**
 * The little window of buttons. Its stories come from `src/sandbox-scenarios.js`
 * and are handed over after the page loads, so the dev bridge stays down to the
 * one method that plays one.
 */
function openSandbox() {
  if (sandboxWin && !sandboxWin.isDestroyed()) {
    sandboxWin.show();
    return sandboxWin;
  }
  const win = new BrowserWindow({
    width: 300,
    height: 560,
    title: 'Clippy sandbox',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#13161b',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-sandbox.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  sandboxWin = win;
  win.loadFile(path.join(__dirname, 'renderer', 'sandbox.html'));
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.executeJavaScript(`window.renderStories(${JSON.stringify(storyList())});`);
  });
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    if (sandboxWin === win) sandboxWin = null;
  });
  return win;
}

/**
 * Play one story at the dev buddy. The events are the ones the real handlers
 * send, so anything a card does afterwards — growing the window, closing on a
 * click — is the production path. The decisions those clicks send carry made-up
 * request ids, which the broker answers with a harmless `false`.
 */
function playStory(id) {
  const now = Date.now();
  for (const event of eventsFor(id, now)) sendTo(DEV_SESSION, event);
}

/** One buddy on screen from the moment the app starts, and the story list. */
function startSandbox() {
  const buddy = buddyFor(DEV_SESSION, 'sandbox');
  // Nothing will ever ask to see this one, so it has to be kept on screen the
  // same way a user-requested buddy is.
  buddy.pinned = true;
  placeBuddy(buddy, 'compact');
  buddy.win.showInactive();
  openSandbox();
}

// The gallery: every story at once, each on a buddy of its own. Cells are
// sized for a full card side by side, and cards get a hold long enough that
// nothing expires while you're comparing states across the screen.
const GALLERY_CELL_W = WIN_W + 14;
const GALLERY_CELL_H = 520;
const GALLERY_HOLD_SECS = 60 * 60;

/**
 * Show every state at the same time, tiled left-to-right from the top of the
 * screen. Each story buddy is marked `dragged`, which (since the drag fix) is
 * exactly the anchor a gallery wants: the window grows and shrinks around the
 * buddy's own center instead of snapping to the corner-slot layout, whose rows
 * sit far too close for a screen full of open cards.
 */
function showAllStories() {
  const now = Date.now();
  const { workArea } = screen.getPrimaryDisplay();
  const cols = Math.max(1, Math.floor(workArea.width / GALLERY_CELL_W));
  const [compactW, compactH] = compactSize();

  storyList().forEach((story, i) => {
    const key = `sandbox:${story.id}`;
    const buddy = buddyFor(key, story.label);
    buddy.pinned = true;
    buddy.dragged = true;
    const centerX = workArea.x + (i % cols) * GALLERY_CELL_W + GALLERY_CELL_W / 2;
    const bottom = Math.min(
      workArea.y + (Math.floor(i / cols) + 1) * GALLERY_CELL_H,
      workArea.y + workArea.height
    );
    setBuddyBounds(buddy, {
      x: Math.round(centerX - compactW / 2),
      y: bottom - compactH,
      width: compactW,
      height: compactH,
    });
    buddy.win.showInactive();

    // A brand-new window is still loading its renderer; events sent before
    // did-finish-load land on nobody. The settings payload rides the same
    // listener buddyFor registered first, so order stays right.
    const fire = () => {
      for (const event of eventsFor(story.id, now, {
        sessionId: key,
        name: story.label,
        holdSecs: GALLERY_HOLD_SECS,
      })) {
        sendTo(key, event);
      }
    };
    if (buddy.win.webContents.isLoading()) buddy.win.webContents.once('did-finish-load', fire);
    else fire();
  });
}

/** Close every gallery buddy; the main dev buddy stays. */
function clearGallery() {
  for (const key of [...buddies.keys()]) {
    if (key.startsWith('sandbox:') && key !== DEV_SESSION) closeBuddy(key);
  }
}

/* ---------------- Hook handling ---------------- */

function emitPassive(reaction, { osNotification = true } = {}) {
  // Once the agent is moving again, an old terminal hand-off is no longer a
  // recovery path. Removing it here also covers terminal-native approvals,
  // which do not necessarily emit another UserPromptSubmit hook.
  if (
    reaction.kind === 'activity' ||
    reaction.kind === 'failure' ||
    reaction.kind === 'clear' ||
    reaction.kind === 'remove'
  ) {
    forgetAttentionForSession(reaction.sessionId);
  }
  updateTray();

  if (reaction.kind === 'remove') {
    // A session Clippy started outlives the agent inside it: the pane drops to
    // a shell, so the buddy stays and goes back to waiting to be adopted.
    if (!unadoptBuddy(reaction.sessionId)) closeBuddy(reaction.sessionId);
    return;
  }

  // The event always goes to the window, whether or not anything pops up: it
  // is what keeps the badge, the feed and the activity line honest about a
  // session the user happens to be watching directly.
  sendTo(reaction.sessionId, { ...reaction, counts: tracker.counts() });

  // "Still waiting for your reply" about a question Clippy answered a moment
  // ago. Codex leaves its picker on screen after a hook resolves the call, so
  // the CLI still looks as though it is asking and says so — and relaying that
  // sends the user to a terminal to answer something already answered.
  if (reaction.kind === 'attention' && nudgeIsStale(reaction.sessionId)) {
    console.log(`clippy: not relaying "${reaction.name}" waiting — its question was just answered here`);
    return;
  }

  // Show only when Claude is done or wants something; ambient chatter (tool
  // activity, session start, the user typing again) puts Clippy away.
  const action = windowActionFor(reaction.kind);
  if (action === 'hide') {
    hideBuddy(reaction.sessionId);
    return;
  }
  if (action !== 'show') return;

  surface(reaction.sessionId, {
    notification:
      reaction.kind === 'attention' && osNotification
        ? {
            title:
              reaction.urgency === 'urgent' ? `📎 ${reaction.agentName} needs you!` : '📎 Clippy',
            body: reaction.message,
            opts: { silent: reaction.urgency !== 'urgent', sessionId: reaction.sessionId },
          }
        : null,
  });
}

/**
 * Put a buddy on screen, and optionally notify — unless the user is already
 * looking at the window it is about.
 *
 * The check is a couple of milliseconds against a shared, briefly-cached probe,
 * so this is a promise only because asking the window server is. Nothing waits
 * on it but the popping-up itself.
 */
function surface(key, { notification = null, mode = 'full' } = {}) {
  return lookingAtIt(key).then((focused) => {
    if (focused) return false;
    showBuddy(key, { mode });
    if (notification) notify(notification.title, notification.body, notification.opts);
    return true;
  });
}

/* ---------------- "read all": the rest of a message that didn't fit ----------
 *
 * Cards are cut on purpose — a card is a glance, and 4000 characters of plan
 * over someone's desktop is not one. But the cut version is all the renderer
 * ever gets, so a card that ends in "…" has nowhere to grow: the rest of the
 * words are back here. Whatever was cut is kept beside its request id, and the
 * card asks for it when you press "read all".
 *
 * Bounded rather than swept: a handful of the most recent cards is all anyone
 * can be reading, and tying the lifetime to every close path (answered,
 * timed out, passed, session gone) is four more places to get wrong.
 */
const WHOLE_MESSAGE_CAP = 40;
/* How much of a finished turn's sign-off the review card carries. Its own
   number rather than lastAssistantText's default: that default is what the
   *status panel* wants, and this one now has a "read all" behind it. */
const REVIEW_RECAP_CHARS = 600;
const wholeMessages = new Map(); // requestId -> { sessionId, text }

function rememberWhole(requestId, sessionId, text, title = '') {
  if (!text) return;
  wholeMessages.set(requestId, { sessionId, text });
  if (title) readerTitles.set(requestId, title);
  for (const key of [...wholeMessages.keys()].slice(0, wholeMessages.size - WHOLE_MESSAGE_CAP)) {
    wholeMessages.delete(key);
    readerTitles.delete(key);
  }
}

/**
 * Claude Code is about to show a permission dialog. Hold the hook open and
 * let the user answer from Clippy; on timeout/pass return {} so the normal
 * terminal prompt appears (and the Notification hook nudges as before).
 */
async function handlePermissionRequest(payload, ctx) {
  if (!settings.approvals) return {};

  // Already looking at the window that is asking? Then hand the question back
  // to it. Returning {} lets Claude Code put its own prompt up in the terminal
  // the user is typing in — which is both faster to answer and impossible to
  // miss. Holding it here instead would cover that window with a card asking
  // the same thing.
  if (await lookingAtIt(payload?.session_id || 'unknown')) {
    tracker.handle('PermissionRequest', null, payload);
    updateTray();
    return {};
  }

  const reaction = tracker.handle('PermissionRequest', null, payload);
  const agentName = reaction.agentName;
  updateTray();

  const isPlan = payload.tool_name === 'ExitPlanMode';
  const { title, detail, fullDetail } = describeToolCall(payload.tool_name, payload.tool_input);
  const { id, expiresAt, promise } = broker.ask(
    { event: 'PermissionRequest', sessionId: reaction.sessionId },
    APPROVAL_HOLD_MS
  );
  ctx.onClose(() => broker.resolve(id, 'cancel'));

  rememberAttention({
    id,
    sessionId: reaction.sessionId,
    name: reaction.name,
    agentName,
    kind: isPlan ? 'plan' : 'approval',
    title,
  });
  rememberWhole(id, reaction.sessionId, fullDetail, title);
  sendTo(reaction.sessionId, {
    ...reaction,
    counts: tracker.counts(),
    requestId: id,
    tool: payload.tool_name,
    // 'plan' relabels the approval buttons to Approve / Revise in the UI.
    variant: isPlan ? 'plan' : 'tool',
    title,
    detail,
    truncated: Boolean(fullDetail),
    expiresAt,
  });
  showBuddy(reaction.sessionId);
  notify(
    isPlan ? `📎 ${agentName} has a plan` : `📎 ${agentName} needs your approval`,
    `${reaction.name}: ${title}`,
    { silent: false, sessionId: reaction.sessionId }
  );

  const { action, message, timedOut } = await promise;

  if (action === 'pass' || timedOut) moveAttentionToTerminal(id);
  else forgetAttention(id);
  if (action === 'allow' || action === 'deny') {
    tracker.setStatus(reaction.sessionId, WORKING);
  }
  if (action === 'allow' || action === 'deny' || action === 'cancel') {
    hideBuddy(reaction.sessionId); // answered — Claude is off working again
  }
  // pass / timeout: status stays needs_permission — the terminal prompt takes
  // over and the Notification(permission_prompt) hook will nudge passively, so
  // Clippy stays on screen as the reminder.
  updateTray();
  sendTo(reaction.sessionId, {
    kind: 'request-closed',
    requestId: id,
    sessionId: reaction.sessionId,
    outcome: action,
    timedOut,
    counts: tracker.counts(),
  });
  // The prompt is in the terminal now — go stand on it.
  if (action === 'pass' || timedOut) {
    hintAtTerminal(reaction.sessionId);
    if (timedOut) {
      notify('📎 Approval moved to the terminal', `${reaction.name}: ${title}`, {
        silent: false,
        sessionId: reaction.sessionId,
        open: 'terminal',
      });
    }
  }
  return toHookResponse('PermissionRequest', action, message);
}

/**
 * Claude finished a turn. The Stop hook is answered immediately — the chat is
 * never held open — and the review card shows anyway, with no deadline:
 * "Looks good" just puts Clippy away, and typed feedback is typed into the
 * session's terminal as your next message.
 */
let reviewSeq = 0;
const pendingReviews = new Map(); // requestId -> sessionId
const DIRECT_REPLY_REVIEW_GRACE_MS = 15_000;

/**
 * A review holds no hook open, so `hideBuddy` cannot see it through the
 * DecisionBroker. Before putting a buddy away after a review, look across the
 * window it belongs to, which includes the cards of every session wearing the
 * shared window.
 */
function buddyStillHasCards(sessionId) {
  const buddy = buddyOf(sessionId);
  if (!buddy) return false;
  if ([...pendingReviews.values()].some((sid) => buddyOf(sid) === buddy)) return true;
  return broker.list().some((entry) => buddyOf(entry.meta.sessionId) === buddy);
}

/**
 * Is anything on this window still waiting for the user? Cards, and nudges
 * that were actually shown here (one handed to the terminal is the terminal's
 * business now). Asked before an ambient event is allowed to hide the window.
 */
function windowHasBusiness(sessionId) {
  if (buddyStillHasCards(sessionId)) return true;
  const buddy = buddyOf(sessionId);
  if (!buddy) return false;
  for (const item of attentionInbox.values()) {
    if (item.state === 'clippy' && buddyOf(item.sessionId) === buddy) return true;
  }
  return false;
}

async function handleStop(payload) {
  const reaction = tracker.handle('Stop', null, payload);
  const agentName = reaction.agentName;

  // A prompt sent from an owned buddy should finish in that same chat UI. The
  // transcript watcher shows the reply itself; a Stop review card would race
  // it, often recapping the previous turn and then covering the real answer.
  const owned = tmuxRecordFor(reaction.sessionId);
  const directReply = Boolean(
    owned &&
      (owned.awaitingReply || Date.now() - Number(owned.lastDirectReplyAt || 0) < DIRECT_REPLY_REVIEW_GRACE_MS)
  );
  if (directReply) {
    updateTray();
    pokeWatch(reaction.sessionId);
    return {};
  }

  // Watching that window when it finished: the answer is already on screen, so
  // a review card would be recapping something the user just read.
  if (await lookingAtIt(reaction.sessionId)) {
    updateTray();
    return {};
  }

  // Review feedback is typed into the session's terminal, and an OpenClaw
  // session has no terminal window to type into. Plain nudge instead.
  if (!settings.reviewOnStop || payload.agent === 'openclaw') {
    emitPassive(reaction);
    return {};
  }
  updateTray();

  // What Claude actually said right before stopping, if it said anything — a
  // turn that ends on a bare tool call has no recap, and the card falls back
  // to the generic headline.
  // Read the whole sign-off, not the card's worth of it: the card still shows
  // the card's worth, and "read all" has somewhere to go when it doesn't fit.
  const whole = await lastAssistantText(transcriptPathFor(reaction.sessionId), {
    maxChars: FULL_DETAIL_MAX,
  });
  const recap = whole.length > REVIEW_RECAP_CHARS ? `${whole.slice(0, REVIEW_RECAP_CHARS).trim()}…` : whole;
  // The headline is the summary itself: what got done beats "something got
  // done". First non-empty line, clipped to card width; the full recap rides
  // below only when there is more of it than the headline already shows.
  const firstLine = (recap.split('\n').find((l) => l.trim()) || '').trim();
  const short = firstLine.length > 90 ? `${firstLine.slice(0, 90).trim()}…` : firstLine;
  // The headline answers "which request just finished?", while the green row
  // below previews what the agent answered. Transcript parsing already drops
  // injected environment and hook messages, so this is the person's prompt.
  const turns = await readTail(transcriptPathFor(reaction.sessionId), {
    agent: reaction.agent,
    limit: 40,
    maxChars: FULL_DETAIL_MAX,
  });
  const prompt = lastPrompt(turns).replace(/\s+/g, ' ').trim();
  const reviewTitle = `${agentName} Finished`;

  const id = `review-${++reviewSeq}`;
  pendingReviews.set(id, reaction.sessionId);
  rememberWhole(id, reaction.sessionId, whole === recap ? '' : whole, reviewTitle);
  sendTo(reaction.sessionId, {
    ...reaction,
    kind: 'review',
    message: short
      ? `${agentName} finished: “${short}”`
      : `${agentName} finished in “${reaction.name}”. Looks good, or should it keep going?`,
    title: reviewTitle,
    prompt,
    detail: recap,
    truncated: whole !== recap,
    counts: tracker.counts(),
    requestId: id,
    expiresAt: 0, // nothing is held open, so the card has no deadline
  });
  showBuddy(reaction.sessionId);
  notify(`📎 ${agentName} finished`, short || `“${reaction.name}” — review it from Clippy`, {
    silent: true,
    sessionId: reaction.sessionId,
  });
  return {};
}

/** A review card's button: "Looks good" closes this card; feedback becomes a prompt. */
async function resolveReview(id, action, message) {
  const sessionId = pendingReviews.get(id);
  if (!sessionId) return false;
  pendingReviews.delete(id);
  if (action === 'feedback' && message.trim()) {
    tracker.setStatus(sessionId, WORKING);
    updateTray();
    // Typing into the terminal has its own failure messages (no window, no
    // accessibility) — only put Clippy away once the prompt actually landed.
    if (await sendPromptToTerminal(sessionId, message.trim()) && !buddyStillHasCards(sessionId)) {
      hideBuddy(sessionId);
    }
    return true;
  }
  // The renderer removed only this card and paged to the next one. Do not hide
  // that next card just because the completed review itself held no hook open.
  if (!buddyStillHasCards(sessionId)) hideBuddy(sessionId);
  return true;
}

/** The user moved on (typed a prompt, ended the session): the card is moot. */
function closeReviewsFor(sessionId) {
  for (const [id, sid] of pendingReviews) {
    if (sid !== sessionId) continue;
    pendingReviews.delete(id);
    sendTo(sessionId, {
      kind: 'request-closed',
      requestId: id,
      sessionId,
      outcome: 'cancel',
      counts: tracker.counts(),
    });
  }
}

/**
 * Claude or Codex asked a multiple-choice question. Hold the PreToolUse hook
 * open and show the options as buttons. Claude receives updatedInput.answers;
 * Codex receives the selected values as the blocked tool result, because its
 * request_user_input arguments have no pre-filled-answer field.
 * Anything else (dismiss, timeout, Clippy not running) returns {} and the
 * terminal picker takes over exactly as before.
 */
async function handleQuestion(payload, ctx) {
  const reaction = tracker.handle('PreToolUse', null, payload);
  const toolName = payload.tool_name;
  const { title, detail, fullDetail } = describeToolCall(toolName, payload.tool_input);
  const questions = Array.isArray(payload.tool_input?.questions)
    ? payload.tool_input.questions
    : [];
  updateTray();

  // Sitting in that window already: let its own picker appear rather than
  // putting the same question on top of it.
  if (await lookingAtIt(reaction.sessionId)) return {};

  // Answering turned off, or a malformed question -> surface only.
  if (!settings.answerQuestions || questions.length === 0) {
    surfaceQuestion(reaction, title, detail);
    return {};
  }

  // A held question is the session waiting on the user — count it in the badge.
  tracker.setStatus(reaction.sessionId, WAITING);
  updateTray();

  const { id, expiresAt, promise } = broker.ask(
    { event: 'PreToolUse', sessionId: reaction.sessionId },
    QUESTION_HOLD_MS
  );
  ctx.onClose(() => broker.resolve(id, 'cancel'));

  rememberAttention({
    id,
    sessionId: reaction.sessionId,
    name: reaction.name,
    agentName: reaction.agentName,
    kind: 'question',
    title,
  });
  rememberWhole(id, reaction.sessionId, fullDetail, title);
  sendTo(reaction.sessionId, {
    ...reaction,
    kind: 'answer',
    counts: tracker.counts(),
    requestId: id,
    title,
    detail,
    truncated: Boolean(fullDetail),
    questions,
    expiresAt,
  });
  showBuddy(reaction.sessionId);
  notify(`📎 ${reaction.agentName} is asking you`, `${reaction.name}: ${title}`, {
    silent: false,
    sessionId: reaction.sessionId,
  });

  const { action, message, timedOut } = await promise;

  if (action === 'pass' || timedOut) moveAttentionToTerminal(id);
  else forgetAttention(id);
  sendTo(reaction.sessionId, {
    kind: 'request-closed',
    requestId: id,
    sessionId: reaction.sessionId,
    outcome: action,
    timedOut,
    counts: tracker.counts(),
  });

  const reply = toHookResponse('PreToolUse', action, message, {
    toolInput: payload.tool_input,
    source: payload.agent,
    toolName,
  });
  if (reply.hookSpecificOutput) {
    tracker.setStatus(reaction.sessionId, WORKING);
    updateTray();
    justAnswered.set(reaction.sessionId, Date.now());
    // Codex draws its own picker for request_user_input and leaves it on
    // screen when a hook answers the call for it. The agent has the answer and
    // carries on — the widget is simply stale — but the session then reports
    // itself as waiting, and Clippy used to relay that as "still waiting for
    // your reply", pointing at a question that had already been answered.
    dismissCodexPicker(reaction.sessionId, payload.agent);
    hideBuddy(reaction.sessionId); // answered here — the agent carries on
  } else if (action === 'dismiss' || action === 'cancel') {
    // Waved away, or the terminal went out from under us — nothing to show.
    hideBuddy(reaction.sessionId);
  } else {
    // Nobody answered in Clippy — the picker is now up in the terminal, so
    // leave the question on screen as a read-only reminder of where to go.
    surfaceQuestion(reaction, title, detail, { osNotification: false });
    if (timedOut) {
      notify('📎 Question moved to the terminal', `${reaction.name}: ${title}`, {
        silent: false,
        sessionId: reaction.sessionId,
        open: 'terminal',
      });
    }
  }
  return reply;
}

/**
 * Sessions whose question Clippy has just answered.
 *
 * Codex leaves its picker up after a PreToolUse hook resolves the call, so the
 * CLI looks as if it is still asking and duly notifies us that it is waiting.
 * Repeating that back — "still waiting for your reply", with a button to go and
 * answer it — is Clippy nagging about the very thing it just did.
 */
const justAnswered = new Map();

/** How long a nudge about an answered question stays suppressed. */
const ANSWERED_QUIET_MS = 90 * 1000;

function nudgeIsStale(sessionId) {
  const at = justAnswered.get(sessionId);
  if (!at) return false;
  if (Date.now() - at < ANSWERED_QUIET_MS) return true;
  justAnswered.delete(sessionId);
  return false;
}

/**
 * Close the picker Codex left behind, when we are allowed to.
 *
 * Only for a session Clippy started itself: there we own the tmux pane and can
 * send a key without touching anyone's focus or needing Accessibility. Escape
 * is what a person would press — the tool call is already resolved, so
 * cancelling the widget is exactly right and cannot lose an answer.
 *
 * Any other Codex session keeps its stale picker; nothing here can reach it
 * safely, which is what the quiet window above is for.
 */
function dismissCodexPicker(sessionId, agent) {
  if (agent !== 'codex') return;
  const record = tmuxRecordFor(sessionId);
  if (!record) return;
  const target = record.paneId || `=${record.name}`;
  tmux
    .findTmux()
    .then((bin) => bin && tmux.pressKeys(bin, target, 'Escape'))
    .catch(() => {
      // A pane that has gone away is not worth a word: the answer already
      // reached the agent, which is the part that mattered.
    });
}

/** Read-only fallback: show the question, tell the user to answer in the terminal. */
function surfaceQuestion(reaction, title, detail, { osNotification = true } = {}) {
  // No walk here: the read-only card is the hint while it's up. Clippy points
  // at the prompt when the user waves it away (clippy-point, below).
  sendTo(reaction.sessionId, {
    ...reaction,
    kind: 'question',
    counts: tracker.counts(),
    title,
    detail,
    message: `${reaction.agentName} is asking in ${sourceFor(reaction.sessionId).label} — answer there.`,
  });
  surface(reaction.sessionId, {
    notification: osNotification
      ? {
          title: `📎 ${reaction.agentName} is asking you`,
          body: `${reaction.name}: ${title}`,
          opts: { silent: false, sessionId: reaction.sessionId },
        }
      : null,
  });
}

/**
 * Every hook tells us which terminal it fired from. Remember it so the "open
 * this session" button has a window to raise, and let the UI light the button
 * up the first time we learn it.
 */
function noteTerminal(payload, ctx) {
  const sessionId = payload?.session_id || 'unknown';
  // Every payload also points at the session's transcript — that's where the
  // token counts for the right-click panel come from.
  tracker.setTranscript(sessionId, payload?.transcript_path);
  // A hook means this session just did something; its transcript is worth
  // another look now rather than at the end of the current backoff.
  pokeWatch(sessionId);
  const term = terminalFromHeaders(ctx?.headers);
  if (!term) return;
  if (tracker.setTerminal(sessionId, term)) {
    // The pid in that header is how a spawned Codex session finds out its own
    // name — see adoptSpawned. Deliberately not awaited: the hook response
    // must not wait on a process-table sweep.
    adoptSpawned(sessionId).catch(() => {});
    // Which app owns this session is a walk up the process table, so it is done
    // once here rather than on every card — and the answer is what names the
    // button that takes you there.
    learnSourceApp(sessionId, term);
  }
}

/**
 * Work out which app a session is actually running in, and tell its buddy.
 *
 * This is what makes "go to terminal" say the truth: a session in the ChatGPT
 * app, in Claude (which is where a Cowork session lives), or in Ghostty each
 * get their own name on the button, and pressing it goes to that app rather
 * than to a terminal that was never involved.
 *
 * Deliberately not awaited by the hook path — it walks the process table and
 * asks the app bundle for its id, and no hook should wait on either. The
 * button is offered immediately from what we already know; the name gets
 * better a moment later.
 */
async function learnSourceApp(sessionId, term) {
  const now = buddyOf(sessionId);
  if (now) sendCanOpen(now, sessionId);
  const app = await appFor(term);
  if (!app) return;
  const later = buddyOf(sessionId);
  if (later) sendCanOpen(later, sessionId);
}

/**
 * The app a session's terminal belongs to — resolved once, then kept.
 *
 * Kept on the terminal record rather than in a map of its own: it cannot go
 * stale without the terminal record going stale too, and the two are replaced
 * together. The in-flight promise is kept as well, so the several things that
 * want this during a session's first moments share one walk up the process
 * table instead of each starting their own.
 */
function appFor(term) {
  if (!term || !term.pid) return Promise.resolve(null);
  // Terminal.app and iTerm2 are driven by name and tty rather than by pid, so
  // there is no app to resolve — frontmost.js matches those by bundle id.
  if (term.program === TERMINAL_APP || term.program === ITERM_APP) return Promise.resolve(null);
  if (term.app !== undefined) return Promise.resolve(term.app);
  term.appLookup ||= appForPid(term.pid)
    .then((app) => {
      term.app = app || null;
      return term.app;
    })
    .catch(() => {
      term.app = null;
      return null;
    });
  return term.appLookup;
}

/* ---------------- Staying out of the way ---------------- */

/**
 * One shared look at what is in front, reused across a burst of hooks.
 * See src/frontmost.js for why this uses lsappinfo rather than AppleScript.
 */
const focusProbe = createFocusProbe();

/**
 * Is the user already looking at the window this session is asking from?
 *
 * If they are, Clippy has nothing to add: the agent's own prompt is right
 * there on the screen they are typing on, and a paperclip popping up over it —
 * plus a notification about a question three inches from the cursor — is the
 * app being in the way of the thing it exists to help with.
 *
 * Answers false whenever it cannot tell. Being wrong that way shows a buddy
 * that was not strictly needed; being wrong the other way loses the message.
 */
async function lookingAtIt(key) {
  if (!settings.quietWhenFocused) return false;
  // A session in a tmux pane has no window of its own to be looking at.
  if (tmuxRecordFor(key)) return false;
  const term = tracker.terminalFor(key);
  if (!term) return false;
  try {
    // Both at once: which app this session belongs to is a walk up the process
    // table, and it has to be known *before* deciding, or the first hook of a
    // session — the one most likely to arrive while you are sitting in that
    // very window — could never be recognised as one to stay quiet for.
    const [{ front, focusedTty }, app] = await Promise.all([
      focusProbe.current(),
      appFor(term),
    ]);
    return looksFocused({
      front,
      app,
      program: term.program || '',
      tty: term.tty || '',
      focusedTty,
    });
  } catch {
    return false;
  }
}

function handleHookEvent(eventName, kind, payload, ctx) {
  // The hook command tags its source in the local URL. Keep the upstream hook
  // payload untouched on the wire, then carry the source through our session
  // model so one app can label Claude, Codex, and OpenClaw buddies correctly.
  // hasOwn, not a truthy lookup: a `?source=constructor` would otherwise pass.
  const source = ctx?.source;
  payload = { ...(payload || {}), agent: source && Object.hasOwn(AGENTS, source) ? source : 'claude' };
  noteTerminal(payload, ctx);

  if (eventName === 'PermissionRequest') return handlePermissionRequest(payload, ctx);
  if (eventName === 'Stop') return handleStop(payload);

  if (
    eventName === 'PreToolUse' &&
    (payload.tool_name === 'AskUserQuestion' ||
      (payload.agent === 'codex' && payload.tool_name === 'request_user_input'))
  ) {
    return handleQuestion(payload, ctx);
  }

  if (eventName === 'UserPromptSubmit' || eventName === 'SessionEnd') {
    // The user moved on in the terminal — pending cards for this session are moot.
    const sessionId = payload.session_id || 'unknown';
    broker.cancelBySession(sessionId);
    closeReviewsFor(sessionId);
    forgetAttentionForSession(sessionId);
  }

  const reaction = tracker.handle(eventName, kind, payload);
  if (reaction) emitPassive(reaction);
  return undefined;
}

/**
 * Claude Code's statusline: a small 📎 and nothing else, padded over to the
 * right edge when the hook could read the terminal's width (cols is 0 when it
 * couldn't). The clip is an OSC 8 hyperlink, so terminals that support it
 * (iTerm2, Ghostty, kitty, WezTerm) can cmd+click to bring this session's
 * buddy to the front via GET /focus. Unknown session -> empty line -> Claude
 * Code shows nothing, same as when the app isn't running at all.
 */
function statuslineFor(payload = {}, cols = 0) {
  // Nothing. The clip used to sit at the right edge of Claude Code's input box
  // as a link to this session's buddy, but the prompt bar belongs to the agent
  // you are talking to — Clippy is already on screen, and a second one down
  // there was clutter in the one place you are trying to type.
  //
  // Kept as a function rather than deleted: the statusline hook is installed in
  // people's settings already, and answering it with an empty line is what
  // makes it disappear without them having to reinstall anything.
  void payload;
  void cols;
  return '';
}

/* ---------------- App lifecycle ---------------- */

/**
 * Hooks are written once into each agent's user config, so a Clippy that has
 * learned to handle new events (answerable questions, tool failures) can be
 * running against an older install and silently never hear about them. Say so
 * instead of looking broken.
 */
function warnOnHookDrift() {
  const configs = [
    { agent: 'Claude', file: path.join(os.homedir(), '.claude', 'settings.json'), check: checkDrift },
    { agent: 'Codex', file: path.join(os.homedir(), '.codex', 'hooks.json'), check: checkCodexDrift },
    { agent: 'OpenClaw', file: path.join(os.homedir(), '.openclaw', 'openclaw.json'), check: checkOpenclawDrift },
  ];
  const installed = [];
  const stale = [];
  for (const config of configs) {
    try {
      if (!fs.existsSync(config.file)) continue;
      const raw = fs.readFileSync(config.file, 'utf8');
      const drift = config.check(raw.trim() ? JSON.parse(raw) : {}, PORT);
      if (!drift.installed) continue;
      installed.push(config.agent);
      if (drift.missing.length || drift.stale || drift.wrongPort || drift.noTerminalInfo) {
        stale.push({ agent: config.agent, ...drift });
      }
    } catch (err) {
      console.warn(`clippy: could not check ${config.agent} hooks:`, err.message);
    }
  }
  // Re-run after every install, so a fixed state clears the tray warnings.
  hooksAbsent = installed.length === 0;
  hookDrift = stale.length ? { agents: stale } : null;
  if (hooksAbsent) {
    console.warn('clippy: no hooks installed yet — use "Install hooks" in the 📎 menu');
  }
  if (hookDrift) {
    console.warn(
      `clippy: installed hooks are out of date for ${stale.map((d) => d.agent).join(', ')} — ` +
        'use "update them now" in the 📎 menu'
    );
  }
}

/**
 * The one-click path: write the hooks with the very code `npm run hooks:install`
 * uses, then re-check so the menu and warnings reflect the fix immediately.
 * Codex hooks are only written when ~/.codex already exists — no point seeding
 * a config for an agent that isn't there.
 */
function installHooksNow() {
  const agents = ['claude'];
  if (fs.existsSync(path.join(os.homedir(), '.codex'))) agents.push('codex');
  const results = installToFiles({ port: PORT, agents });
  warnOnHookDrift();
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    dialog.showMessageBox({
      type: 'warning',
      message: 'Some hooks could not be installed',
      detail: failed.map((f) => `${f.agent}: ${f.error}`).join('\n'),
    });
    return;
  }
  notify(
    'Hooks installed',
    `${agents.map((a) => (a === 'claude' ? 'Claude Code' : 'Codex')).join(' and ')} will report here — restart any running sessions.`,
    { silent: false }
  );
}

/**
 * A fresh install (the DMG path) has no hooks yet, so the app would just sit
 * silent. Offer the one-click install instead of pointing at a terminal.
 */
async function offerHookInstall() {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    message: 'Install the agent hooks?',
    detail:
      'Clippy sees your sessions through small hooks that POST lifecycle events to ' +
      `127.0.0.1:${PORT} — nothing leaves your machine, and nothing is ever ` +
      'auto-approved. This adds tagged entries to ~/.claude/settings.json ' +
      '(and Codex’s hooks.json, if you use Codex) — only Clippy’s own tagged ' +
      'entries are ever touched, and uninstalling removes exactly those.',
    buttons: ['Install hooks', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) installHooksNow();
}

/** Forget sessions whose terminal vanished, and release anything held for them. */
function sweepStaleSessions() {
  const removed = tracker.sweepStale();
  if (removed.length === 0) return;
  for (const s of removed) {
    broker.cancelBySession(s.sessionId);
    closeReviewsFor(s.sessionId); // a review card for a vanished session is moot
    // Silence is not death for a session we started — tmux still has it, and
    // the transcript watcher is a better judge than a timeout.
    if (!unadoptBuddy(s.sessionId)) closeBuddy(s.sessionId);
  }
  updateTray();
}

/**
 * Stand down, now.
 *
 * `app.quit()` is a *request*: it unwinds asynchronously, and everything after
 * it — the rest of this module, and the whole `whenReady` handler — still
 * runs. A copy that had already lost the menu bar went on to bind the hook
 * port, which then starved the copy that won and left the user with no Clippy
 * at all. Refusing to run has to mean refusing to touch anything.
 */
function standDown(why) {
  console.error(`clippy: ${why}`);
  app.exit(0);
}

// A second instance can't bind the port anyway; failing fast beats racing.
if (!app.requestSingleInstanceLock()) {
  standDown('another Clippy is already running — quitting this one.');
}

/**
 * …and again, machine-wide.
 *
 * The lock above is scoped to the user-data directory, so a copy started with
 * `--user-data-dir` — a dev build, a packaged app beside a checkout — walks
 * straight past it and puts a second paperclip in the menu bar. Two Clippys
 * both answer the same hooks and both pop up, and nothing on screen says which
 * is which. CLIPPY_ALLOW_MULTIPLE=1 is the way out, for when that is genuinely
 * what you want.
 */
function claimTheMenuBar() {
  if (allowsMultiple()) return true;
  const file = lockPath(os.homedir());
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    // Unwritable directory: nothing to claim with, and refusing to start over
    // it would be worse than the duplicate it is meant to prevent.
    return true;
  }

  // Two attempts, and no more: create-or-fail, and if that finds a lock left by
  // something dead, clear it and try the same create once again. A loop here
  // would be two copies taking turns deleting each other's claim.
  for (let attempt = 0; attempt < 2; attempt++) {
    claimedAt = Date.now();
    try {
      claimAtomically(file, writeLock(process.pid, claimedAt));
      onQuit(releaseTheMenuBar(file));
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        console.warn('clippy: could not claim the menu bar lock:', err.message);
        return true; // can't claim it, but that is no reason not to run
      }
    }

    // Somebody holds it. Alive, and it is theirs; dead, and it is litter.
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      raw = null; // vanished between the two calls — go round and take it
    }
    const holder = holderOf(raw, isRunning);
    if (holder) {
      console.error(
        `clippy: another Clippy (pid ${holder}) already has the menu bar. ` +
          'Set CLIPPY_ALLOW_MULTIPLE=1 to run a second on purpose.'
      );
      return false;
    }
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Someone else cleared it first; the next create settles who won.
    }
  }

  // Both attempts lost the race to a copy that is still alive.
  console.error('clippy: another Clippy took the menu bar first.');
  return false;
}

/**
 * Create the lock, with its contents already in it, or fail.
 *
 * `writeFileSync(..., 'wx')` is two steps wearing one name: the file appears
 * empty, and only then does the content arrive. Another copy reading in that
 * gap sees a lock it cannot parse, calls it litter from a crash, deletes it and
 * claims the menu bar for itself — which is how four simultaneous starts left
 * one Clippy running and no lock file at all to stop a fifth.
 *
 * Writing somewhere else and hard-linking it into place closes that gap: the
 * name never exists in a half-written state, and `link` fails with EEXIST if
 * somebody got there first. So an EEXIST here always means a *complete* lock,
 * and "cannot parse it" once again means what it says.
 *
 * @throws {NodeJS.ErrnoException} EEXIST when the menu bar is already claimed
 */
function claimAtomically(file, contents) {
  const scratch = `${file}.${process.pid}`;
  fs.writeFileSync(scratch, contents);
  try {
    fs.linkSync(scratch, file);
  } finally {
    try {
      fs.rmSync(scratch, { force: true });
    } catch {
      // A leftover scratch file is untidy, never harmful — it is named after a
      // pid and is not the lock.
    }
  }
}

/**
 * Give the lock back, but only if it is still ours.
 *
 * A copy quitting late must never delete the claim a healthy one has since
 * written — that is how the file went missing while a Clippy was running, and
 * a missing file is an open door for the next start.
 */
function releaseTheMenuBar(file) {
  return () => {
    try {
      if (holderOf(fs.readFileSync(file, 'utf8'), () => true) === 0) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // already gone, or never ours to remove
    }
  };
}

const onQuit = (fn) => {
  app.on('will-quit', fn);
  process.on('exit', fn);
};

// When this copy claimed the menu bar. Kept so the claim can be re-asserted
// with its *original* time: whoever got there first keeps it, and rewriting
// the timestamp on every heartbeat would make this copy look newer than a
// rival that actually arrived later.
let claimedAt = 0;

/**
 * How often to check we still hold the menu bar.
 *
 * Rare on purpose — this is a file read, and the thing it guards against
 * (a lock that went missing) is not urgent, only persistent.
 */
const DEFEND_EVERY_MS = 30_000;

/**
 * Keep hold of the menu bar, rather than only taking it once.
 *
 * Claiming at startup and never looking again was the gap behind "I restarted
 * it and now there are two": the lock is a file, and once it goes missing —
 * a copy quitting late, a crash between read and write, someone clearing
 * Application Support — the running Clippy stops defending anything and the
 * next start walks in beside it. Nothing tells the user; they just get two
 * paperclips answering the same hooks.
 *
 * See `defend` in src/single-instance.js for the three-way decision. Ties go
 * to the older claim, so two copies can never both leave or both stay.
 */
function defendTheMenuBar() {
  if (allowsMultiple() || !claimedAt) return;
  const file = lockPath(os.homedir());
  let raw = null;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    raw = null;
  }

  const what = defend(raw, isRunning, { pid: process.pid, at: claimedAt });
  if (what === 'keep') return;

  if (what === 'yield') {
    console.error(
      'clippy: another Clippy claimed the menu bar first — quitting this one so there is only ever one.'
    );
    app.quit();
    return;
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, writeLock(process.pid, claimedAt));
  } catch {
    // Unwritable is not worth a dialog: we are still the one running.
  }
}

/**
 * A window Clippy opens can never become somewhere else.
 *
 * Every one of them is a local file behind a preload that can approve a
 * permission request, type a prompt into a terminal, or open a link — and a
 * preload is re-attached on every navigation. So a renderer talked into
 * leaving its own page (a link in text an agent wrote, a meta refresh in
 * something a tool returned, a `window.open`) would hand that bridge to
 * whatever page it landed on. The content policy in each HTML file stops
 * remote *sub-resources*; it says nothing about the document itself moving.
 *
 * There is therefore nowhere to navigate to. A link that should genuinely
 * open goes to the browser through the same validated https path as
 * `clippy-open-external`, and the window stays where it is.
 */
function lockDownNavigation() {
  app.on('web-contents-created', (_e, contents) => {
    const stay = (event, url) => {
      if (url === contents.getURL()) return; // its own page again is not going anywhere
      event.preventDefault();
      console.warn(`clippy: refused to navigate a Clippy window to ${url}`);
    };
    contents.on('will-navigate', stay);
    contents.on('will-frame-navigate', (event) => stay(event, event.url));
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}

lockDownNavigation();

if (!claimTheMenuBar()) standDown('this copy does not have the menu bar.');
setInterval(defendTheMenuBar, DEFEND_EVERY_MS).unref?.();
app.on('second-instance', () => {
  for (const b of buddies.values()) showBuddy(b.sessionId, { pin: true });
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide();

  loadSettings();
  spawned.load(settings.spawnedSessions);
  warnOnHookDrift();
  createTray();
  // Never delay launch on the network. The first check is late enough that a
  // first-run install can settle, and the interval keeps long-running Clippy
  // copies current without polling continuously.
  setTimeout(() => checkForAutomaticUpdate().catch(() => {}), 12_000).unref?.();
  setInterval(() => checkForAutomaticUpdate().catch(() => {}), 24 * 60 * 60 * 1000).unref?.();
  // tmux keeps running when Clippy doesn't, so anything we started and is still
  // alive gets its buddy back. Not awaited: it shells out to tmux, and the app
  // should be up before that finishes.
  restoreSpawned().catch((err) => console.warn('clippy: could not restore sessions:', err.message));
  // The DMG path: first launch has no hooks and no terminal in sight. Ask once
  // per run; the tray menu keeps the same action for later.
  if (hooksAbsent) offerHookInstall();
  setInterval(sweepStaleSessions, SWEEP_INTERVAL_MS).unref?.();

  ipcMain.handle('clippy-context', async (e) => {
    const buddy = buddyForSender(e.sender);
    if (!buddy) return null;
    if (buddy.sessionId.startsWith('sandbox:')) {
      return { session: sandboxUsage(buddy.name).session };
    }
    return { session: await sessionUsage(transcriptPathFor(buddy.sessionId)) };
  });
  // "read all" on a card that ends in an ellipsis. Only ever hands a window
  // the rest of its own session's message.
  /**
   * Open a message in a window of its own.
   *
   * A card is a glance; a plan is a page. The card used to grow instead —
   * "read all" made the same floating panel taller until it ran out of screen,
   * and it still could not be moved to a second display or left open beside
   * the work it describes. This is an ordinary window: resizable, movable,
   * closable and not always-on-top. Finished-turn reviews also carry an
   * explicit reply composer and sign-off action; ordinary long messages remain
   * read-only.
   */
  ipcMain.on('clippy-open-reader', (e, requestId, mine) => {
    const buddy = buddyForSender(e.sender);
    if (!buddy) return;
    const id = String(requestId || '');
    const held = wholeMessages.get(id);
    if (held && buddyOf(held.sessionId) !== buddy) return;
    // A shared buddy may be showing another session's card. Accept that id
    // only when it belongs to this same buddy window; otherwise use the
    // renderer's own session as the safe fallback.
    const requestedSessionId = String(mine?.sessionId || '');
    const sessionId =
      (held && held.sessionId) ||
      (requestedSessionId && buddyOf(requestedSessionId) === buddy ? requestedSessionId : buddy.sessionId);
    const source = sourceFor(sessionId);
    // Main only keeps a copy of what it had to *cut*. Most messages arrive
    // whole and are never stored, so the card's own copy is the text — and is
    // the only one for anything main never truncated.
    const text = (held && held.text) || String(mine?.text || '');
    if (!text) return;
    const review = pendingReviews.has(id);
    openReader({
      title: readerTitles.get(id) || String(mine?.title || '') || 'From the agent',
      where: buddy.name,
      prompt: String(mine?.prompt || ''),
      text,
      sessionId,
      canOpenSource: Boolean(tracker.terminalFor(sessionId) || tmuxRecordFor(sessionId)),
      sourceName: source.name || 'source',
      requestId: id,
      review,
      buddy: mine?.buddy || null,
    });
  });

  ipcMain.on('clippy-reader-open-source', (e) => {
    if (!readerWin || readerWin.isDestroyed() || e.sender !== readerWin.webContents) return;
    if (readerSessionId) openSessionWindow(readerSessionId);
  });

  ipcMain.on('clippy-reader-minimize', (e) => {
    if (!readerWin || readerWin.isDestroyed() || e.sender !== readerWin.webContents) return;
    readerWin.hide();
    if (readerRequestId && pendingReviews.has(readerRequestId) && readerSessionId) {
      showBuddy(readerSessionId);
    }
  });

  ipcMain.on('clippy-reader-decide', async (e, payload) => {
    if (!readerWin || readerWin.isDestroyed() || e.sender !== readerWin.webContents) return;
    const id = readerRequestId;
    const sessionId = readerSessionId;
    const action = String(payload?.action || '');
    const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
    if (!id || !pendingReviews.has(id) || !['ok', 'feedback'].includes(action)) return;
    if (action === 'feedback' && !message) return;
    await resolveReview(id, action, message);
    // The hidden mini renderer did not originate this decision, so explicitly
    // remove its copy before the window can ever be shown again.
    sendTo(sessionId, {
      kind: 'request-closed',
      requestId: id,
      sessionId,
      outcome: action,
      counts: tracker.counts(),
    });
    readerRequestId = '';
    readerSessionId = '';
    // Resolving the review was awaited, and the window can be closed by hand
    // while that is in flight — by then `readerWin` is already gone.
    if (readerWin && !readerWin.isDestroyed()) readerWin.close();
  });

  // Activity is rendered as a short, ellipsized chip under the buddy. Let a
  // click turn it into a normal reader window instead of making the buddy's
  // tiny always-on-top window try to hold a page of text.
  ipcMain.on('clippy-open-activity-reader', (e, payload) => {
    const buddy = buddyForSender(e.sender);
    if (!buddy) return;
    const title = String(payload?.title || 'Activity log').trim() || 'Activity log';
    const text = String(payload?.text || '');
    if (!text) return;
    const sessionId = buddy.sessionId;
    const source = sourceFor(sessionId);
    openReader({
      title,
      where: buddy.name,
      text,
      sessionId,
      canOpenSource: Boolean(tracker.terminalFor(sessionId) || tmuxRecordFor(sessionId)),
      sourceName: source.name || 'source',
    });
  });

  ipcMain.handle('clippy-card-full', (e, requestId) => {
    const buddy = buddyForSender(e.sender);
    const held = buddy && wholeMessages.get(String(requestId || ''));
    if (!held || held.sessionId !== buddy.sessionId) return '';
    return held.text;
  });
  ipcMain.handle('clippy-usage', (e) => {
    const buddy = buddyForSender(e.sender);
    if (!buddy) return null;
    // A sandbox buddy has no transcript to read and no session behind it, so
    // the panel is fed canned numbers rather than showing empty bars.
    if (buddy.sessionId.startsWith('sandbox:')) return sandboxUsage(buddy.name);
    return collectUsage(buddy.sessionId);
  });
  /* ---- The "start an agent somewhere" window ---- */

  ipcMain.on('clippy-newagent-ready', (e) => {
    e.sender.send('clippy-newagent-state', {
      agents: Object.entries(tmux.SPAWNABLE).map(([id, { label }]) => ({ id, label })),
      defaultAgent: settings.defaultAgent,
      recentProjects: settings.recentProjects,
      chatWorkspace: chatWorkspace(os.homedir()),
    });
  });

  ipcMain.handle('clippy-newagent-browse', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(newAgentWin || undefined, {
      title: 'Folder for the new session',
      buttonLabel: 'Choose',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.recentProjects.find((p) => !p.host)?.path || os.homedir(),
    });
    return canceled || !filePaths?.length ? '' : filePaths[0];
  });

  ipcMain.handle('clippy-newagent-start', async (_e, target) => {
    if (target?.mode === 'chat') {
      const record = await spawnChat(target?.agent);
      if (!record) return { error: 'That chat session could not be started.' };
      closeNewAgentWindow();
      return { ok: true };
    }
    const host = String(target?.host || '').trim();
    const record = await spawnAgent({
      path: String(target?.path || '').trim(),
      host,
      remotePath: String(target?.remotePath || '').trim(),
      agent: target?.agent,
    });
    // spawnAgent explains its own failures in a dialog; the form just stays put.
    if (!record) return { error: 'That session could not be started.' };
    closeNewAgentWindow();
    return { ok: true };
  });

  ipcMain.on('clippy-newagent-close', closeNewAgentWindow);

  // The "recent messages" panel, opened after the pushes it missed. Reads the
  // transcript fresh rather than replaying what the watcher happened to catch.
  ipcMain.handle('clippy-feed', async (e) => {
    const buddy = buddyForSender(e.sender);
    if (!buddy) return null;
    const record = tmuxRecordFor(buddy.sessionId);
    const source = record ? (record.host ? `via ${record.host}` : `tmux · ${record.name}`) : '';
    const file = transcriptPathFor(buddy.sessionId);
    // A remote transcript is not ours to open, so the watcher's running record
    // of it is the history — there is nothing else to read.
    if (!file) return { source, turns: (record && record.recentTurns) || [] };
    const agent = record ? record.agent : tracker.agentFor(buddy.sessionId);
    return { source, turns: await readTail(file, { agent, limit: FEED_TURNS, maxChars: 1200 }) };
  });
  ipcMain.handle('clippy-session-identity', async (e) => {
    const buddy = buddyForSender(e.sender);
    if (!buddy) return null;
    // The renderer polls this until a model shows up, so answer from what the
    // hooks already reported before falling back to reading the transcript —
    // and read it with the cheap single-pass scan, not a full usage parse.
    let model = tracker.modelFor(buddy.sessionId) || '';
    if (!model) {
      model = buddy.sessionId.startsWith('sandbox:')
        ? sandboxUsage(buddy.name).session?.model || ''
        : await modelFromTranscriptFile(transcriptPathFor(buddy.sessionId));
    }
    return { name: buddy.name, agent: buddy.agent, model };
  });
  ipcMain.on('clippy-mode', (e, payload) => {
    // The renderer knows whether it has anything on screen, and how tall that
    // is; main owns where the window goes and how big it may get.
    const buddy = buddyForSender(e.sender);
    const { mode, height, width, anchor } =
      typeof payload === 'string' ? { mode: payload } : payload || {};
    if (buddy && (mode === 'full' || mode === 'compact')) {
      // Where the buddy stands inside the window it is asking for. Kept so the
      // resize can grow the window around him rather than move him.
      if (anchor && Number.isFinite(anchor.dx) && Number.isFinite(anchor.fromBottom)) {
        buddy.anchorIn = {
          dx: Number(anchor.dx),
          fromBottom: Number(anchor.fromBottom),
          halfW: Number(anchor.halfW) || 0,
          halfH: Number(anchor.halfH) || 0,
        };
      }
      placeBuddy(buddy, mode, Number(height), Number(width));
    }
  });
  ipcMain.on('clippy-open-window', (e, opts) => {
    const buddy = buddyForSender(e.sender);
    if (buddy) openSessionWindow(buddy.sessionId, { point: Boolean(opts && opts.point) });
  });
  ipcMain.on('clippy-settings-ready', (e) => {
    // The window is up and asking for its first paint of the world.
    if (settingsWin && !settingsWin.isDestroyed()) {
      e.sender.send('clippy-settings-state', settingsState());
    }
  });
  ipcMain.on('clippy-settings-new-agent', () => openNewAgentWindow());
  ipcMain.on('clippy-open-settings', () => openSettingsWindow());
  ipcMain.handle('clippy-settings-install-pet', async (_e, url) => {
    // The "add a pet" box takes a pasted link only — local folders stay a CLI
    // affair, so this window never reads arbitrary paths off the disk. https
    // only: a pack downloaded in the clear is sprite files, a theme.json and a
    // path prefix, all of them written into the app's own assets folder by
    // whoever happens to be between here and the server.
    const src = String(url || '').trim();
    if (!/^https:\/\//i.test(src)) return { ok: false, error: 'paste the pet’s page link (https://…)' };
    try {
      const { installPack } = require('../scripts/add-sprite-pack');
      const { id, theme } = await installPack(src);
      forgetFaces(); // a new pack is a new member of the cast
      pushSettingsState(); // the cast re-reads the themes folder, so this repaints it
      return { ok: true, id, label: theme.label };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('clippy-settings-create-pet', (_e, drawing) => {
    try {
      const { createDrawnBuddy } = require('./custom-buddies');
      const result = createDrawnBuddy(drawing || {});
      forgetFaces();
      pushSettingsState();
      sendSettings();
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('clippy-settings-remove-pet', (_e, character) => {
    try {
      const { removeCustomBuddy } = require('./custom-buddies');
      const removed = removeCustomBuddy(character);
      forgetFaces();
      for (const key of ['characterByProject', 'characterBySession']) {
        settings[key] = Object.fromEntries(
          Object.entries(settings[key] || {}).filter(([, value]) => value !== removed)
        );
      }
      saveSettings();
      recast();
      pushSettingsState();
      sendSettings();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.on('clippy-fix', (e, what) => {
    // The "fix it" button on a sticky message.
    const buddy = buddyForSender(e.sender);
    if (what === 'accessibility') askForWindowAccess(buddy?.sessionId || null, { force: true });
  });
  ipcMain.on('clippy-open-external', (_e, url) => {
    // Only ever hand the OS an https link — this window must not become a
    // browser, and it must not be talked into opening anything else.
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
  });
  ipcMain.on('clippy-settings-fix', (_e, what) => {
    if (what === 'accessibility') askForWindowAccess(null, { force: true });
    if (what === 'copy-path') clipboard.writeText(appBundlePath());
    pushSettingsState();
  });
  /**
   * Feedback from the settings window.
   *
   * Main does the posting rather than the renderer: the endpoint would
   * otherwise have to be opened up in the window's CSP, and the one outbound
   * call carrying user words would live in the least sandboxed process. What
   * goes out is built by src/feedback.js and nothing else is added here — the
   * version is the only thing main contributes.
   */
  ipcMain.handle('clippy-settings-feedback', async (_e, input) => {
    return sendFeedback({
      rating: input && input.rating,
      message: input && input.message,
      appVersion: app.getVersion(),
    });
  });

  ipcMain.handle('clippy-settings-check-updates', () => {
    // The repo root: from a checkout that's this file's parent; inside the
    // packaged app it's Contents/Resources/app, which has no .git — and the
    // checker reports exactly that instead of guessing.
    return checkForUpdates(path.join(__dirname, '..'));
  });
  ipcMain.handle('clippy-settings-install-update', () => installLatestUpdate());
  ipcMain.on('clippy-settings-show', (_e, sessionId) => {
    if (sessionId) showBuddy(String(sessionId), { pin: true });
  });
  ipcMain.on('clippy-point', (e) => {
    // "You have to answer this in the terminal" — walk over and show them where.
    const buddy = buddyForSender(e.sender);
    if (buddy) hintAtTerminal(buddy.sessionId);
  });
  ipcMain.on('clippy-move-by', (e, { dx, dy } = {}) => {
    // The renderer's hand-rolled drag: move this buddy's window by a delta.
    // Plain setPosition on purpose — the 'moved' listener sees the result land
    // away from lastPlaced and marks the buddy dragged, exactly like a native
    // drag did before.
    const buddy = buddyForSender(e.sender);
    if (!buddy || buddy.win.isDestroyed()) return;
    const at = buddy.win.getBounds();
    const wanted = {
      ...at,
      x: at.x + Math.round(Number(dx) || 0),
      y: at.y + Math.round(Number(dy) || 0),
    };
    // He may be carried until his own edge meets the edge of the screen — the
    // window is welcome to hang off it — but never past that and out of reach.
    const { workArea } = screen.getDisplayMatching(at);
    const spot = keepBuddyOnScreen(wanted, workArea, buddy);
    buddy.win.setPosition(spot.x, spot.y);
    // Carried across the middle of the screen: where he'll settle has changed.
    sendSide(buddy);
  });
  ipcMain.on('clippy-hide', (e, opts) => {
    const buddy = buddyForSender(e.sender);
    if (!buddy) {
      BrowserWindow.fromWebContents(e.sender)?.hide();
      return;
    }
    // Clicking elsewhere after dealing with Clippy puts it away but keeps a
    // perch or pin you asked for; the Hide button also drops the pin, so the
    // ambient rules take over again.
    if (opts && opts.lookedAway === true) hideBuddy(buddy.sessionId, { lookedAway: true });
    else hideBuddy(buddy.sessionId, { unpin: true });
  });
  ipcMain.on('clippy-quit', () => app.quit());
  ipcMain.on('clippy-counts', updateTray);
  // Defaults on every destructured payload: an `ipcMain.on` handler that
  // throws takes the main process with it, and "the renderer sent nothing" is
  // one bad call away in any window that has this bridge.
  ipcMain.on('clippy-decide', (_e, { id, action, message } = {}) => {
    const a = String(action || '');
    const m = typeof message === 'string' ? message : '';
    // Ids are globally unique; review cards first (they hold nothing open),
    // then the hook broker, then the Drive session.
    if (pendingReviews.has(id)) {
      resolveReview(id, a, m);
      return;
    }
    if (!broker.resolve(id, a, m)) drive?.resolve(id, a, m);
  });
  ipcMain.on('clippy-extend', (e, id) => {
    const expiresAt = broker.extend(id) || drive?.extend(id);
    if (expiresAt) {
      e.sender.send('clippy-event', { kind: 'extended', requestId: id, expiresAt });
    }
  });
  ipcMain.on('clippy-set-setting', (_e, { key, value } = {}) => setSetting(key, value));
  ipcMain.on('clippy-drive-prompt', (_e, text) => {
    if (drive && typeof text === 'string' && text.trim()) drive.prompt(text.trim());
  });
  ipcMain.on('clippy-drive-stop', stopDriveSession);
  /**
   * "Who is this for?" — the routing half of talking to the buddy.
   *
   * Answers with a *proposal*, never a delivery. Nothing reaches an agent until
   * the user presses send on what comes back, because a prompt typed into a
   * session becomes work in somebody's repository and cannot be recalled.
   */
  ipcMain.handle('clippy-delegate', async (e, text) => {
    const buddy = buddyForSender(e.sender);
    if (!buddy) return { agent: null };
    const roster = tracker.list().map((s) => ({
      sessionId: s.sessionId,
      name: s.name,
      agent: s.agent,
      cwd: s.cwd || '',
      status: s.status,
      reachable: Boolean(tmuxRecordFor(s.sessionId) || tracker.terminalFor(s.sessionId)),
    }));
    if (!routable(roster).length) return { agent: null };

    const asked = await chatFor(buddy).ask(routingPrompt(roster, text));
    if (asked.error) return { agent: null, error: asked.error };
    const { agent, why } = parseChoice(asked.text, roster);
    if (!agent) return { agent: null };
    return { agent: { sessionId: agent.sessionId, name: agent.name, agent: agent.agent }, why };
  });

  ipcMain.handle('clippy-pet-say', async (e, text) => {
    // The 💬 button under the buddy: a word with the pet itself. Nothing here
    // touches the watched session — see src/pet-chat.js for why it can't.
    const buddy = buddyForSender(e.sender);
    if (!buddy) return { error: 'no session for this window' };
    return chatFor(buddy).say(typeof text === 'string' ? text : '');
  });
  ipcMain.on('clippy-sandbox-fire', (_e, id) => {
    if (!SANDBOX) return;
    // Two ids are the sandbox's own controls rather than stories: the
    // gallery of everything at once, and putting it away again.
    if (id === '__all__') return showAllStories();
    if (id === '__clear__') return clearGallery();
    playStory(String(id || ''));
  });
  ipcMain.on('clippy-send-prompt', (e, text, to) => {
    // The prompt composer: type what you wrote into a session's terminal.
    const buddy = buddyForSender(e.sender);
    if (!buddy || typeof text !== 'string') return;
    // A shared buddy can address any live session, not only the one it is
    // currently wearing — but only a session that actually exists.
    const target = to && tracker.list().some((s) => s.sessionId === to) ? to : buddy.sessionId;
    sendPromptToTerminal(target, text);
  });

  /** Who is running, for the chat panel's "who am I talking to" row. */
  ipcMain.handle('clippy-agents', (e) => {
    const buddy = buddyForSender(e.sender);
    return {
      // Whose face the window is wearing right now, so the panel can preselect.
      showing: buddy ? buddy.sessionId : '',
      pet: petNameOf(buddy),
      agents: tracker.list().map((s) => ({
        sessionId: s.sessionId,
        name: s.name,
        agent: s.agent,
        status: s.status,
        // The folder itself, not just its last component: two agents in
        // ~/work/api and ~/side/api are both "api", and picking the wrong one
        // means typing into the wrong session.
        cwd: s.cwd || '',
        // Its face and colour, so the chat can wear them while you are talking
        // to it — the buddy you are addressing should look like that agent, not
        // like the one whose window you happen to be typing in.
        // `buddies.get`, not `buddyOf`: the latter falls back to the shared
        // window, which would report the manager's face for every agent and
        // make them all look identical in the one place they must not.
        character: buddies.get(s.sessionId)?.character || characterFor(settings, s.name, s.sessionId),
        color: identityFor(s.sessionId, s.name).color,
        // Typing at an agent needs somewhere to type: a tmux pane we own, or a
        // terminal window we can find.
        reachable: Boolean(tmuxRecordFor(s.sessionId) || tracker.terminalFor(s.sessionId)),
      })),
    };
  });

  // The hook server still comes up in development mode — a real session can
  // report in alongside the sandbox, and nothing here interferes with it.
  if (SANDBOX) startSandbox();

  const server = createHookServer({
    port: PORT,
    onEvent: handleHookEvent,
    onStatusline: statuslineFor,
    onFocus: (sessionId) => showBuddy(sessionId, { pin: true }),
    getStatus: () => ({
      sessions: tracker.list(),
      counts: tracker.counts(),
      settings: { ...settings },
      pending: broker.list(),
      windows: [...buddies.values()].map((b) => ({
        sessionId: b.sessionId,
        name: b.name,
        slot: b.slot,
        visible: !b.win.isDestroyed() && b.win.isVisible(),
        pinned: b.pinned,
      })),
      ...(hookDrift ? { hookDrift } : {}),
    }),
  });
  try {
    await server.listenOn();
    console.log(`clippy: listening for Claude Code and Codex hooks on 127.0.0.1:${PORT}`);
  } catch (err) {
    console.error(
      `clippy: could not bind 127.0.0.1:${PORT} (${err.code}). ` +
        'Is another Clippy running? Set CLIPPY_PORT to use a different port.'
    );
    app.quit();
  }
});

// Menu-bar style app: keep running with every window hidden/closed.
app.on('window-all-closed', () => {});
