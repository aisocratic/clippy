'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { customThemes, userThemesDir, LEGACY_THEMES_DIR } = require('../src/characters');
const {
  createDrawnBuddy,
  removeCustomBuddy,
  migrateLegacyThemes,
  slugFor,
} = require('../src/custom-buddies');

// The override the tests below lean on, restored whatever else happens.
const withThemesDir = (t, dir) => {
  const before = process.env.CLIPPY_THEMES_DIR;
  if (dir == null) delete process.env.CLIPPY_THEMES_DIR;
  else process.env.CLIPPY_THEMES_DIR = dir;
  t.after(() => {
    if (before == null) delete process.env.CLIPPY_THEMES_DIR;
    else process.env.CLIPPY_THEMES_DIR = before;
  });
};

test('a pixel drawing becomes a removable local buddy theme', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-drawing-'));
  const pixels = Array(16 * 16).fill('');
  pixels[7 * 16 + 7] = '#4fa3d1';
  pixels[7 * 16 + 8] = '#4fa3d1';

  const made = createDrawnBuddy({ label: 'Blue Friend!', pixels, width: 16, height: 16 }, dir);
  assert.deepEqual(made, { id: 'blue-friend', label: 'Blue Friend!' });
  assert.ok(fs.existsSync(path.join(dir, made.id, 'idle.png')));
  assert.equal(customThemes(dir)[0].removable, true);

  removeCustomBuddy(made.id, dir);
  assert.equal(fs.existsSync(path.join(dir, made.id)), false);
});

test('drawn buddy names stay inside the themes directory', () => {
  assert.equal(slugFor('../../My Buddy'), 'my-buddy');
  assert.equal(slugFor(''), 'my-buddy');
});

test('an empty drawing is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-empty-drawing-'));
  assert.throws(
    () => createDrawnBuddy({ label: 'Ghost', pixels: Array(256).fill(''), width: 16, height: 16 }, dir),
    /draw at least one pixel/
  );
});

test('a buddy id can only ever name a folder inside the themes directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-themes-guard-'));
  const outside = path.join(dir, '..', 'clippy-NOT-A-THEME');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'theme.json'), '{}');

  for (const id of ['../clippy-NOT-A-THEME', '..', '.', 'a/b', '/etc', '', 'x y']) {
    assert.throws(() => removeCustomBuddy(id, dir), /invalid buddy id/, JSON.stringify(id));
  }
  assert.ok(fs.existsSync(outside), 'nothing outside the folder was touched');
  fs.rmSync(outside, { recursive: true, force: true });

  // Names the drawing tool could never make but the pack installer can: it
  // sanitizes an id to word characters, dots and dashes, so "Raichu" and
  // "pet_2" are real folders — and used to be unremovable.
  for (const id of ['Raichu', 'pet_2', 'cn-peashooter']) {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'theme.json'), '{}');
    removeCustomBuddy(id, dir);
    assert.equal(fs.existsSync(path.join(dir, id)), false, id);
  }
});

test('a drawn buddy whose name is a path still lands in the themes folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-drawing-escape-'));
  const pixels = Array(16 * 16).fill('');
  pixels[0] = '#ffffff';

  const made = createDrawnBuddy({ label: '../../etc/passwd', pixels }, dir);
  assert.equal(made.id, 'etc-passwd');
  assert.ok(fs.existsSync(path.join(dir, 'etc-passwd', 'theme.json')));
});

test('custom buddies live in userData, outside the app bundle', (t) => {
  // This is the bug: packs used to be written into the app's own assets
  // folder, and every update replaced that bundle — art and all.
  withThemesDir(t, null);
  const home = userThemesDir();
  assert.ok(
    home.startsWith(path.join(os.homedir(), 'Library', 'Application Support')),
    `${home} is not under Application Support`
  );
  assert.equal(path.basename(home), 'themes');
  const appRoot = path.join(__dirname, '..');
  assert.ok(!home.startsWith(appRoot), `${home} is inside the app`);
  assert.ok(LEGACY_THEMES_DIR.startsWith(path.join(appRoot, 'src')), 'the old folder is the one in the app');

  // The override is read at call time, so a test (or the bench) can point
  // the whole thing at a scratch folder after the module has loaded.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-user-themes-'));
  withThemesDir(t, tmp);
  assert.equal(userThemesDir(), tmp);

  // …and every writer follows it when handed no folder of its own, exactly
  // the way main's IPC handlers call them.
  const pixels = Array(256).fill('');
  pixels[0] = '#ff0000';
  const made = createDrawnBuddy({ label: 'X', pixels });
  assert.ok(fs.existsSync(path.join(tmp, 'x', 'theme.json')));
  assert.equal(customThemes().map((c) => c.id).join(), 'x');
  removeCustomBuddy(made.id);
  assert.equal(fs.existsSync(path.join(tmp, 'x')), false);
});

test('packs left in the old in-bundle folder move to userData once', () => {
  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-legacy-themes-'));
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-userdata-')), 'themes');
  const theme = (label) =>
    JSON.stringify({ label, frameWidth: 32, frameHeight: 32, idle: { file: 'sheet.webp', frames: 2 } });
  const write = (root, name, files) => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name, file), body);
  };
  write(legacy, 'fox', { 'theme.json': theme('Fox'), 'sheet.webp': 'RIFF....WEBP' });
  write(legacy, 'cat', { 'idle.gif': 'GIF89a' }); // generated by make-buddies: not a pack
  write(legacy, 'raichu', { 'theme.json': theme('Old Raichu'), 'sheet.webp': 'old' });
  write(dest, 'raichu', { 'theme.json': theme('Raichu'), 'sheet.webp': 'new' });

  assert.deepEqual(migrateLegacyThemes(legacy, dest), ['fox']);
  assert.equal(fs.readFileSync(path.join(dest, 'fox', 'sheet.webp'), 'utf8'), 'RIFF....WEBP');
  assert.equal(fs.existsSync(path.join(legacy, 'fox')), false, 'moved, not copied');
  assert.ok(fs.existsSync(path.join(legacy, 'cat', 'idle.gif')), 'the generated cast stays put');
  // One already in its new home is never overwritten by a stale copy.
  assert.equal(fs.readFileSync(path.join(dest, 'raichu', 'sheet.webp'), 'utf8'), 'new');
  assert.deepEqual(customThemes(dest).map((c) => c.label).sort(), ['Fox', 'Raichu']);

  // Once: the second run has nothing left to carry.
  assert.deepEqual(migrateLegacyThemes(legacy, dest), []);
  // A fresh install has no legacy folder at all — and the same folder twice is
  // nothing to do either.
  assert.deepEqual(migrateLegacyThemes(path.join(legacy, 'nope'), dest), []);
  assert.deepEqual(migrateLegacyThemes(dest, dest), []);
});
