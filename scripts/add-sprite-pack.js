'use strict';

/**
 * Install a downloaded sprite pack as a Clippy character.
 *
 *   node scripts/add-sprite-pack.js sprites/miso
 *   node scripts/add-sprite-pack.js sprites/fox --label "🦊 Fox" --excited 3:4
 *
 * A pack is a folder holding a sprite sheet and, optionally, a `pet.json`
 * (`{ id, displayName, spritesheetPath }`) — the shape desktop-pet packs tend
 * to ship. The sheet is a grid: one row per animation, one column per frame.
 * This copies the sheet into `src/renderer/assets/themes/<id>/` and writes the
 * `theme.json` the app reads (see src/characters.js).
 *
 * Nothing here is committed: that assets folder is gitignored, so packs keep
 * their own licence and this repo keeps shipping only art it drew itself.
 *
 * Flags:
 *   --id NAME        character id (default: pet.json's id, else the folder name)
 *   --label TEXT     what the menus show (default: pet.json's displayName)
 *   --grid CxR       frame grid, columns x rows (default 8x9)
 *   --idle R:F       row and frame count for the calm animation (default 0:6)
 *   --excited R:F    …and for the excited one (default 3:4)
 *   --walk R:F       …the walk, played while the buddy crosses a window
 *   --point R:F      …standing at a prompt, pointing at it
 *   --sleep R:F      …nothing happening for a while
 *   --cheer R:F      …a turn finished cleanly
 *   --fps N          frames per second (default 6)
 *
 * Only idle and excited have defaults; name the others if the pack has rows
 * that suit them. Rows you never name still show up in the settings window, so
 * you can look through a sheet and come back for them.
 */

const fs = require('node:fs');
const path = require('node:path');
const { THEMES_DIR, POSES } = require('../src/characters');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

/** "3:4" -> { row: 3, frames: 4 } */
function pose(spec, label) {
  const [row, frames] = String(spec).split(':').map(Number);
  if (!(row >= 0) || !(frames > 0)) throw new Error(`--${label} wants ROW:FRAMES, got "${spec}"`);
  return { row, frames };
}

/**
 * Width and height straight out of a WebP/PNG header — enough to work out the
 * frame size without pulling in an image library.
 */
function imageSize(file) {
  const buf = fs.readFileSync(file);

  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }; // PNG IHDR
  }

  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
    const chunk = buf.slice(12, 16).toString('ascii');
    // Extended (alpha/animation): a 24-bit canvas size, minus one.
    if (chunk === 'VP8X') {
      return {
        width: buf.readUIntLE(24, 3) + 1,
        height: buf.readUIntLE(27, 3) + 1,
      };
    }
    if (chunk === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }

  throw new Error(`${path.basename(file)}: only PNG and WebP sheets are understood`);
}

function main() {
  const src = args[0];
  if (!src || src.startsWith('--')) {
    console.error('usage: node scripts/add-sprite-pack.js <pack-folder> [flags]');
    process.exit(1);
  }

  // Packs zip up either flat or inside a folder of their own name.
  let dir = path.resolve(src);
  if (!fs.existsSync(path.join(dir, 'pet.json'))) {
    const nested = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name))
      .find((d) => fs.existsSync(path.join(d, 'pet.json')));
    if (nested) dir = nested;
  }

  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'pet.json'), 'utf8'));
  } catch {
    // no descriptor: the flags carry everything
  }

  const sheetName =
    meta.spritesheetPath ||
    fs.readdirSync(dir).find((f) => /\.(webp|png)$/i.test(f)) ||
    '';
  const sheetFile = path.join(dir, sheetName);
  if (!sheetName || !fs.existsSync(sheetFile)) throw new Error(`no sprite sheet in ${dir}`);

  const id = flag('id', meta.id || path.basename(dir));
  const [columns, rows] = flag('grid', '8x9').split('x').map(Number);
  if (!(columns > 0) || !(rows > 0)) throw new Error('--grid wants COLUMNSxROWS, e.g. 8x9');

  const { width, height } = imageSize(sheetFile);
  if (width % columns || height % rows) {
    console.warn(
      `⚠ ${width}x${height} doesn't divide evenly into ${columns}x${rows} — ` +
        'check --grid, or the frames will drift.'
    );
  }

  const poses = {};
  for (const name of POSES) {
    const spec = flag(name, name === 'idle' ? '0:6' : name === 'excited' ? '3:4' : null);
    if (spec) poses[name] = { file: sheetName, ...pose(spec, name) };
  }

  const theme = {
    label: flag('label', meta.displayName || id),
    frameWidth: Math.floor(width / columns),
    frameHeight: Math.floor(height / rows),
    columns,
    rows,
    fps: Number(flag('fps', 6)),
    poses,
  };

  const out = path.join(THEMES_DIR, id);
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(sheetFile, path.join(out, sheetName));
  fs.writeFileSync(path.join(out, 'theme.json'), `${JSON.stringify(theme, null, 2)}\n`);

  console.log(`installed “${theme.label}” as ${id}`);
  console.log(`  ${width}x${height} sheet -> ${theme.frameWidth}x${theme.frameHeight} frames`);
  for (const [name, p] of Object.entries(theme.poses)) {
    console.log(`  ${name.padEnd(8)} row ${p.row} (${p.frames} frames)`);
  }
  console.log(`  ${path.relative(process.cwd(), out)}`);
  console.log('Restart the app (or reload the test bench) to pick it up.');
}

if (require.main === module) main();

module.exports = { imageSize };
