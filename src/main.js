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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHookServer } = require('./server');
const { SessionTracker, WORKING, WAITING } = require('./sessions');
const { DecisionBroker, toHookResponse, describeToolCall } = require('./decisions');
const { DriveSession } = require('./sdk-session');
const { checkDrift } = require('../bin/clippy-hooks');
const { identityFor } = require('./identity');
const { SIZES, sizeList, allCharacters, characterFor } = require('./characters');
const { ACTIONS } = require('./actions');
const { windowActionFor } = require('./visibility');
const {
  terminalFromHeaders,
  resolveTarget,
  revealWindow,
  windowBounds,
  dockPosition,
  promptPosition,
  typeAndSubmit,
} = require('./terminal');
const { sessionUsage, lastAssistantText, usageWindows, planLimitsFor, cleanLimits, PLANS } =
  require('./usage');
const { DEV_SESSION, eventsFor, storyList, devUsage } = require('./dev-scenarios');

const PORT = Number(process.env.CLIPPY_PORT || 43117);

// Clippy is a small paperclip by default — the size it is when perched on a
// window — and only takes the full window when there's a card to read.
const WIN_W = 268;
const WIN_H = 470; // fallback until the renderer reports what it needs
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
const REVIEW_HOLD_MS = Number(process.env.CLIPPY_REVIEW_HOLD_SECS || 30) * 1000;
const QUESTION_HOLD_MS = Number(process.env.CLIPPY_QUESTION_HOLD_SECS || 90) * 1000;

// How often to drop sessions whose terminal went away without a SessionEnd.
const SWEEP_INTERVAL_MS = 60 * 1000;

const tracker = new SessionTracker();
const broker = new DecisionBroker({ hardCapMs: 100_000 });
let drive = null; // the active Clippy-driven (Agent SDK) session, if any
let tray = null;
let hookDrift = null; // set when the installed hooks are older than this build

/* ---------------- Settings (persisted across restarts) ---------------- */

const settings = {
  approvals: true, // answer permission requests from the Clippy UI
  reviewOnStop: true, // offer a review box when Claude finishes a turn
  answerQuestions: true, // answer AskUserQuestion from the Clippy UI
  autoPerch: true, // appear on the session's own window, not the screen corner
  characterByProject: {}, // project name -> character id, when you've picked one
  size: 'medium', // how big that buddy is drawn, and stays
  plan: 'unknown', // which plan's allowance the usage bars are measured against
  planLimits: {}, // your own token allowances, when the plan is "custom"
};

// Settings that aren't simple on/off switches, with the values they accept.
const CHOICES = {
  size: () => Object.keys(SIZES),
  plan: () => PLANS.map((p) => p.id),
};

// The cast is read fresh each time so a sprite theme dropped into
// `src/renderer/assets/themes/` can be assigned without touching the code.
const characterIds = () => allCharacters().map((c) => c.id);

const settingsFile = () => path.join(app.getPath('userData'), 'clippy-settings.json');

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    // Only the keys this build still has. A file written by an older one can
    // carry retired settings — `characterMode` and the single `character` it
    // picked, from when you chose *how* buddies were cast — and copying those
    // back in would keep writing them out forever.
    for (const key of Object.keys(settings)) if (key in saved) settings[key] = saved[key];
  } catch {
    // first run / unreadable -> defaults
  }
}

/** Give one project a buddy of its own (or '' to go back to the automatic one). */
function assignCharacter(name, character) {
  if (!name) return;
  const next = { ...settings.characterByProject };
  if (character && characterIds().includes(character)) next[name] = character;
  else delete next[name];
  settings.characterByProject = next;
  saveSettings();
  recast();
  pushSettingsState();
  sendSettings();
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('clippy: could not save settings', err);
  }
}

function setSetting(key, value) {
  if (!(key in settings) || key === 'characterByProject') return;
  if (key === 'planLimits') {
    // Numbers you typed yourself, so they get sanity-checked rather than cast.
    settings.planLimits = cleanLimits(value);
  } else if (CHOICES[key]) {
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
}

/**
 * What a renderer gets: the settings plus the rosters it builds menus from, so
 * the cast and the size steps are defined in exactly one place.
 *
 * A buddy is told which character *it* is, which is the only "selected
 * character" the app has: every project is cast on its own, so the settings
 * window is handed the sessions and their buddies instead.
 */
function settingsPayload(buddy) {
  return {
    ...settings,
    ...(buddy ? { character: buddy.character } : null),
    characters: allCharacters(),
    sizes: sizeList(),
    plans: PLANS,
  };
}

function sendSettings() {
  for (const buddy of buddies.values()) {
    buddy.win.webContents.send('clippy-settings', settingsPayload(buddy));
  }
}

/** Re-cast every buddy — a project was given a buddy of its own. */
function recast() {
  for (const buddy of buddies.values()) {
    buddy.character = characterFor(settings, buddy.name);
  }
}

/** The window that holds nothing but the buddy, at the size you picked. */
function compactSize() {
  return (SIZES[settings.size] || SIZES.medium).win;
}

/** Re-lay every buddy — the size setting changed under them. */
function replaceAll() {
  for (const buddy of buddies.values()) {
    if (!buddy.win.isDestroyed()) placeBuddy(buddy, buddy.mode || 'compact');
  }
}

/* ---------------- Settings window ---------------- */

let settingsWin = null;

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

  settingsWin = new BrowserWindow({
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

  settingsWin.loadFile(
    path.join(__dirname, 'renderer', 'settings.html'),
    section ? { hash: section } : undefined
  );
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  return settingsWin;
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

/** Everything the settings window draws itself from. */
function settingsState() {
  return {
    ...settingsPayload(),
    actions: ACTIONS,
    port: PORT,
    // Can we raise other apps' windows? Everything about perching depends on it.
    windowAccess: canDriveWindows(),
    appName: path.basename(appBundlePath(), '.app'),
    appPath: appBundlePath(),
    sessions: tracker.list().map((s) => ({
      sessionId: s.sessionId,
      name: s.name,
      color: identityFor(s.sessionId, s.name).color,
      status: s.status,
      // Who this session's buddy is right now — which is what "Auto" means in
      // the picker next to it.
      character: buddies.get(s.sessionId)?.character || characterFor(settings, s.name),
    })),
  };
}

function pushSettingsState() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('clippy-settings-state', settingsState());
  }
}

/* ---------------- One Clippy per session ---------------- */

// key -> { win, slot, name, sessionId, pinned }. The key is the session id (or
// `drive:<id>`); every session that reports in gets its own little buddy so
// several parallel agents never fight over one window.
const buddies = new Map();

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
 * The one door in and out of moving a buddy's window. `lastPlaced` is what
 * tells the `moved` listener a bounds change was ours, not your hand on the
 * paperclip — so every programmatic move, including mid-walk, has to go
 * through here to keep that in sync.
 */
function setBuddyBounds(buddy, bounds) {
  buddy.win.setBounds(bounds);
  buddy.lastPlaced = { x: bounds.x, y: bounds.y };
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
  const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(hi, v)));
  const current = buddy.win.getBounds();
  const centre = current.x + current.width / 2;
  const bottom = current.y + current.height;
  return {
    x: clamp(centre - width / 2, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bottom - height, workArea.y, workArea.y + workArea.height - height),
  };
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
 */
function buddyFor(key, name = '') {
  const existing = buddies.get(key);
  if (existing) {
    if (name && name !== existing.name) {
      existing.name = name;
      existing.win.webContents.send('clippy-identity', { name });
    }
    return existing;
  }

  const slot = nextFreeSlot();
  const [compactW, compactH] = compactSize();
  const { x, y } = cornerBounds(slot, compactW, compactH);
  const identity = identityFor(key, name);
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
    },
  });
  // CLIPPY_DEVTOOLS=1 npm start opens an inspector per buddy, detached so it
  // never fights the transparent always-on-top window for space — the fast
  // way to iterate on the cards/menu/bubble without a real Claude Code turn.
  if (process.env.CLIPPY_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('clippy-settings', settingsPayload(buddies.get(key)));
    // Only offer "open the session's window" when we actually know where it is.
    win.webContents.send('clippy-event', {
      kind: 'can-open',
      value: Boolean(tracker.terminalFor(key)),
    });
  });
  win.on('closed', () => buddies.delete(key));
  // Every reposition we do ourselves goes through placeBuddy, which records
  // exactly where it put the window. A `moved` that lands anywhere else is
  // you dragging him by hand — from then on his own spot outranks the corner
  // or the perch anchor, until you explicitly ask him to go somewhere (go to
  // terminal, unperch).
  win.on('moved', () => {
    const b = buddies.get(key);
    if (!b) return;
    const [x, y] = win.getPosition();
    const placed = b.lastPlaced;
    if (placed && x === placed.x && y === placed.y) return;
    b.dragged = true;
  });

  const buddy = {
    win,
    slot,
    name: identity.name,
    sessionId: key,
    pinned: false,
    dock: null,
    dragged: false, // moved by hand — placeBuddy grows around that spot instead
    lastPlaced: { x, y }, // matches the constructor's own placement, above
    // Cast once, when this session first reports in, and only re-cast when you
    // give the project a buddy by hand.
    character: characterFor(settings, identity.name),
  };
  buddies.set(key, buddy);
  pushSettingsState();
  return buddy;
}

/** Which buddy does this renderer belong to? */
function buddyForSender(sender) {
  const win = BrowserWindow.fromWebContents(sender);
  return [...buddies.values()].find((b) => b.win === win) || null;
}

/** Send an event to one session's Clippy, creating its window if needed. */
function sendTo(sessionId, event) {
  if (!sessionId) return null;
  const buddy = buddyFor(sessionId, event?.name);
  buddy.win.webContents.send('clippy-event', event);
  return buddy;
}

function closeBuddy(key) {
  const buddy = buddies.get(key);
  if (!buddy) return;
  if (buddy.dock) clearInterval(buddy.dock.timer);
  buddies.delete(key);
  if (!buddy.win.isDestroyed()) buddy.win.destroy();
  pushSettingsState();
}

/**
 * Pop a Clippy up without stealing focus from the terminal. `pin` marks the
 * window as one the user asked to see (tray, Drive mode), so the ambient
 * hide-again rules leave it alone until they hide it themselves.
 */
function showBuddy(key, { pin = false, mode = 'full' } = {}) {
  const buddy = buddies.get(key);
  if (!buddy || buddy.win.isDestroyed()) return;
  if (pin) buddy.pinned = true;

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
    if (perched || buddy.win.isDestroyed()) return;
    placeBuddy(buddy, mode);
    buddy.win.showInactive();
  });
}

/** Slip back out of sight once the moment has passed. */
function hideBuddy(key, { unpin = false } = {}) {
  const buddy = buddies.get(key);
  if (!buddy || buddy.win.isDestroyed()) return;
  if (unpin) {
    buddy.pinned = false;
    undock(buddy);
    buddy.win.hide();
    return;
  }
  // Something is still waiting on an answer from this card — don't yank it away.
  if (broker.hasPending(key)) return;
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
 * display.
 */
function placeBuddy(buddy, mode, wantHeight) {
  if (buddy.win.isDestroyed()) return;
  // Mid-stroll the walk owns the window's position; whoever wants it back
  // calls stopWalking first.
  if (buddy.walk) return;
  buddy.mode = mode;
  if (Number.isFinite(wantHeight) && wantHeight > 0) buddy.wantHeight = wantHeight;
  const compact = mode === 'compact';
  const [compactW, compactH] = compactSize();
  const width = compact ? compactW : WIN_W;
  const workArea = buddy.dock
    ? screen.getDisplayMatching(buddy.dock.bounds).workArea
    : screen.getPrimaryDisplay().workArea;
  const height = compact
    ? compactH
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
    : cornerBounds(buddy.slot, width, height);

  setBuddyBounds(buddy, { ...spot, width, height });
  buddy.win.webContents.send('clippy-event', {
    kind: 'dock',
    docked: Boolean(buddy.dock),
    compact,
  });
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
  const buddy = buddies.get(key);
  if (!buddy || buddy.win.isDestroyed()) return false;

  // Already perched: a "go to terminal" click just raises the window again.
  if (buddy.dock) {
    if (raise) {
      buddy.dock.auto = false; // now it's a perch you asked for
      buddy.pinned = true;
      buddy.dragged = false; // "go to terminal" means go back to the perch
      const bounds = await revealTarget(buddy, key);
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
    const bounds = raise ? await revealTarget(buddy, key) : await measureTarget(buddy, key);
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

    buddy.dock = { target: buddy.target, bounds, misses: 0, lastError: '', auto, timer: null };
    if (!auto) buddy.pinned = true; // asked for by hand -> stays until dismissed
    if (raise) buddy.dragged = false; // asked to go to the terminal -> that's where he goes
    // A held card needs the full window; a quiet perch is just the paperclip.
    placeBuddy(buddy, mode || (broker.hasPending(key) ? 'full' : 'compact'));
    buddy.win.showInactive();
    buddy.dock.timer = setInterval(() => followWindow(key), DOCK_POLL_MS);
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

/** The "go to terminal" button: raise that session's window and ride along. */
/**
 * Raise a session's window and ride over to it. `point` follows that up with
 * the walk to the prompt — used when the reason you're going there is that
 * something is waiting to be answered on that line.
 */
const openSessionWindow = (key, { point = false } = {}) =>
  perchOn(key, { raise: true }).then((perched) => {
    if (perched && point) hintAtTerminal(key);
    return perched;
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
  const buddy = buddies.get(key);
  const prompt = String(text || '').trim();
  if (!buddy || !prompt) return false;

  if (!canDriveWindows()) {
    askForWindowAccess(key);
    return false;
  }
  try {
    const bounds = await revealTarget(buddy, key);
    if (!bounds) {
      tellBuddy(key, "I couldn't find that session's window to type into — is the terminal still open?", {
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
      if (key && buddies.has(key)) {
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
async function followWindow(key) {
  const buddy = buddies.get(key);
  if (!buddy || !buddy.dock || buddy.win.isDestroyed()) return;
  let bounds = null;
  try {
    bounds = await windowBounds(buddy.dock.target);
  } catch (err) {
    // permission revoked, app quit, or a transient AppleEvent error
    buddy.dock.lastError = err.message;
  }
  if (!buddy.dock) return; // undocked while we were asking
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
  stopWalking(buddy);
  clearInterval(buddy.dock.timer);
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

  for (const fresh of [false, true]) {
    if (fresh) buddy.target = null;
    const term = tracker.terminalFor(key);
    if (!term) return null;

    try {
      // The project name goes along for the ride: an editor with several
      // project windows open titles each one after its folder, which is how we
      // pick the right one instead of guessing.
      buddy.target ||= await resolveTarget(term, hint);
      if (!buddy.target) continue;
      const bounds = measureOnly
        ? await windowBounds(buddy.target)
        : await revealWindow(buddy.target);
      if (bounds) return bounds;
    } catch (err) {
      lastError = err;
    }
  }

  if (lastError) throw lastError;
  return null;
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
  const buddy = buddies.get(key);
  if (!buddy || buddy.win.isDestroyed() || !buddy.dock || !buddy.win.isVisible()) return;
  if (buddy.mode !== 'compact') return; // a card is up; that's the louder hint
  stopWalking(buddy);

  const [w, h] = compactSize();
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
      send(buddy, { kind: 'walk', facing: 'right' });
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
  buddy.walk = null;
  send(buddy, { kind: 'walk', facing: 'right' });
  send(buddy, { kind: 'point', on: false });
}

/**
 * "It's over there now" — the card just went back to the terminal. Give the
 * renderer a moment to shrink back to a bare buddy, then walk him to the
 * prompt if we're perched on that window.
 */
function hintAtTerminal(key) {
  setTimeout(() => pointAtPrompt(key), 400);
}

/** Send straight to a buddy we already have in hand. */
function send(buddy, event) {
  if (buddy && !buddy.win.isDestroyed()) buddy.win.webContents.send('clippy-event', event);
}

/** Say something in a buddy's bubble (used for "that didn't work" news). */
/**
 * Say something in the buddy's speech bubble.
 *
 * `sticky` is for the messages you have to act on — a permission macOS won't
 * grant, a window we can't find. Those used to fade after four seconds, which
 * is exactly long enough to read half of it and not long enough to do anything
 * about it, so they now sit there until dismissed.
 */
function tellBuddy(key, message, { sticky = false, fix = null } = {}) {
  const buddy = buddies.get(key);
  if (!buddy || buddy.win.isDestroyed()) return;
  placeBuddy(buddy, 'full');
  buddy.win.webContents.send('clippy-event', { kind: 'info', message, sticky, fix });
  buddy.win.showInactive();
}

// Once a day at most, and only while the plan is still unset — Claude Code
// never writes down what you're allowed, so the moment you're most likely to
// actually go run `/usage` and come back with a number is right when a fresh
// conversation starts.
const PLAN_NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
let lastPlanNudgeAt = 0;

function maybeNudgePlanCalibration(payload) {
  if (!['startup', 'clear'].includes(payload.source)) return;
  if (settings.plan !== 'unknown') return;
  if (Date.now() - lastPlanNudgeAt < PLAN_NUDGE_COOLDOWN_MS) return;
  lastPlanNudgeAt = Date.now();
  tellBuddy(
    payload.session_id || 'unknown',
    "New conversation — want your token bars to mean something? Run /usage, then tell me the " +
      'number under Settings → Usage & limits.',
    { fix: 'plan' }
  );
}

/* ---------------- Token usage (right-click) ---------------- */

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const USAGE_CACHE_MS = 60 * 1000;
let usageCache = { at: 0, windows: null };

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
  const session = await sessionUsage(tracker.transcriptFor(key));
  const now = Date.now();
  if (now - usageCache.at > USAGE_CACHE_MS) {
    usageCache = { at: now, windows: await usageWindows(PROJECTS_DIR, now) };
  }
  const plan = PLANS.find((p) => p.id === settings.plan) || PLANS[0];
  return {
    name: buddies.get(key)?.name || '',
    session,
    windows: usageCache.windows,
    now,
    limits: planLimitsFor(settings),
    plan: { id: plan.id, label: plan.label, estimated: Boolean(plan.estimated) },
  };
}

/* ---------------- Tray ---------------- */

function trayMenu() {
  const sessionItems = [...buddies.values()].map((b) => ({
    label: b.name,
    submenu: [
      { label: 'Show Clippy', click: () => showBuddy(b.sessionId, { pin: true }) },
      {
        label: b.dock ? 'Open window again' : 'Open session window',
        enabled: Boolean(tracker.terminalFor(b.sessionId)),
        click: () => openSessionWindow(b.sessionId),
      },
      ...(b.dock
        ? [{ label: 'Unperch', click: () => hideBuddy(b.sessionId, { unpin: true }) }]
        : []),
    ],
  }));

  return Menu.buildFromTemplate([
    { label: 'Settings…', click: () => openSettingsWindow() },
    { type: 'separator' },
    {
      label: buddies.size ? `Show all (${buddies.size})` : 'No sessions yet',
      enabled: buddies.size > 0,
      click: () => {
        for (const b of buddies.values()) showBuddy(b.sessionId, { pin: true });
      },
    },
    {
      label: 'Hide all',
      enabled: buddies.size > 0,
      click: () => {
        for (const b of buddies.values()) hideBuddy(b.sessionId, { unpin: true });
      },
    },
    ...(sessionItems.length ? [{ type: 'separator' }, ...sessionItems] : []),
    { type: 'separator' },
    drive
      ? { label: `Stop Clippy-driven session (${drive.name})`, click: stopDriveSession }
      : { label: 'New Clippy-driven session…', click: startDriveSession },
    { type: 'separator' },
    // The quick switches stay a click away; the window has the rest.
    { label: 'Quick settings', submenu: globalSettingsMenu() },
    { type: 'separator' },
    ...(hookDrift
      ? [
          { label: '⚠ Hooks are out of date — run `npm run hooks:install`', enabled: false },
          { type: 'separator' },
        ]
      : []),
    { label: `Hook server: 127.0.0.1:${PORT}`, enabled: false },
    { label: 'Quit', click: () => app.quit() },
  ]);
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
      label: 'Review when Claude finishes',
      type: 'checkbox',
      checked: settings.reviewOnStop,
      click: (item) => setSetting('reviewOnStop', item.checked),
    },
    { type: 'separator' },
    { label: 'Appearance', enabled: false },
    { label: 'Character', submenu: radios('character', allCharacters()) },
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
    { type: 'separator' },
    {
      label: 'Fix window access (Accessibility)…',
      click: () => askForWindowAccess(null, { force: true }),
    },
  ];
}

function createTray() {
  // Empty image + emoji title gives us a menu bar presence on macOS
  // without shipping icon assets.
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('📎');
  tray.setToolTip('Clippy for Claude Code — click for settings');
  // Click opens the settings window; right-click (or ctrl-click) drops the
  // menu. The menu is *not* attached with setContextMenu, because on macOS that
  // makes the icon swallow left-clicks and we'd never see one.
  tray.on('click', () => openSettingsWindow());
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu()));
}

function updateTray() {
  if (!tray) return;
  const { waiting } = tracker.counts();
  tray.setTitle(waiting > 0 ? `📎 ${waiting}` : '📎');
}

function notify(title, body, { silent = true, sessionId } = {}) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent });
  n.on('click', () => showBuddy(sessionId, { pin: true }));
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

/* ---------------- Development mode (the Electron storybook) ---------------- */

// `npm run dev` — a buddy with no Claude Code behind it, plus a control window
// listing every state it can be in. The browser bench (npm run demo:web) covers
// the same states faster, but only Electron has the real window: placement,
// growing to fit a card, perching, the actual preload bridge. This is where you
// check those.
const DEV = Boolean(process.env.CLIPPY_DEV);

let storyWin = null;

/**
 * The little window of buttons. Its stories come from `src/dev-scenarios.js`
 * and are handed over after the page loads, so the dev bridge stays down to the
 * one method that plays one.
 */
function openStorybook() {
  if (storyWin && !storyWin.isDestroyed()) {
    storyWin.show();
    return storyWin;
  }
  storyWin = new BrowserWindow({
    width: 300,
    height: 560,
    title: 'Clippy storybook',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#13161b',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-dev.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  storyWin.loadFile(path.join(__dirname, 'renderer', 'dev.html'));
  storyWin.webContents.on('did-finish-load', () => {
    storyWin.webContents.executeJavaScript(
      `window.renderStories(${JSON.stringify(storyList())});`
    );
  });
  storyWin.once('ready-to-show', () => storyWin.show());
  storyWin.on('closed', () => {
    storyWin = null;
  });
  return storyWin;
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
function startDevMode() {
  const buddy = buddyFor(DEV_SESSION, 'storybook');
  // Nothing will ever ask to see this one, so it has to be kept on screen the
  // same way a user-requested buddy is.
  buddy.pinned = true;
  placeBuddy(buddy, 'compact');
  buddy.win.showInactive();
  openStorybook();
}

/* ---------------- Hook handling ---------------- */

function emitPassive(reaction, { osNotification = true } = {}) {
  updateTray();

  if (reaction.kind === 'remove') {
    closeBuddy(reaction.sessionId);
  } else {
    sendTo(reaction.sessionId, { ...reaction, counts: tracker.counts() });
    // Show only when Claude is done or wants something; ambient chatter (tool
    // activity, session start, the user typing again) puts Clippy away.
    const action = windowActionFor(reaction.kind);
    if (action === 'show') showBuddy(reaction.sessionId);
    else if (action === 'hide') hideBuddy(reaction.sessionId);
  }

  if (reaction.kind === 'attention' && osNotification) {
    notify(
      reaction.urgency === 'urgent' ? '📎 Claude needs you!' : '📎 Clippy',
      reaction.message,
      { silent: reaction.urgency !== 'urgent', sessionId: reaction.sessionId }
    );
  }
}

/**
 * Claude Code is about to show a permission dialog. Hold the hook open and
 * let the user answer from Clippy; on timeout/pass return {} so the normal
 * terminal prompt appears (and the Notification hook nudges as before).
 */
async function handlePermissionRequest(payload, ctx) {
  if (!settings.approvals) return {};

  const reaction = tracker.handle('PermissionRequest', null, payload);
  updateTray();

  const isPlan = payload.tool_name === 'ExitPlanMode';
  const { title, detail } = describeToolCall(payload.tool_name, payload.tool_input);
  const { id, expiresAt, promise } = broker.ask(
    { event: 'PermissionRequest', sessionId: reaction.sessionId },
    APPROVAL_HOLD_MS
  );
  ctx.onClose(() => broker.resolve(id, 'cancel'));

  sendTo(reaction.sessionId, {
    ...reaction,
    counts: tracker.counts(),
    requestId: id,
    tool: payload.tool_name,
    // 'plan' relabels the approval buttons to Approve / Revise in the UI.
    variant: isPlan ? 'plan' : 'tool',
    title,
    detail,
    expiresAt,
  });
  showBuddy(reaction.sessionId);
  notify(
    isPlan ? '📎 Claude has a plan' : '📎 Claude needs your approval',
    `${reaction.name}: ${title}`,
    { silent: false, sessionId: reaction.sessionId }
  );

  const { action, message, timedOut } = await promise;

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
  if (action === 'pass' || timedOut) hintAtTerminal(reaction.sessionId);
  return toHookResponse('PermissionRequest', action, message);
}

/**
 * Claude finished a turn. If review mode is on, hold the Stop hook briefly:
 * "looks good" (or timeout) lets Claude stop; typed feedback blocks the stop
 * and sends Claude back to work with that feedback.
 */
async function handleStop(payload, ctx) {
  const reaction = tracker.handle('Stop', null, payload);

  if (!settings.reviewOnStop) {
    emitPassive(reaction);
    return {};
  }
  updateTray();

  const { id, expiresAt, promise } = broker.ask(
    { event: 'Stop', sessionId: reaction.sessionId },
    REVIEW_HOLD_MS
  );
  ctx.onClose(() => broker.resolve(id, 'cancel'));

  // What Claude actually said right before stopping, if it said anything — a
  // turn that ends on a bare tool call has no recap, and the card just won't
  // show one.
  const recap = await lastAssistantText(tracker.transcriptFor(reaction.sessionId));

  sendTo(reaction.sessionId, {
    ...reaction,
    kind: 'review',
    message: `Claude finished in “${reaction.name}”. Looks good, or should it keep going?`,
    detail: recap,
    counts: tracker.counts(),
    requestId: id,
    expiresAt,
  });
  showBuddy(reaction.sessionId);
  notify('📎 Claude finished', `“${reaction.name}” — review it from Clippy`, {
    silent: true,
    sessionId: reaction.sessionId,
  });

  const { action, message, timedOut } = await promise;

  sendTo(reaction.sessionId, {
    kind: 'request-closed',
    requestId: id,
    sessionId: reaction.sessionId,
    outcome: action,
    timedOut,
    counts: tracker.counts(),
  });

  if (action === 'feedback' && message.trim()) {
    tracker.setStatus(reaction.sessionId, WORKING);
    updateTray();
    hideBuddy(reaction.sessionId); // sent back to work — nothing to look at
    return toHookResponse('Stop', action, message);
  }
  if (!timedOut) hideBuddy(reaction.sessionId); // reviewed ("looks good") or cancelled
  if (timedOut) {
    // Nobody reviewed in time — degrade to the classic passive nudge (without
    // a second OS notification; one was shown when the review card appeared).
    emitPassive(reaction, { osNotification: false });
  }
  return {};
}

/**
 * Claude called AskUserQuestion. Hold the PreToolUse hook open and show the
 * options as buttons: the chosen labels go back as `updatedInput.answers`, so
 * the tool runs already-answered and the terminal picker never appears.
 * Anything else (dismiss, timeout, Clippy not running) returns {} and the
 * terminal picker takes over exactly as before.
 */
async function handleQuestion(payload, ctx) {
  const reaction = tracker.handle('PreToolUse', null, payload);
  const { title, detail } = describeToolCall('AskUserQuestion', payload.tool_input);
  const questions = Array.isArray(payload.tool_input?.questions)
    ? payload.tool_input.questions
    : [];
  updateTray();

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

  sendTo(reaction.sessionId, {
    ...reaction,
    kind: 'answer',
    counts: tracker.counts(),
    requestId: id,
    title,
    detail,
    questions,
    expiresAt,
  });
  showBuddy(reaction.sessionId);
  notify('📎 Claude is asking you', `${reaction.name}: ${title}`, {
    silent: false,
    sessionId: reaction.sessionId,
  });

  const { action, message, timedOut } = await promise;

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
  });
  if (reply.hookSpecificOutput) {
    tracker.setStatus(reaction.sessionId, WORKING);
    updateTray();
    hideBuddy(reaction.sessionId); // answered here — Claude carries on
  } else if (action === 'dismiss' || action === 'cancel') {
    // Waved away, or the terminal went out from under us — nothing to show.
    hideBuddy(reaction.sessionId);
  } else {
    // Nobody answered in Clippy — the picker is now up in the terminal, so
    // leave the question on screen as a read-only reminder of where to go.
    surfaceQuestion(reaction, title, detail, { osNotification: false });
  }
  return reply;
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
    message: `Claude is asking in “${reaction.name}” — answer in your terminal.`,
  });
  showBuddy(reaction.sessionId);
  if (osNotification) {
    notify('📎 Claude is asking you', `${reaction.name}: ${title}`, {
      silent: false,
      sessionId: reaction.sessionId,
    });
  }
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
  const term = terminalFromHeaders(ctx?.headers);
  if (!term) return;
  if (tracker.setTerminal(sessionId, term)) {
    const buddy = buddies.get(sessionId);
    if (buddy && !buddy.win.isDestroyed()) {
      buddy.win.webContents.send('clippy-event', { kind: 'can-open', value: true });
    }
  }
}

function handleHookEvent(eventName, kind, payload, ctx) {
  noteTerminal(payload, ctx);

  if (eventName === 'PermissionRequest') return handlePermissionRequest(payload, ctx);
  if (eventName === 'Stop') return handleStop(payload, ctx);

  if (eventName === 'PreToolUse' && payload.tool_name === 'AskUserQuestion') {
    return handleQuestion(payload, ctx);
  }

  if (eventName === 'UserPromptSubmit' || eventName === 'SessionEnd') {
    // The user moved on in the terminal — pending cards for this session are moot.
    broker.cancelBySession(payload.session_id || 'unknown');
  }

  const reaction = tracker.handle(eventName, kind, payload);
  if (reaction) emitPassive(reaction);
  if (eventName === 'SessionStart') maybeNudgePlanCalibration(payload);
  return undefined;
}

/* ---------------- App lifecycle ---------------- */

/**
 * Hooks are written once into ~/.claude/settings.json, so a Clippy that has
 * learned to handle new events (answerable questions, tool failures) can be
 * running against an older install and silently never hear about them. Say so
 * instead of looking broken.
 */
function warnOnHookDrift() {
  try {
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    const raw = fs.readFileSync(file, 'utf8');
    const drift = checkDrift(raw.trim() ? JSON.parse(raw) : {}, PORT);
    if (!drift.installed) {
      console.warn('clippy: no hooks installed yet — run `npm run hooks:install`');
      return;
    }
    if (drift.missing.length || drift.wrongPort || drift.noTerminalInfo) {
      hookDrift = drift;
      console.warn(
        `clippy: installed hooks are out of date — run \`npm run hooks:install\`` +
          (drift.missing.length ? `\n  missing: ${drift.missing.join(', ')}` : '') +
          (drift.wrongPort ? `\n  some hooks don't point at port ${PORT}` : '') +
          (drift.noTerminalInfo ? `\n  they don't report which terminal window a session is in` : '')
      );
    }
  } catch (err) {
    console.warn('clippy: could not check installed hooks:', err.message);
  }
}

/** Forget sessions whose terminal vanished, and release anything held for them. */
function sweepStaleSessions() {
  const removed = tracker.sweepStale();
  if (removed.length === 0) return;
  for (const s of removed) {
    broker.cancelBySession(s.sessionId);
    closeBuddy(s.sessionId);
  }
  updateTray();
}

// A second instance can't bind the port anyway; failing fast beats racing.
if (!app.requestSingleInstanceLock()) {
  console.error('clippy: another Clippy is already running — quitting this one.');
  app.quit();
}
app.on('second-instance', () => {
  for (const b of buddies.values()) showBuddy(b.sessionId, { pin: true });
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.hide();

  loadSettings();
  warnOnHookDrift();
  createTray();
  setInterval(sweepStaleSessions, SWEEP_INTERVAL_MS).unref?.();

  ipcMain.handle('clippy-usage', (e) => {
    const buddy = buddyForSender(e.sender);
    if (!buddy) return null;
    // A storybook buddy has no transcript to read and no session behind it, so
    // the panel is fed canned numbers rather than showing empty bars.
    if (buddy.sessionId.startsWith('dev:')) return devUsage(buddy.name);
    return collectUsage(buddy.sessionId);
  });
  ipcMain.on('clippy-mode', (e, payload) => {
    // The renderer knows whether it has anything on screen, and how tall that
    // is; main owns where the window goes and how big it may get.
    const buddy = buddyForSender(e.sender);
    const { mode, height } = typeof payload === 'string' ? { mode: payload } : payload || {};
    if (buddy && (mode === 'full' || mode === 'compact')) placeBuddy(buddy, mode, Number(height));
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
  ipcMain.on('clippy-open-settings', () => openSettingsWindow());
  ipcMain.on('clippy-fix', (e, what) => {
    // The "fix it" button on a sticky message.
    const buddy = buddyForSender(e.sender);
    if (what === 'accessibility') askForWindowAccess(buddy?.sessionId || null, { force: true });
    if (what === 'plan') openSettingsWindow('limits');
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
  ipcMain.on('clippy-settings-assign', (_e, payload) => {
    const { name, character } = payload || {};
    assignCharacter(String(name || ''), String(character || ''));
  });
  ipcMain.on('clippy-settings-show', (_e, sessionId) => {
    if (sessionId) showBuddy(String(sessionId), { pin: true });
  });
  ipcMain.on('clippy-point', (e) => {
    // "You have to answer this in the terminal" — walk over and show them where.
    const buddy = buddyForSender(e.sender);
    if (buddy) hintAtTerminal(buddy.sessionId);
  });
  ipcMain.on('clippy-hide', (e) => {
    // Hiding by hand also drops the pin, so ambient rules take over again.
    const buddy = buddyForSender(e.sender);
    if (buddy) hideBuddy(buddy.sessionId, { unpin: true });
    else BrowserWindow.fromWebContents(e.sender)?.hide();
  });
  ipcMain.on('clippy-quit', () => app.quit());
  ipcMain.on('clippy-counts', updateTray);
  ipcMain.on('clippy-decide', (_e, { id, action, message }) => {
    const a = String(action || '');
    const m = typeof message === 'string' ? message : '';
    // Ids are globally unique; try the hook broker, then the Drive session.
    if (!broker.resolve(id, a, m)) drive?.resolve(id, a, m);
  });
  ipcMain.on('clippy-extend', (e, id) => {
    const expiresAt = broker.extend(id) || drive?.extend(id);
    if (expiresAt) {
      e.sender.send('clippy-event', { kind: 'extended', requestId: id, expiresAt });
    }
  });
  ipcMain.on('clippy-set-setting', (_e, { key, value }) => setSetting(key, value));
  ipcMain.on('clippy-drive-prompt', (_e, text) => {
    if (drive && typeof text === 'string' && text.trim()) drive.prompt(text.trim());
  });
  ipcMain.on('clippy-drive-stop', stopDriveSession);
  ipcMain.on('clippy-dev-fire', (_e, id) => {
    if (DEV) playStory(String(id || ''));
  });
  ipcMain.on('clippy-send-prompt', (e, text) => {
    // The prompt composer: type what you wrote into the session's terminal.
    const buddy = buddyForSender(e.sender);
    if (buddy && typeof text === 'string') sendPromptToTerminal(buddy.sessionId, text);
  });

  // The hook server still comes up in development mode — a real session can
  // report in alongside the storybook, and nothing here interferes with it.
  if (DEV) startDevMode();

  const server = createHookServer({
    port: PORT,
    onEvent: handleHookEvent,
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
    console.log(`clippy: listening for Claude Code hooks on 127.0.0.1:${PORT}`);
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
