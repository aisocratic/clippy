'use strict';

/**
 * Install a sprite pack as a Clippy character — from a folder, or straight
 * from openpets.dev.
 *
 *   node scripts/add-sprite-pack.js https://openpets.dev/pets/tmuxai-openpets/
 *   node scripts/add-sprite-pack.js tmuxai                # a pet id works too
 *   node scripts/add-sprite-pack.js sprites/miso          # or a local folder
 *   node scripts/add-sprite-pack.js sprites/fox --label "🦊 Fox" --excited 3:4
 *
 * A URL (or bare id) is looked up in the openpets.dev catalog, its zip is
 * downloaded and unpacked, and the install continues exactly as for a folder.
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
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { THEMES_DIR, POSES } = require('../src/characters');

const CATALOG_URL = 'https://openpets.dev/pets/catalog.v2.json';
// The catalog's own installer caps downloads at 50MB; same bar here.
const MAX_ZIP_BYTES = 50 * 1024 * 1024;

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

/**
 * Which zip a URL or bare pet id means, given the openpets catalog. Pure so
 * it can be tested without the network: a direct .zip URL is itself; a pet
 * page URL carries its slug in /pets/<slug>/; anything else is tried as an id.
 */
function zipUrlFor(arg, pets) {
  if (/^https?:\/\//i.test(arg)) {
    const url = new URL(arg);
    if (url.pathname.endsWith('.zip')) return arg;
    if (!/(^|\.)openpets\.dev$/i.test(url.hostname)) {
      throw new Error(`only openpets.dev URLs (or direct .zip links) are understood, got ${url.hostname}`);
    }
    const slug = (url.pathname.match(/\/pets\/([^/]+)/) || [])[1];
    const wanted = slug || url.pathname.split('/').filter(Boolean).pop() || '';
    const pet = pets.find(
      (p) => p.id === wanted || String(p.zip || '').includes(`/pets/${wanted}/`)
    );
    if (!pet || !pet.zip) throw new Error(`no pet matching “${wanted}” in the openpets catalog`);
    return pet.zip;
  }
  const pet = pets.find((p) => p.id === arg || String(p.zip || '').includes(`/pets/${arg}/`));
  if (!pet || !pet.zip) throw new Error(`no pet named “${arg}” in the openpets catalog`);
  return pet.zip;
}

/** Fetch a URL-or-id pack into a temp folder and hand back that folder. */
async function fetchPack(arg) {
  const res = await fetch(CATALOG_URL, { headers: { 'User-Agent': 'clippy-for-claude' } });
  if (!res.ok) throw new Error(`openpets catalog answered ${res.status}`);
  const zipUrl = zipUrlFor(arg, (await res.json()).pets || []);

  console.log(`downloading ${zipUrl}`);
  const zipRes = await fetch(zipUrl, { headers: { 'User-Agent': 'clippy-for-claude' } });
  if (!zipRes.ok) throw new Error(`download answered ${zipRes.status}`);
  const buf = Buffer.from(await zipRes.arrayBuffer());
  if (buf.length > MAX_ZIP_BYTES) throw new Error(`zip is ${buf.length} bytes — over the 50MB cap`);
  if (buf.slice(0, 2).toString('ascii') !== 'PK') throw new Error('that is not a zip file');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-pack-'));
  const zipFile = path.join(tmp, 'pack.zip');
  fs.writeFileSync(zipFile, buf);
  const out = path.join(tmp, 'pack');
  // ditto ships with macOS (the only platform Clippy runs on) and refuses the
  // path-traversal tricks a hand-rolled extractor would have to fend off.
  execFileSync('ditto', ['-x', '-k', zipFile, out]);
  return out;
}

/**
 * The whole install, callable from anywhere — the CLI below, or the settings
 * window's "add a pet" box (via main's IPC handler). `src` is a folder, a pet
 * page URL, a direct .zip link, or a bare pet id; `opts` carries the same
 * values the CLI flags do, keyed by flag name.
 */
async function installPack(src, opts = {}) {
  // A URL or a name that isn't a folder here: fetch it from openpets.dev.
  // Packs zip up either flat or inside a folder of their own name.
  const fetched = /^https?:\/\//i.test(src) || !fs.existsSync(path.resolve(src));
  let dir = fetched ? await fetchPack(src) : path.resolve(src);
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

  // The id becomes a folder name, and a downloaded pet.json is remote input.
  const id = String(opts.id || meta.id || path.basename(dir)).replace(/[^\w.-]/g, '-');
  const [columns, rows] = String(opts.grid || '8x9').split('x').map(Number);
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
    const spec = opts[name] || (name === 'idle' ? '0:6' : name === 'excited' ? '3:4' : null);
    if (spec) poses[name] = { file: sheetName, ...pose(spec, name) };
  }

  const theme = {
    label: opts.label || meta.displayName || id,
    frameWidth: Math.floor(width / columns),
    frameHeight: Math.floor(height / rows),
    columns,
    rows,
    fps: Number(opts.fps || 6),
    poses,
  };

  const out = path.join(THEMES_DIR, id);
  fs.mkdirSync(out, { recursive: true });
  fs.copyFileSync(sheetFile, path.join(out, sheetName));
  fs.writeFileSync(path.join(out, 'theme.json'), `${JSON.stringify(theme, null, 2)}\n`);

  return { id, theme, out, width, height };
}

async function main() {
  const src = args[0];
  if (!src || src.startsWith('--')) {
    console.error('usage: node scripts/add-sprite-pack.js <pet-url | pet-id | pack-folder> [flags]');
    process.exit(1);
  }

  const opts = {};
  for (const name of ['id', 'label', 'grid', 'fps', ...POSES]) {
    const value = flag(name);
    if (value != null) opts[name] = value;
  }

  const { id, theme, out, width, height } = await installPack(src, opts);

  console.log(`installed “${theme.label}” as ${id}`);
  console.log(`  ${width}x${height} sheet -> ${theme.frameWidth}x${theme.frameHeight} frames`);
  for (const [name, p] of Object.entries(theme.poses)) {
    console.log(`  ${name.padEnd(8)} row ${p.row} (${p.frames} frames)`);
  }
  console.log(`  ${path.relative(process.cwd(), out)}`);
  console.log('Restart the app (or reload the test bench) to pick it up.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { imageSize, zipUrlFor, installPack };
