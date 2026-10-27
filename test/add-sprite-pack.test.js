'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {
  zipUrlFor,
  catalogPets,
  assertNoLinks,
  installPack,
  pngAlpha,
  drawnFrames,
} = require('../scripts/add-sprite-pack');

/**
 * A real RGBA PNG, every row run through filter `y % 5` so the decoder has to
 * undo all five. CRCs are left zero: nothing here checks them.
 */
function encodePng(width, height, rgba) {
  const stride = width * 4;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    const line = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y ? rgba.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const out = Buffer.alloc(stride + 1);
    out[0] = filter;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? line[x - 4] : 0;
      const up = prev[x];
      const corner = x >= 4 ? prev[x - 4] : 0;
      const p = left + up - corner;
      const paeth =
        Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner)
          ? left
          : Math.abs(p - up) <= Math.abs(p - corner)
            ? up
            : corner;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter];
      out[x + 1] = (line[x] - predicted) & 0xff;
    }
    rows.push(out);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An 8x9 sheet of 4x4 cells where row r draws `drawn[r]` frames from the left. */
function sheet(drawn) {
  const width = 8 * 4;
  const height = 9 * 4;
  const rgba = Buffer.alloc(width * height * 4);
  drawn.forEach((count, row) => {
    for (let column = 0; column < count; column++) {
      // One opaque pixel in the cell's far corner is enough to be drawn.
      const x = column * 4 + 3;
      const y = row * 4 + 3;
      rgba.fill(255, (y * width + x) * 4, (y * width + x) * 4 + 4);
    }
  });
  return encodePng(width, height, rgba);
}

// A slice of the real catalog's shape: id, and a zip whose path carries the
// gallery slug.
const PETS = [
  { id: 'tmuxai', zip: 'https://zip.openpets.dev/pets/tmuxai-openpets/tmuxai.zip' },
  { id: 'nori', zip: 'https://zip.openpets.dev/pets/nori-openpets/nori.zip' },
];

test('a pet page URL resolves through its slug, a bare id through the catalog', () => {
  assert.equal(
    zipUrlFor('https://openpets.dev/pets/tmuxai-openpets/', PETS),
    'https://zip.openpets.dev/pets/tmuxai-openpets/tmuxai.zip'
  );
  assert.equal(zipUrlFor('nori', PETS), 'https://zip.openpets.dev/pets/nori-openpets/nori.zip');
});

test('a direct zip link is taken as-is; other hosts are refused', () => {
  const direct = 'https://zip.openpets.dev/pets/nori-openpets/nori.zip';
  assert.equal(zipUrlFor(direct, []), direct);
  assert.throws(() => zipUrlFor('https://example.com/pets/nori/', PETS), /openpets\.dev/);
});

test('a pack is only ever downloaded over https, from openpets.dev', () => {
  // A pack is an archive we unpack and copy into the app's asset folder, so
  // plaintext http (anyone on the wire chooses the bytes) is refused outright.
  assert.throws(
    () => zipUrlFor('http://zip.openpets.dev/pets/nori-openpets/nori.zip', PETS),
    /https/
  );
  assert.throws(() => zipUrlFor('http://openpets.dev/pets/tmuxai-openpets/', PETS), /https/);
  // …and so is a direct .zip link on somebody else's host.
  assert.throws(() => zipUrlFor('https://evil.example/pets/nori.zip', PETS), /openpets\.dev/);

  // The catalog itself is remote JSON, so the URL it hands back gets the same
  // treatment as one that was typed in.
  const hijacked = [{ id: 'nori', zip: 'http://evil.example/nori.zip' }];
  assert.throws(() => zipUrlFor('nori', hijacked), /https/);
});

test('a pack carrying a symlink is refused rather than installed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-pack-links-'));
  fs.mkdirSync(path.join(dir, 'art'));
  fs.writeFileSync(path.join(dir, 'art', 'sheet.webp'), 'RIFF');
  assert.doesNotThrow(() => assertNoLinks(dir));

  // ditto restores a zip's symlinks faithfully, so a "sheet" that is really a
  // link to something in the home directory would otherwise be copied in as art.
  fs.symlinkSync(path.join(os.homedir(), '.ssh', 'id_rsa'), path.join(dir, 'art', 'secret.webp'));
  assert.throws(() => assertNoLinks(dir), /symlink/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a pet the catalog has never heard of says so', () => {
  assert.throws(() => zipUrlFor('https://openpets.dev/pets/mystery-pet/', PETS), /mystery-pet/);
  assert.throws(() => zipUrlFor('mystery', PETS), /mystery/);
});

test('a paged catalog is followed, and a one-file one is still read', async () => {
  const pages = {
    'https://openpets.dev/pets/catalog.v3/page-000.json': { pets: [PETS[0]] },
    'https://openpets.dev/pets/catalog.v3/page-001.json': { pets: [PETS[1]] },
  };
  const getJson = async (url) => pages[url];

  // v3: a manifest of pages, which have to be followed and concatenated —
  // this is the whole reason a pet published after the v2 snapshot could not
  // be found while its page and zip were both live.
  assert.deepEqual(
    await catalogPets({ version: 3, pages: Object.keys(pages) }, getJson),
    PETS
  );

  // v2: everything in one file. Still read, and without touching the network.
  assert.deepEqual(
    await catalogPets({ version: 2, pets: PETS }, () => assert.fail('should not fetch')),
    PETS
  );
});

test('a pack is installed under the user themes folder, never inside the app', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-install-'));
  const before = process.env.CLIPPY_THEMES_DIR;
  process.env.CLIPPY_THEMES_DIR = path.join(tmp, 'themes');
  t.after(() => {
    if (before == null) delete process.env.CLIPPY_THEMES_DIR;
    else process.env.CLIPPY_THEMES_DIR = before;
  });

  // A pack the way openpets ships one: pet.json beside a grid sheet. Only the
  // PNG header is read, so 24 bytes of one is a sheet.
  const pack = path.join(tmp, 'fox-openpets');
  fs.mkdirSync(pack);
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(256, 16);
  png.writeUInt32BE(288, 20);
  fs.writeFileSync(path.join(pack, 'sheet.png'), png);
  fs.writeFileSync(
    path.join(pack, 'pet.json'),
    JSON.stringify({ id: 'fox', displayName: 'Fox', spritesheetPath: 'sheet.png' })
  );

  // The app's own assets folder is replaced wholesale by every update: nothing
  // of the user's may land there. A checkout may already hold a pack of that
  // name from before the move (the folder is gitignored), so what is checked
  // is that the install neither created nor touched it.
  const inBundle = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'themes', 'fox');
  const bundleBefore = fs.existsSync(inBundle) ? fs.statSync(inBundle).mtimeMs : null;

  const { id, out, theme } = await installPack(pack, { grid: '8x9' });
  assert.equal(id, 'fox');
  assert.equal(out, path.join(tmp, 'themes', 'fox'));
  assert.ok(fs.existsSync(path.join(out, 'theme.json')));
  assert.ok(fs.existsSync(path.join(out, 'sheet.png')));
  assert.equal(theme.frameWidth, 32);
  assert.ok(!out.startsWith(path.join(__dirname, '..', 'src')), `${out} is inside the app`);
  const bundleAfter = fs.existsSync(inBundle) ? fs.statSync(inBundle).mtimeMs : null;
  assert.equal(bundleAfter, bundleBefore);
});

test('a catalog shape we do not recognise is empty, not a crash', async () => {
  const boom = () => assert.fail('should not fetch');
  assert.deepEqual(await catalogPets({ version: 9 }, boom), []);
  assert.deepEqual(await catalogPets(null, boom), []);
  // A page that came back malformed costs its pets, not the whole install.
  assert.deepEqual(await catalogPets({ pages: ['a', 'b'] }, async (u) => (u === 'a' ? { pets: PETS } : null)), PETS);
});

test('a PNG’s alpha is read back through every row filter', () => {
  const width = 7;
  const height = 10;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + (i >> 3) * 11) & 0xff;
  const { width: w, height: h, alpha } = pngAlpha(encodePng(width, height, rgba));
  assert.equal(w, width);
  assert.equal(h, height);
  assert.deepEqual([...alpha], Array.from({ length: width * height }, (_, i) => rgba[i * 4 + 3]));
  assert.throws(() => pngAlpha(Buffer.from('RIFF....WEBP')), /not a PNG/);
});

test('a row counts its drawn frames from the left, up to the first empty cell', () => {
  const counts = [6, 8, 8, 4, 5, 8, 6, 6, 6];
  assert.deepEqual(drawnFrames(pngAlpha(sheet(counts)), 8, 9), counts);
  // A gap ends the animation: what comes after it is not played.
  const gappy = pngAlpha(sheet([2, 0, 0, 0, 0, 0, 0, 0, 0]));
  const x = 5 * 4 + 1; // something drawn in column 5 of row 0
  gappy.alpha[1 * gappy.width + x] = 255;
  assert.equal(drawnFrames(gappy, 8, 9)[0], 2);
});

test('a pose plays only the frames its row draws', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-frames-'));
  const before = process.env.CLIPPY_THEMES_DIR;
  process.env.CLIPPY_THEMES_DIR = path.join(tmp, 'themes');
  t.after(() => {
    if (before == null) delete process.env.CLIPPY_THEMES_DIR;
    else process.env.CLIPPY_THEMES_DIR = before;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Four idle frames where the layout has room for six, and no jump at all.
  const pack = path.join(tmp, 'nori-openpets');
  fs.mkdirSync(pack);
  fs.writeFileSync(path.join(pack, 'spritesheet.png'), sheet([4, 8, 8, 4, 0, 8, 6, 6, 6]));
  fs.writeFileSync(path.join(pack, 'pet.json'), JSON.stringify({ id: 'nori', spritesheetPath: 'spritesheet.png' }));

  const { theme } = await installPack(pack, { walk: '1:8', cheer: '4:5' });
  const brief = Object.fromEntries(Object.entries(theme.poses).map(([name, p]) => [name, [p.row, p.frames]]));
  assert.deepEqual(brief, {
    idle: [0, 4], // not 6: two blank frames would flash
    excited: [3, 4],
    walk: [1, 8],
    // cheer's row is empty, so there is no cheer and Clippy falls back
  });
});
