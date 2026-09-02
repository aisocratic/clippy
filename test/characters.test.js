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
  sizeFor,
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
  // Whole-number scaling only, or pixel art turns to mush — but the number
  // that has to come out whole is the *device* pixel, and the buddy is drawn on
  // a Retina screen. XS at 48 is 1.5 CSS pixels per drawn pixel and exactly 3
  // device pixels; the other steps are whole either way.
  for (const s of sizeList()) {
    assert.equal((s.buddy * 2) % 32, 0, `${s.id} does not land on whole device pixels`);
  }
});

test('every character in the menus has art drawn for it', () => {
  const { THEMES } = require('../scripts/make-buddies');
  const vectors = require('../src/renderer/vector-buddies');
  const drawn = THEMES.map((t) => t.id);
  const ids = CHARACTERS.map((c) => c.id);

  assert.deepEqual([...new Set(ids)], ids, 'nobody may be listed twice');
  for (const character of CHARACTERS) {
    const available = drawn.includes(character.id) || (character.vector && vectors.has(character.vector));
    assert.ok(available, `${character.id} is offered but never drawn`);
  }
  for (const character of CHARACTERS.filter((c) => c.vector)) {
    assert.deepEqual(vectors.poses, character.poses, `${character.id} must speak every pose`);
  }
  // 🖇 Clippy (classic) was folded back into 📎 Clippy the moment Clippy got the
  // original silhouette back: two identical paperclips in a menu helps nobody.
  assert.ok(!ids.includes('classic'), 'the duplicate paperclip is gone');
});

test('parallel sessions get different buddies, and a hand-picked one goes first', () => {
  const cast = allCharacters().map((c) => c.id);

  // A buddy you assigned to that repo is the first session's preference.
  const assigned = { characterByProject: { 'billing-api': 'cat' } };
  assert.equal(characterFor(assigned, 'billing-api', 'session-a'), 'cat');
  assert.notEqual(characterFor(assigned, 'billing-api', 'session-b', ['cat']), 'cat');
  // A second session picks from its own id, not from the assignment's spot in
  // the cast — so concurrent sessions don't all march in cast order.
  assert.equal(
    characterFor(assigned, 'billing-api', 'session-b', ['cat']),
    characterFor({}, 'billing-api', 'session-b', ['cat'])
  );
  // …and only for that repo: everyone else is still cast automatically.
  assert.ok(cast.includes(characterFor(assigned, 'my-app', 'session-c')));

  // The automatic pick is stable for a session. A concurrent session excludes
  // that animation and must get another while the cast has room.
  const first = characterFor({}, 'billing-api', 'session-a');
  assert.equal(characterFor({}, 'billing-api', 'session-a'), first);
  assert.notEqual(characterFor({}, 'billing-api', 'session-b', [first]), first);
  assert.ok(cast.includes(first));

  // A character that has since been deleted (a sprite pack you removed) must
  // not leave a buddy with no art at all.
  assert.ok(cast.includes(characterFor({ characterByProject: { x: 'gone' } }, 'x', 'session-x')));
  assert.ok(cast.includes(characterFor({}, '')), 'and a nameless session still works');
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

test('a pack says which way its art is drawn, and right is the default', () => {
  const pose = { idle: { file: 'idle.png', frames: 4 } };
  const dir = tmpThemes({
    lefty: {
      'theme.json': JSON.stringify({ frameWidth: 32, frameHeight: 32, facing: 'left', ...pose }),
    },
    righty: {
      'theme.json': JSON.stringify({ frameWidth: 32, frameHeight: 32, facing: 'right', ...pose }),
    },
    quiet: { 'theme.json': JSON.stringify({ frameWidth: 32, frameHeight: 32, ...pose }) },
    nonsense: {
      'theme.json': JSON.stringify({ frameWidth: 32, frameHeight: 32, facing: 'up', ...pose }),
    },
  });

  const facing = Object.fromEntries(customThemes(dir).map((t) => [t.id, t.facing]));
  assert.equal(facing.lefty, 'left');
  assert.equal(facing.righty, 'right');
  // The renderer mirrors the sprite to turn a buddy around, so an unspoken or
  // unreadable facing has to land on something — the way most packs are drawn.
  assert.equal(facing.quiet, 'right');
  assert.equal(facing.nonsense, 'right');
});

test('center art is never turned around, and a pose can disagree with its pack', () => {
  const dir = tmpThemes({
    mixed: {
      'theme.json': JSON.stringify({
        frameWidth: 192,
        frameHeight: 208,
        columns: 8,
        rows: 9,
        facing: 'left',
        poses: {
          // Sheets are not consistent with themselves: this one runs to the
          // left but sits facing the viewer.
          idle: { file: 'sheet.webp', row: 0, frames: 6, facing: 'center' },
          walk: { file: 'sheet.webp', row: 1, frames: 8 },
          excited: { file: 'sheet.webp', row: 3, frames: 4, facing: 'up' },
        },
      }),
    },
  });

  const [pack] = customThemes(dir);
  assert.equal(pack.facing, 'left', 'the pack sets the default');
  assert.equal(pack.sheet.poses.idle.facing, 'center', 'one animation may override it');
  assert.equal(pack.sheet.poses.walk.facing, undefined, 'silence means inherit the pack');
  assert.equal(pack.sheet.poses.excited.facing, undefined, 'and so does nonsense');
});

test('a choice made for one session does not dress its twin', () => {
  // Two agents in the same folder. The settings window shows a row each, and
  // picking in one row used to be written against the *project*, which is what
  // made both buddies change at once.
  const settings = {
    characterByProject: { 'billing-api': 'cat' },
    characterBySession: { 'session-a': 'clod' },
  };
  assert.equal(characterFor(settings, 'billing-api', 'session-a'), 'clod', 'the one you picked');
  assert.equal(
    characterFor(settings, 'billing-api', 'session-b'),
    'cat',
    'its twin keeps what the folder says'
  );
  // A session choice outranks the folder even when the folder wants it too, and
  // even when a twin is already wearing it — you pointed at this buddy.
  assert.equal(
    characterFor({ characterByProject: { p: 'cat' }, characterBySession: { s: 'cat' } }, 'p', 's', ['cat']),
    'cat'
  );
  // …but a character that no longer exists falls through rather than sticking.
  assert.notEqual(characterFor({ characterBySession: { s: 'gone' } }, 'p', 's'), 'gone');
});

test('sizes work the same way — one session, not the whole folder', () => {
  const settings = {
    size: 'medium',
    sizeByProject: { 'billing-api': 'large' },
    sizeBySession: { 'session-a': 'xs' },
  };
  assert.equal(sizeFor(settings, 'billing-api', 'session-a'), 'xs');
  assert.equal(sizeFor(settings, 'billing-api', 'session-b'), 'large');
  assert.equal(sizeFor(settings, 'other', 'session-c'), 'medium');
  // A size that no longer exists falls through to the folder, then the default.
  assert.equal(sizeFor({ ...settings, sizeBySession: { 'session-a': 'huge' } }, 'billing-api', 'session-a'), 'large');
});

test('a project can be given a size, and everyone else keeps the default', () => {
  const settings = { size: 'large', sizeByProject: { 'billing-api': 'xs' } };
  assert.equal(sizeFor(settings, 'billing-api'), 'xs');
  assert.equal(sizeFor(settings, 'my-app'), 'large', 'unassigned projects take the default');
  // A size that no longer exists — a setting written by a build that had it —
  // must not leave a buddy with no window size at all.
  assert.equal(sizeFor({ size: 'large', sizeByProject: { x: 'huge' } }, 'x'), 'large');
  assert.equal(sizeFor({ size: 'huge' }, 'x'), 'medium');
  assert.equal(sizeFor({}, ''), 'medium');
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

test('a pack cannot point its sprite sheet outside the themes folder', () => {
  // theme.json is whatever a downloaded pack shipped, and its `file` is pasted
  // into a CSS url("assets/themes/<id>/<file>") in the renderer. A traversal
  // would read a file elsewhere on the disk; a quote would close the url() and
  // let the rest of the name be CSS. Either way the pose is not a pose.
  const pose = (file) => ({ frameWidth: 32, frameHeight: 32, idle: { file, frames: 4 } });
  const dir = tmpThemes({
    escape: { 'theme.json': JSON.stringify(pose('../../../../etc/passwd')) },
    encoded: { 'theme.json': JSON.stringify(pose('%2e%2e%2fidle.png')) },
    quoted: { 'theme.json': JSON.stringify(pose('idle.png");}body{display:none}')) },
    dots: { 'theme.json': JSON.stringify(pose('..')) },
    // Spaces and accents are ordinary in a pack, and must still work.
    fine: { 'theme.json': JSON.stringify(pose('my sheet ✨.webp')) },
  });

  assert.deepEqual(
    customThemes(dir).map((t) => t.id),
    ['fine']
  );
  assert.equal(customThemes(dir)[0].sheet.poses.idle.file, 'assets/themes/fine/my sheet ✨.webp');
});

test('a themes folder is scanned once and again only when it changes', () => {
  // customThemes is read per buddy and per session on every settings push, and
  // each scan is a readdir plus a read-and-parse of every theme.json — all of
  // it synchronous, on the main process.
  const theme = (label) =>
    JSON.stringify({ label, frameWidth: 32, frameHeight: 32, idle: { file: 'idle.png', frames: 2 } });
  const dir = tmpThemes({ one: { 'theme.json': theme('One') } });

  assert.deepEqual(customThemes(dir).map((t) => t.label), ['One']);

  // Rewriting a theme.json in place moves *that* folder's mtime, not this
  // one's, so the cached scan stands. That is the proof it is cached, and the
  // one change a pack author has to restart the app to see.
  fs.writeFileSync(path.join(dir, 'one', 'theme.json'), theme('Renamed'));
  assert.deepEqual(customThemes(dir).map((t) => t.label), ['One']);

  // Adding or removing a pack is a mkdir or an rmdir here, which moves the
  // folder's own mtime — the one change that has to be noticed.
  fs.mkdirSync(path.join(dir, 'two'));
  fs.writeFileSync(path.join(dir, 'two', 'theme.json'), theme('Two'));
  assert.deepEqual(
    customThemes(dir).map((t) => t.id).sort(),
    ['one', 'two']
  );

  // And a different folder is never answered from another one's scan.
  assert.deepEqual(customThemes(tmpThemes({ other: { 'theme.json': theme('Other') } })).map((t) => t.id), [
    'other',
  ]);
});
