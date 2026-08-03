'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CHARACTERS, SIZES, sizeList, customThemes } = require('../src/characters');

const tmpThemes = (themes) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-themes-'));
  for (const [name, files] of Object.entries(themes)) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    for (const [file, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name, file), body);
    }
  }
  return dir;
};

test('the drawn cast and the sizes line up with what the menus need', () => {
  assert.ok(CHARACTERS.some((c) => c.id === 'clip'));
  for (const c of CHARACTERS) {
    assert.ok(c.id && c.label, 'every character needs an id and a label');
  }
  assert.deepEqual(
    sizeList().map((s) => s.id),
    Object.keys(SIZES)
  );
  // Whole-number scaling only: pixel art at 1.5x is mush.
  for (const s of sizeList()) assert.equal(s.buddy % 32, 0, `${s.id} is not a whole multiple`);
});

test('a dropped-in sprite sheet becomes a character', () => {
  const dir = tmpThemes({
    'my-cat': {
      'theme.json': JSON.stringify({
        label: '🐈 My cat',
        frameWidth: 32,
        frameHeight: 32,
        fps: 8,
        idle: { file: 'idle.png', frames: 4 },
        excited: { file: 'run.png', frames: 6 },
      }),
    },
  });

  const [theme] = customThemes(dir);
  assert.equal(theme.id, 'my-cat');
  assert.equal(theme.label, '🐈 My cat');
  assert.equal(theme.sheet.fps, 8);
  // Paths are handed to the renderer, so they're relative to the renderer.
  assert.equal(theme.sheet.idle.file, 'assets/themes/my-cat/idle.png');
  assert.equal(theme.sheet.excited.frames, 6);
});

test('half-written themes are skipped rather than crashing the menus', () => {
  const dir = tmpThemes({
    'no-json': { 'idle.png': 'not really a png' }, // a generated character looks like this
    broken: { 'theme.json': '{ not json' },
    'no-frames': { 'theme.json': JSON.stringify({ frameWidth: 32, frameHeight: 32 }) },
    'one-pose': {
      'theme.json': JSON.stringify({
        frameWidth: 16,
        frameHeight: 16,
        idle: { file: 'idle.png', frames: 2 },
      }),
    },
  });

  const found = customThemes(dir);
  assert.deepEqual(
    found.map((t) => t.id),
    ['one-pose']
  );
  // No excited sheet: the calm one is reused rather than leaving a hole.
  assert.deepEqual(found[0].sheet.excited, found[0].sheet.idle);
  assert.equal(found[0].sheet.fps, 6, 'a sensible default frame rate');
  assert.equal(found[0].label, 'one-pose', 'the folder name is the fallback label');
});

test('a missing themes directory is simply no extra characters', () => {
  assert.deepEqual(customThemes(path.join(os.tmpdir(), 'clippy-does-not-exist')), []);
});
