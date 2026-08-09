'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('./identity');

/**
 * Who Clippy can be, and how big.
 *
 * Pure data with no Electron in sight, because three places need the same
 * list: the main process (menus, settings validation), the renderer (its own
 * menu, via the settings payload), and the web test bench.
 *
 * Every character is original art drawn in this repo. The pixel cast is built
 * by `npm run make-buddies` into `src/renderer/assets/themes/<id>/`; vector
 * characters are live SVG created by `src/renderer/vector-buddies.js`.
 */

/**
 * The vocabulary every character speaks. A buddy is asked for a pose by name
 * and shows whatever it has for it; anything missing falls back to `excited`
 * and then `idle`, so a pack that only ships two animations still works.
 */
const POSES = [
  'idle', // quiet, nothing to do
  'think', // Claude is working
  'excited', // this session wants you
  'stress', // a tool failed, or the context window is filling up
  'walk', // on the move — played while walking to a prompt
  'point', // standing at the prompt, pointing at the line
  'sleep', // the turn is over, nothing left to do
  'cheer', // a turn finished cleanly
  'wave', // hello — this session just started
];

const CHARACTERS = [
  { id: 'clip', label: 'Clippy', poses: POSES, perColour: true },
  { id: 'cat', label: 'Pixel cat', poses: POSES },
  // A squat terracotta box in the spirit of a certain mascot — he was already
  // pixel art, so this is a transcription; the name keeps a polite distance.
  // One colour, like the cat: Clod is that orange.
  { id: 'clod', label: 'Clod', poses: POSES },
  { id: 'orbit', label: 'Orbit', poses: POSES, vector: 'orbit', usesColour: true },
  // The paperclip again, but drawn as live SVG: the same wire, smooth at any
  // size, recoloured per session by CSS-free markup instead of baked GIFs.
  // A different name so both clips can sit in the menu side by side.
  { id: 'loopy', label: 'Loopy', poses: POSES, vector: 'loopy', usesColour: true },
];

/**
 * How big a buddy is drawn, and the window that holds nothing but him. Pixel
 * art only looks right at whole multiples, so the main steps are 2x, 3x and 4x
 * the 32x40 sprite; XS is the deliberate exception (see below).
 *
 * The size is per project, like the character: a repo you watch out of the
 * corner of your eye can be XS while the one you're working in is large.
 */
// The compact window is the buddy plus headroom for everything hover reveals
// around him: the three-line identity plate above and the small controls below
// (~24px) — all rendered invisible until hover, so revealing them never
// resizes the window. Short-changing this is how the plate got clipped at the
// top once: the stage bottom-anchors, so missing room comes out of whatever
// sits highest. The width is the plate's, not the buddy's: its lines are the
// same size at every buddy size, and the longest one ("Claude Code · " plus a
// model id) needs ~190px to sit on one line instead of wrapping or ellipsizing.
const SIZES = {
  // XS is for a screen with six sessions on it, where fitting is the point.
  // 1.5x the 32px drawn sprite looks like it breaks the whole-multiple rule,
  // but the pixel that has to come out whole is the device one: at 2x that is
  // exactly 3 device pixels per drawn pixel, so it stays crisp on the Retina
  // screen this runs on. (On a 1x external monitor it is the one soft step.)
  xs: { buddy: 48, win: [190, 186] },
  small: { buddy: 64, win: [190, 206] },
  medium: { buddy: 96, win: [190, 234] },
  large: { buddy: 128, win: [210, 262] },
};

/**
 * The size list as the menus want it: an ordered array with ids attached.
 * `win` rides along so anything standing in for the main process (the web test
 * bench) sizes its window exactly the way main does.
 */
const sizeList = () => Object.entries(SIZES).map(([id, s]) => ({ id, buddy: s.buddy, win: s.win }));

const THEMES_DIR = path.join(__dirname, 'renderer', 'assets', 'themes');

/**
 * Bring your own buddy: any folder under `src/renderer/assets/themes/` that
 * holds a `theme.json` becomes a character in the menus, drawn from PNG sprite
 * sheets instead of the generated GIFs.
 *
 *   themes/my-cat/theme.json
 *   {
 *     "label": "🐈 My cat",
 *     "frameWidth": 32, "frameHeight": 32, "fps": 6,
 *     "facing": "right",
 *     "idle":    { "file": "idle.png",    "frames": 4 },
 *     "excited": { "file": "excited.png", "frames": 6 }
 *   }
 *
 * `facing` says which way the art is drawn — "right" (the default), "left", or
 * "center" for art that looks straight out of the screen. Clippy turns a buddy
 * around by mirroring the sprite, so a pack drawn facing left needs to say so
 * or it will walk backwards, and a "center" pack is never mirrored at all.
 * Any single animation can override it (see `poses` below), because a sheet
 * that walks to the left often sits facing the viewer.
 *
 * Packs that put every animation in one grid — a row per animation, which is
 * how most pet sprite sheets ship — say so instead, and can name as many of the
 * poses as the sheet actually has:
 *
 *   { "frameWidth": 192, "frameHeight": 208, "columns": 8, "rows": 9,
 *     "poses": {
 *       "idle":    { "file": "spritesheet.webp", "row": 0, "frames": 6,
 *                    "facing": "center" },
 *       "excited": { "file": "spritesheet.webp", "row": 3, "frames": 4 },
 *       "walk":    { "file": "spritesheet.webp", "row": 1, "frames": 8,
 *                    "facing": "left" }
 *     } }
 *
 * Sprite packs stay *out* of this repo — that folder is gitignored, so whatever
 * you drop in keeps its own licence and never ends up redistributed here.
 */
function customThemes(dir = THEMES_DIR) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // no assets built yet
  }

  const themes = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'theme.json');
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // a generated character, or a theme.json we can't read
    }
    const sheet = readSheet(raw, entry.name);
    if (sheet) {
      themes.push({
        id: entry.name,
        label: raw.label || entry.name,
        sheet,
        // Which way the art is drawn. Packs disagree — one fox faces right, the
        // next faces left — and the renderer mirrors the sprite to turn it
        // around, so it has to know which way "not mirrored" already points.
        // 'center' is art drawn facing the viewer: mirroring it says nothing,
        // so it is left alone whichever way the buddy is headed.
        facing: facing(raw.facing) || 'right',
      });
    } else {
      console.warn(`clippy: ignoring themes/${entry.name} — theme.json is incomplete`);
    }
  }
  return themes;
}

/**
 * Which way art is drawn, if it says: 'left', 'right', or 'center' for art that
 * looks straight out of the screen and must never be mirrored. Anything else —
 * including nothing at all — is null, meaning "inherit".
 */
const facing = (value) => (['left', 'right', 'center'].includes(value) ? value : null);

/** Validate the bits the renderer has to have, or return null. */
function readSheet(raw, id) {
  const read = (p) =>
    p && typeof p.file === 'string' && Number(p.frames) > 0
      ? {
          file: `assets/themes/${id}/${p.file}`,
          frames: Math.floor(Number(p.frames)),
          row: Math.max(0, Math.floor(Number(p.row) || 0)),
          // Per animation, because packs are not consistent with themselves:
          // a sheet can walk to the left and sit facing the viewer. Unset here
          // means "whichever way the pack as a whole is drawn".
          ...(facing(p.facing) ? { facing: facing(p.facing) } : null),
        }
      : null;

  // Poses live under `poses`, but a sheet that only names idle/excited at the
  // top level (the shape this started as) still reads.
  const named = { ...raw, ...(raw.poses || {}) };
  const poses = {};
  for (const name of POSES) {
    const pose = read(named[name]);
    if (pose) poses[name] = pose;
  }

  const frameWidth = Math.floor(Number(raw.frameWidth));
  const frameHeight = Math.floor(Number(raw.frameHeight));
  if (!poses.idle || !(frameWidth > 0) || !(frameHeight > 0)) return null;

  // A pack with only one animation just reuses it when Clippy gets excited.
  if (!poses.excited) poses.excited = poses.idle;

  const all = Object.values(poses);
  return {
    frameWidth,
    frameHeight,
    // How big the whole image is, in frames — needed to scale the background.
    // A plain one-row strip doesn't have to spell it out.
    columns: Math.max(1, Math.floor(Number(raw.columns)) || Math.max(...all.map((p) => p.frames))),
    rows: Math.max(1, Math.floor(Number(raw.rows)) || Math.max(...all.map((p) => p.row)) + 1),
    fps: Number(raw.fps) > 0 ? Number(raw.fps) : 6,
    poses,
  };
}

/** Everything the menus offer: the drawn cast plus whatever you dropped in. */
function allCharacters() {
  const custom = customThemes().filter((t) => !CHARACTERS.some((c) => c.id === t.id));
  return [...CHARACTERS, ...custom];
}

/**
 * How big a buddy is drawn.
 *
 * Same two levels as the character: a size picked for one session is that
 * buddy's own, a size picked for a project is the folder's standing preference,
 * and everything else falls back to the one global default. Kept here beside
 * the cast so main, the settings window and the test bench all agree.
 */
function sizeFor(settings, name, sessionId = '') {
  // This one session first: two agents in the same folder are two buddies, and
  // resizing one of them must not resize its twin.
  const own = (settings.sizeBySession || {})[sessionId];
  if (own && SIZES[own]) return own;
  const assigned = (settings.sizeByProject || {})[name];
  if (assigned && SIZES[assigned]) return assigned;
  return SIZES[settings.size] ? settings.size : 'medium';
}

/**
 * Which character this session's buddy should be.
 *
 * A session id picks the starting point in the cast. `used` lets main avoid
 * giving two live sessions in the same project the same animation; once the
 * whole cast is on screen, reuse is unavoidable and the stable pick wins.
 *
 * Assignments come in two levels. One made against a *session* is that buddy's
 * alone, so changing the pet in one row of the settings window never disturbs
 * the other agents running in the same folder. One made against the *project*
 * is the folder's standing preference, and outlives any particular session.
 *
 * @param {object} settings  the app's settings (the assignments live here)
 * @param {string} name      the project name — what project assignments use
 * @param {string} sessionId the live session — its own assignment, else what
 *                           the automatic pick hashes
 * @param {string[]} used    character ids already active in this project
 */
function characterFor(settings, name, sessionId = '', used = []) {
  const cast = allCharacters();
  const unavailable = new Set(used);

  // Picked for this one session, it wins outright — including over its twin's
  // claim on the same character. That is the whole point of a per-session
  // choice: you pointed at one buddy in the list and said "you, be the fox".
  const own = (settings.characterBySession || {})[sessionId];
  if (own && cast.some((c) => c.id === own)) return own;

  // A buddy assigned to this project by hand still wins — but only while it's
  // free. Everyone else picks from their own session id, so parallel sessions
  // in one folder never read as twins, and never all march in cast order.
  const assigned = (settings.characterByProject || {})[name];
  if (assigned && !unavailable.has(assigned) && cast.some((c) => c.id === assigned)) {
    return assigned;
  }

  const start = hash(String(sessionId || name || 'clippy')) % cast.length;
  for (let offset = 0; offset < cast.length; offset++) {
    const id = cast[(start + offset) % cast.length].id;
    if (!unavailable.has(id)) return id;
  }
  return cast[start].id;
}

module.exports = {
  CHARACTERS,
  POSES,
  SIZES,
  sizeList,
  customThemes,
  allCharacters,
  characterFor,
  sizeFor,
  THEMES_DIR,
};
