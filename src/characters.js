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
  { id: 'clip', label: '📎 Clippy', poses: POSES, perColour: true },
  { id: 'cat', label: '🐱 Pixel cat', poses: POSES },
];

/**
 * The buddy is one size all the time — this is that size, and the window that
 * holds nothing but him. Pixel art only looks right at whole multiples, so the
 * steps are 2x, 3x and 4x the 32x40 sprite.
 */
const SIZES = {
  small: { buddy: 64, win: [76, 98] },
  medium: { buddy: 96, win: [108, 136] },
  large: { buddy: 128, win: [140, 174] },
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
 * Which character this session's buddy should be — one per project, always.
 *
 * With several agents running at once, "who is this one?" matters as much as
 * what it says, so the project name picks the buddy: the same repo always gets
 * the same face, parallel agents rarely match, and nothing has to be chosen
 * before the first session ever reports in.
 *
 * @param {object} settings  the app's settings (any per-project assignments)
 * @param {string} name      the project name — what the cast is hashed on
 */
function characterFor(settings, name) {
  const cast = allCharacters();

  // A buddy assigned to this project by hand outranks the hash: you asked for
  // that one, on that repo, and it should stay put. An id that has since gone
  // (a sprite pack you deleted) falls through to the hash rather than leaving a
  // buddy with no art at all.
  const assigned = (settings.characterByProject || {})[name];
  if (assigned && cast.some((c) => c.id === assigned)) return assigned;

  return cast[hash(String(name || 'clippy')) % cast.length].id;
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
