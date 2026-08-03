'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { encodeGif } = require('../src/gif');
const { build, drawCat, drawClip, THEMES, W, H } = require('../scripts/make-buddies');

/* ---------- A just-enough GIF reader, so the encoder is checked by a decoder ---------- */

function decodeGif(buf) {
  assert.equal(buf.slice(0, 6).toString('ascii'), 'GIF89a');
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  const packed = buf[10];
  const tableSize = 1 << ((packed & 0x07) + 1);
  let p = 13 + tableSize * 3;

  const frames = [];
  let delayMs = 0;
  let transparentIndex = -1;
  let loops = null;

  while (p < buf.length) {
    const block = buf[p++];
    if (block === 0x3b) break; // trailer

    if (block === 0x21) {
      const label = buf[p++];
      if (label === 0xf9) {
        p++; // block size
        transparentIndex = buf[p] & 1 ? buf[p + 3] : -1;
        delayMs = buf.readUInt16LE(p + 1) * 10;
        p += 5;
        continue;
      }
      const size = buf[p];
      if (label === 0xff && buf.slice(p + 1, p + 12).toString('ascii') === 'NETSCAPE2.0') {
        loops = buf.readUInt16LE(p + 1 + size + 2);
      }
      p += 1 + size;
      while (buf[p] !== 0) p += buf[p] + 1; // sub-blocks
      p++;
      continue;
    }

    if (block !== 0x2c) throw new Error(`unexpected block 0x${block.toString(16)}`);
    const fw = buf.readUInt16LE(p + 4);
    const fh = buf.readUInt16LE(p + 6);
    p += 9;
    const minCodeSize = buf[p++];
    const data = [];
    while (buf[p] !== 0) {
      const size = buf[p++];
      for (let i = 0; i < size; i++) data.push(buf[p + i]);
      p += size;
    }
    p++;
    frames.push({
      width: fw,
      height: fh,
      delayMs,
      transparentIndex,
      indices: lzwDecode(data, minCodeSize, fw * fh),
    });
  }
  return { width, height, loops, frames };
}

function lzwDecode(bytes, minCodeSize, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const out = [];

  let codeSize = minCodeSize + 1;
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict.push([i]);
    dict.push([], []); // clear + end
    codeSize = minCodeSize + 1;
  };
  reset();

  let bitPos = 0;
  const readCode = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i++, bitPos++) {
      const bit = (bytes[bitPos >> 3] >> (bitPos & 7)) & 1;
      code |= bit << i;
    }
    return code;
  };

  let prev = null;
  while (out.length < pixelCount) {
    const code = readCode();
    if (code === clearCode) {
      reset();
      prev = null;
      continue;
    }
    if (code === endCode) break;

    let entry;
    if (code < dict.length) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else throw new Error('bad code stream');

    out.push(...entry);
    if (prev) {
      dict.push([...prev, entry[0]]);
      if (dict.length >= 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return out;
}

/* ---------- Tests ---------- */

test('a hand-built GIF decodes back to exactly the pixels put in', () => {
  const indices = [];
  for (let i = 0; i < 8 * 8; i++) indices.push(i % 4);

  const gif = decodeGif(
    encodeGif({
      width: 8,
      height: 8,
      palette: [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]],
      frames: [{ indices, delayMs: 120 }],
      transparentIndex: 0,
    })
  );

  assert.deepEqual([gif.width, gif.height], [8, 8]);
  assert.equal(gif.loops, 0); // loops forever
  assert.equal(gif.frames.length, 1);
  assert.equal(gif.frames[0].delayMs, 120);
  assert.equal(gif.frames[0].transparentIndex, 0);
  assert.deepEqual(gif.frames[0].indices, indices);
});

test('long runs and repeated patterns survive the LZW round-trip', () => {
  // A run longer than the dictionary can hold in one code, plus noise that
  // forces the code size to grow.
  const indices = [];
  for (let i = 0; i < 5000; i++) indices.push(i < 4000 ? 7 : i % 16);

  const gif = decodeGif(
    encodeGif({
      width: 100,
      height: 50,
      palette: Array.from({ length: 16 }, (_, i) => [i * 16, i * 8, i * 4]),
      frames: [{ indices }],
    })
  );
  assert.deepEqual(gif.frames[0].indices, indices);
});

test('every buddy asset is a looping, transparent, multi-frame GIF', () => {
  const assets = build();

  // Every character has a calm and an excited animation, in its own folder…
  for (const theme of THEMES) {
    assert.ok(assets[`themes/${theme.id}/idle.gif`], `${theme.id} needs an idle animation`);
    assert.ok(assets[`themes/${theme.id}/excited.gif`], `${theme.id} needs an excited one`);
  }
  // …and the paperclip has a pair per identity colour on top of that.
  assert.equal(Object.keys(assets).filter((n) => n.startsWith('themes/clip/')).length, 16);

  for (const [name, bytes] of Object.entries(assets)) {
    const gif = decodeGif(bytes);
    assert.deepEqual([gif.width, gif.height], [W, H], name);
    assert.equal(gif.loops, 0, name);
    assert.ok(gif.frames.length >= 4, `${name} should animate`);
    for (const frame of gif.frames) {
      assert.equal(frame.transparentIndex, 0, `${name} keeps its background clear`);
      assert.equal(frame.indices.length, W * H, name);
    }
  }
});

test('no character is drawn off the edge of its canvas', () => {
  // Feet running past the bottom row is the classic pixel-art regression: it
  // looks fine in the draw function and comes out sliced in the GIF.
  const rowUsed = (indices, y) => indices.slice(y * W, (y + 1) * W).some((c) => c !== 0);

  for (const theme of THEMES) {
    for (const [mood, frames] of [['idle', theme.idle], ['excited', theme.excited]]) {
      for (const [i, frame] of frames.entries()) {
        const where = `${theme.id} ${mood} frame ${i}`;
        // The bottom row is the one that matters: the canvas has headroom at
        // the top on purpose (the cat's ears reach row 0 mid-hop), but anything
        // reaching the last row has already had its feet sliced off.
        assert.ok(!rowUsed(frame.indices, H - 1), `${where} runs off the bottom`);
        for (let y = 0; y < H; y++) {
          const row = frame.indices.slice(y * W, (y + 1) * W);
          assert.ok(row[0] === 0 && row[W - 1] === 0, `${where} touches a side edge`);
        }
      }
    }
  }
});

test('the paperclip keeps the gaps between its wires open', () => {
  const clip = drawClip({});
  const rows = [];
  for (let y = 0; y < H; y++) rows.push([...clip.slice(y * W, y * W + W)]);

  // Across the middle of the clip: wire, gap, wire, ... — if the outline pass
  // ever fills those gaps in, it stops reading as a paperclip and turns into a
  // slab, which is exactly the bug this catches.
  const middle = rows[20];
  const transparentRuns = middle.join('').split(/[^0]+/).filter(Boolean);
  assert.ok(transparentRuns.length >= 2, 'expected clear gaps between the wires');

  const inked = [...clip].filter((c) => c !== 0).length;
  assert.ok(inked > 200 && inked < W * H * 0.8, `a clip, not a blob: ${inked} pixels`);
  assert.notDeepEqual([...clip], [...drawClip({ blink: true })], 'the eyes should close');
  assert.notDeepEqual([...clip], [...drawClip({ lift: 4 })], 'the bounce should move it');
});

test('the cat is drawn, not blank, and changes between frames', () => {
  const calm = drawCat({ tail: 0 });
  const swished = drawCat({ tail: 2 });
  const blinking = drawCat({ tail: 0, blink: true });

  const inked = [...calm].filter((c) => c !== 0).length;
  assert.ok(inked > 300, `expected a cat-sized drawing, got ${inked} pixels`);

  assert.notDeepEqual([...calm], [...swished], 'the tail should move');
  assert.notDeepEqual([...calm], [...blinking], 'the eyes should close');
  // Blinking only touches the eyes, so most of the cat stays put.
  const changed = [...calm].filter((c, i) => c !== blinking[i]).length;
  assert.ok(changed > 0 && changed < 40, `a blink changed ${changed} pixels`);
});
