'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { encodePng, renderIconPixels, sha256File } = require('../scripts/package-app');

/** Pull a PNG apart: signature checked, chunks returned as { type, data }. */
function parsePng(buf) {
  assert.deepStrictEqual(
    [...buf.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'PNG signature'
  );
  const chunks = [];
  let at = 8;
  while (at < buf.length) {
    const length = buf.readUInt32BE(at);
    chunks.push({ type: buf.toString('latin1', at + 4, at + 8), data: buf.subarray(at + 8, at + 8 + length) });
    at += 12 + length; // length + type + data + crc
  }
  return chunks;
}

test('encodePng writes a valid RGBA PNG that decompresses to its pixels', () => {
  const width = 3;
  const height = 2;
  const rgba = Buffer.alloc(width * height * 4);
  rgba.set([255, 0, 0, 255], 0); // one red pixel, the rest transparent black
  const chunks = parsePng(encodePng(width, height, rgba));

  assert.deepStrictEqual(
    chunks.map((c) => c.type),
    ['IHDR', 'IDAT', 'IEND']
  );
  const ihdr = chunks[0].data;
  assert.strictEqual(ihdr.readUInt32BE(0), width);
  assert.strictEqual(ihdr.readUInt32BE(4), height);
  assert.strictEqual(ihdr[8], 8, 'bit depth');
  assert.strictEqual(ihdr[9], 6, 'colour type RGBA');

  // Scanlines come back exactly: a filter byte of 0, then the pixels.
  const raw = zlib.inflateSync(chunks[1].data);
  assert.strictEqual(raw.length, height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    assert.strictEqual(raw[y * (1 + width * 4)], 0, 'filter byte');
  }
  assert.deepStrictEqual([...raw.subarray(1, 5)], [255, 0, 0, 255]);
});

test('renderIconPixels draws the clip centred with transparent margins', () => {
  const size = 64;
  const rgba = renderIconPixels(size);
  assert.strictEqual(rgba.length, size * size * 4);

  // The corners are outside the sprite: fully transparent.
  for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
    assert.strictEqual(rgba[(y * size + x) * 4 + 3], 0, `corner ${x},${y}`);
  }
  // And there is actually a clip in the middle of it somewhere.
  let opaque = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 255) opaque++;
  assert.ok(opaque > size, `expected a drawing, got ${opaque} opaque pixels`);
});

test('sha256File produces the release checksum without shelling out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-checksum-'));
  const file = path.join(dir, 'artifact.dmg');
  fs.writeFileSync(file, 'clippy');
  assert.strictEqual(
    sha256File(file),
    '328e9da6b2f987f38d7034ba76d746ebfbb24e45da004b93750355c02cc40b42'
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('every external tool is run as an argv array, never through a shell', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'package-app.js'), 'utf8');
  // The paths handed to codesign, hdiutil, ditto and xcrun contain spaces
  // ("Clippy for Claude Code.app") and one of them — the signing identity — is
  // whatever the environment says it is. execFile with an argv array hands each
  // one to the tool untouched; a shell would re-split them.
  assert.doesNotMatch(source, /\bexecSync\s*\(/);
  assert.doesNotMatch(source, /\bshell\s*:\s*true/);
  for (const [call] of source.matchAll(/execFileSync\([^)]*/g)) {
    assert.match(call, /execFileSync\(\s*(?:'[^']+'|[A-Za-z_$][\w.$]*)\s*,\s*\[/s, call.slice(0, 80));
  }
});

test('an icon can be written without an alpha channel at all', () => {
  const rgba = renderIconPixels(32);
  const rgb = encodePng(32, 32, rgba, { alpha: false });

  // App Store Connect rejects an app icon that *has* an alpha channel, however
  // opaque every pixel in it is — so the channel has to be absent, not full.
  // IHDR's colour type is byte 25: 6 is truecolour+alpha, 2 is truecolour.
  assert.equal(rgb[25], 2);
  assert.equal(encodePng(32, 32, rgba)[25], 6, 'and the default is unchanged');
  assert.equal(rgb.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  // Three channels a pixel rather than four, so it is genuinely smaller.
  assert.ok(rgb.length < encodePng(32, 32, rgba).length);
});
