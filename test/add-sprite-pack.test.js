'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipUrlFor, catalogPets, assertNoLinks, installPack } = require('../scripts/add-sprite-pack');

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
