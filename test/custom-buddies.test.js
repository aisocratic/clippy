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
