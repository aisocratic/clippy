'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { customThemes } = require('../src/characters');
const { createDrawnBuddy, removeCustomBuddy, slugFor } = require('../src/custom-buddies');

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
