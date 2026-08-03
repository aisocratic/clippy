'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CHARACTERS,
  SIZES,
  sizeList,
  customThemes,
  allCharacters,
  characterFor,
} = require('../src/characters');

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

test('each mode decides who a session gets', () => {
  const cast = allCharacters().map((c) => c.id);
  const picked = { character: 'cat', characterMode: 'same' };

  assert.equal(characterFor(picked, 'billing-api'), 'cat', 'same: everyone gets your pick');

  // One per project: stable for a name, and derived from it rather than the
  // session id, so restarting a session doesn't change who shows up.
  const byProject = { ...picked, characterMode: 'default' };
  const first = characterFor(byProject, 'billing-api');
  assert.equal(characterFor(byProject, 'billing-api'), first);
  assert.ok(cast.includes(first));

  // Random: whatever the roll lands on.
  const random = { ...picked, characterMode: 'random' };
  assert.equal(characterFor(random, 'x', () => 0), cast[0]);
  assert.equal(characterFor(random, 'x', () => 0.999), cast[cast.length - 1]);

  // A character that has since been deleted (a sprite pack you removed) must
  // not leave a buddy with no art at all.
  assert.ok(cast.includes(characterFor({ character: 'gone', characterMode: 'same' }, 'x')));
  assert.ok(cast.includes(characterFor({}, 'x')), 'and no mode at all still works');
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
  assert.equal(theme.sheet.poses.idle.file, 'assets/themes/my-cat/idle.png');
  assert.equal(theme.sheet.poses.excited.frames, 6);
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
  assert.deepEqual(found[0].sheet.poses.excited, found[0].sheet.poses.idle);
  assert.equal(found[0].sheet.fps, 6, 'a sensible default frame rate');
  assert.equal(found[0].label, 'one-pose', 'the folder name is the fallback label');
});

test('a missing themes directory is simply no extra characters', () => {
  assert.deepEqual(customThemes(path.join(os.tmpdir(), 'clippy-does-not-exist')), []);
});

test('a grid sheet keeps its rows and columns', () => {
  const dir = tmpThemes({
    pets: {
      'theme.json': JSON.stringify({
        frameWidth: 192,
        frameHeight: 208,
        columns: 8,
        rows: 9,
        poses: {
          idle: { file: 'sheet.webp', row: 0, frames: 6 },
          excited: { file: 'sheet.webp', row: 3, frames: 4 },
          walk: { file: 'sheet.webp', row: 1, frames: 8 },
        },
      }),
    },
  });

  const [{ sheet }] = customThemes(dir);
  assert.equal(sheet.columns, 8);
  assert.equal(sheet.rows, 9);
  assert.equal(sheet.poses.excited.row, 3);
  assert.equal(sheet.poses.walk.frames, 8, 'a pack can name the whole vocabulary');
  // A plain one-row strip doesn't have to spell the grid out.
  const strip = customThemes(
    tmpThemes({
      strip: {
        'theme.json': JSON.stringify({
          frameWidth: 32,
          frameHeight: 32,
          idle: { file: 'idle.png', frames: 5 },
        }),
      },
    })
  )[0];
  assert.equal(strip.sheet.columns, 5);
  assert.equal(strip.sheet.rows, 1);
  assert.equal(strip.sheet.poses.idle.row, 0);
});

test('sheet sizes are read straight out of the image header', () => {
  const { imageSize } = require('../scripts/add-sprite-pack');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-img-'));

  // PNG: the IHDR carries width and height as big-endian 32-bit ints.
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(1536, 16);
  png.writeUInt32BE(1872, 20);
  const pngFile = path.join(dir, 'a.png');
  fs.writeFileSync(pngFile, png);
  assert.deepEqual(imageSize(pngFile), { width: 1536, height: 1872 });

  // Extended WebP (the flavour with alpha): 24-bit canvas size, minus one.
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  webp.write('VP8X', 12, 'ascii');
  webp.writeUIntLE(1535, 24, 3);
  webp.writeUIntLE(1871, 27, 3);
  const webpFile = path.join(dir, 'a.webp');
  fs.writeFileSync(webpFile, webp);
  assert.deepEqual(imageSize(webpFile), { width: 1536, height: 1872 });

  fs.writeFileSync(path.join(dir, 'a.gif'), 'GIF89a');
  assert.throws(() => imageSize(path.join(dir, 'a.gif')), /PNG and WebP/);
});
