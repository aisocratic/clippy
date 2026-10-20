'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { encodePng } = require('../scripts/package-app');
const { userThemesDir, LEGACY_THEMES_DIR } = require('./characters');

const DRAW_SIZE = 16;
const FRAME_W = 32;
const FRAME_H = 40;

function slugFor(label) {
  return String(label || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42) || 'my-buddy';
}

function colourBytes(value) {
  if (value == null || value === '') return [0, 0, 0, 0];
  const match = String(value).match(/^#([0-9a-f]{6})$/i);
  if (!match) throw new Error('drawing contains an invalid colour');
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

/**
 * The folder one buddy id names, or an error.
 *
 * Both callers write to (or delete) a directory chosen by an id, and only one
 * of those ids is ours: `removeCustomBuddy` is handed whatever the settings
 * window's Remove button was pointing at. So the id is checked for the shapes
 * that would leave the themes directory *and* the resolved path is checked for
 * being a direct child of it — the second is what actually holds if the first
 * ever misses something.
 *
 * The allowed shape matches what installs packs (scripts/add-sprite-pack.js
 * sanitizes an id to `[\w.-]`), so a pack called "Raichu" or "pet_2" can be
 * removed again — the old lowercase-only test could not remove either.
 */
function themeDir(themesDir, id) {
  const safe = String(id || '');
  if (!/^[\w.-]+$/.test(safe) || /^\.+$/.test(safe)) throw new Error('invalid buddy id');
  const dir = path.resolve(themesDir, safe);
  if (path.dirname(dir) !== path.resolve(themesDir)) throw new Error('invalid buddy id');
  return dir;
}

function availableId(label, themesDir) {
  const base = slugFor(label);
  let id = base;
  let suffix = 2;
  while (fs.existsSync(themeDir(themesDir, id))) id = `${base}-${suffix++}`;
  return id;
}

/**
 * Write a pixel-editor drawing out as a one-pose sprite pack. `themesDir`
 * defaults to the persistent user folder, never the app's own assets: a buddy
 * drawn here has to outlive the next update.
 */
function createDrawnBuddy({ label, pixels, width = DRAW_SIZE, height = DRAW_SIZE }, themesDir = userThemesDir()) {
  const name = String(label || '').trim();
  if (!name) throw new Error('give your buddy a name');
  if (width !== DRAW_SIZE || height !== DRAW_SIZE || !Array.isArray(pixels) || pixels.length !== width * height) {
    throw new Error(`the drawing must be ${DRAW_SIZE}×${DRAW_SIZE} pixels`);
  }
  if (!pixels.some(Boolean)) throw new Error('draw at least one pixel first');

  const id = availableId(name, themesDir);
  const dir = themeDir(themesDir, id);
  const rgba = Buffer.alloc(FRAME_W * FRAME_H * 4);
  const top = FRAME_H - height * 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bytes = colourBytes(pixels[y * width + x]);
      for (let yy = 0; yy < 2; yy++) {
        for (let xx = 0; xx < 2; xx++) {
          const at = ((top + y * 2 + yy) * FRAME_W + x * 2 + xx) * 4;
          rgba.set(bytes, at);
        }
      }
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'idle.png'), encodePng(FRAME_W, FRAME_H, rgba));
  fs.writeFileSync(
    path.join(dir, 'theme.json'),
    `${JSON.stringify({
      label: name,
      frameWidth: FRAME_W,
      frameHeight: FRAME_H,
      facing: 'center',
      idle: { file: 'idle.png', frames: 1 },
    }, null, 2)}\n`
  );
  return { id, label: name };
}

function removeCustomBuddy(id, themesDir = userThemesDir()) {
  const dir = themeDir(themesDir, id);
  if (!fs.existsSync(path.join(dir, 'theme.json'))) throw new Error('built-in buddies cannot be removed');
  fs.rmSync(dir, { recursive: true });
  return path.basename(dir);
}

/**
 * Move the packs an older build left inside the app bundle to the persistent
 * folder — once. Custom buddies used to be written next to the generated
 * cast, in `src/renderer/assets/themes/`, and every update replaced that
 * whole bundle, art included. Anything still on disk when this build first
 * runs is carried across here; anything an earlier update already deleted is
 * beyond reach, which is the whole reason the folder moved.
 *
 * Only a folder with a `theme.json` is a pack (the generated cast has none),
 * an id already present at the destination is left alone rather than
 * overwritten, and a bundle we cannot write to (a read-only volume) keeps its
 * copy — the copy in userData is the one that counts from now on.
 *
 * @returns {string[]} the ids that were moved
 */
function migrateLegacyThemes(from = LEGACY_THEMES_DIR, to = userThemesDir()) {
  if (path.resolve(from) === path.resolve(to)) return [];
  let entries;
  try {
    entries = fs.readdirSync(from, { withFileTypes: true });
  } catch {
    return []; // no legacy folder at all: a fresh install, or a checkout without assets
  }
  const moved = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[\w.-]+$/.test(entry.name) || /^\.+$/.test(entry.name)) continue;
    const src = path.join(from, entry.name);
    if (!fs.existsSync(path.join(src, 'theme.json'))) continue;
    const dest = path.join(to, entry.name);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    try {
      fs.rmSync(src, { recursive: true, force: true });
    } catch {
      // read-only bundle: the copy is what matters
    }
    moved.push(entry.name);
  }
  return moved;
}

module.exports = { DRAW_SIZE, createDrawnBuddy, removeCustomBuddy, migrateLegacyThemes, slugFor };
