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
 * Every character is original pixel art drawn by `npm run make-buddies` into
 * `src/renderer/assets/themes/<id>/` — arcade *idiom*, not arcade sprites, so
 * the repo keeps shipping no third-party art. The paperclip is the one built
 * per session colour, since a GIF can't be recoloured by CSS.
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
];

/**
 * The buddy is one size all the time — this is that size, and the window that
 * holds nothing but him. Pixel art only looks right at whole multiples, so the
 * steps are 2x, 3x and 4x the 32x40 sprite.
 */
// The compact window is the buddy plus headroom for everything hover reveals
// around him: the three-line identity plate above (plus one wrapped line at S) and the small
// controls below (~24px) — all rendered invisible until hover, so revealing
// them never resizes the window. Short-changing this is how the plate got
// clipped at the top once: the stage bottom-anchors, so missing room comes
// out of whatever sits highest.
const SIZES = {
  small: { buddy: 64, win: [92, 206] },
  medium: { buddy: 96, win: [124, 234] },
  large: { buddy: 128, win: [156, 262] },
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
 *     "idle":    { "file": "idle.png",    "frames": 4 },
 *     "excited": { "file": "excited.png", "frames": 6 }
 *   }
 *
 * Packs that put every animation in one grid — a row per animation, which is
 * how most pet sprite sheets ship — say so instead, and can name as many of the
 * poses as the sheet actually has:
 *
 *   { "frameWidth": 192, "frameHeight": 208, "columns": 8, "rows": 9,
 *     "poses": {
 *       "idle":    { "file": "spritesheet.webp", "row": 0, "frames": 6 },
 *       "excited": { "file": "spritesheet.webp", "row": 3, "frames": 4 },
 *       "walk":    { "file": "spritesheet.webp", "row": 1, "frames": 8 }
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
    if (sheet) themes.push({ id: entry.name, label: raw.label || entry.name, sheet });
    else console.warn(`clippy: ignoring themes/${entry.name} — theme.json is incomplete`);
  }
  return themes;
}

/** Validate the bits the renderer has to have, or return null. */
function readSheet(raw, id) {
  const read = (p) =>
    p && typeof p.file === 'string' && Number(p.frames) > 0
      ? {
          file: `assets/themes/${id}/${p.file}`,
          frames: Math.floor(Number(p.frames)),
          row: Math.max(0, Math.floor(Number(p.row) || 0)),
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
 * Which character this session's buddy should be.
 *
 * A session id picks the starting point in the cast. `used` lets main avoid
 * giving two live sessions in the same project the same animation; once the
 * whole cast is on screen, reuse is unavoidable and the stable pick wins.
 *
 * @param {object} settings  the app's settings (any per-project assignments)
 * @param {string} name      the project name — what manual assignments use
 * @param {string} sessionId the live session — what the automatic pick hashes
 * @param {string[]} used    character ids already active in this project
 */
function characterFor(settings, name, sessionId = '', used = []) {
  const cast = allCharacters();
  const unavailable = new Set(used);

  // A buddy assigned to this project by hand is the first choice. A second live
  // session still gets a different animation when the cast has one available.
  const assigned = (settings.characterByProject || {})[name];
  const assignedAt = cast.findIndex((c) => c.id === assigned);
  const start = assignedAt >= 0
    ? assignedAt
    : hash(String(sessionId || name || 'clippy')) % cast.length;

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
  THEMES_DIR,
};
