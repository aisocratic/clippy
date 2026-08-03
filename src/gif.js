'use strict';

/**
 * A tiny animated-GIF encoder — enough for pixel art, and nothing more.
 *
 * Clippy ships no image assets and pulls in no dependencies, so every buddy is
 * drawn as index arrays and encoded here at build time by `npm run
 * make-buddies`. Palette images with a handful of colours compress fine with a
 * straightforward GIF-flavoured LZW.
 *
 * Format: GIF89a, global colour table, NETSCAPE2.0 loop block, one image per
 * frame with a graphic control extension for the delay and transparency.
 */

/** Codes are written low-bit-first and packed across byte boundaries. */
class BitWriter {
  constructor() {
    this.bytes = [];
    this.bits = 0;
    this.acc = 0;
  }

  write(code, size) {
    this.acc |= code << this.bits;
    this.bits += size;
    while (this.bits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>= 8;
      this.bits -= 8;
    }
  }

  flush() {
    if (this.bits > 0) {
      this.bytes.push(this.acc & 0xff);
      this.acc = 0;
      this.bits = 0;
    }
    return this.bytes;
  }
}

/**
 * GIF's LZW: the dictionary starts with every palette index plus a clear and an
 * end-of-information code, and the code width grows as it fills.
 */
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const out = new BitWriter();

  let codeSize = minCodeSize + 1;
  let next = endCode + 1;
  let table = new Map();

  out.write(clearCode, codeSize);
  if (indices.length === 0) {
    out.write(endCode, codeSize);
    return out.flush();
  }

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 4096 + k;
    const known = table.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    out.write(prefix, codeSize);
    if (next === 4096) {
      // Dictionary full: start over so the decoder stays in step.
      out.write(clearCode, codeSize);
      table = new Map();
      next = endCode + 1;
      codeSize = minCodeSize + 1;
    } else {
      if (next >= 1 << codeSize) codeSize++;
      table.set(key, next++);
    }
    prefix = k;
  }
  out.write(prefix, codeSize);
  out.write(endCode, codeSize);
  return out.flush();
}

/** Image data travels in sub-blocks of at most 255 bytes, ended by a zero. */
function subBlocks(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out.push(chunk.length, ...chunk);
  }
  out.push(0);
  return out;
}

const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];

/**
 * @param {object} opts
 * @param {number} opts.width  @param {number} opts.height
 * @param {Array<[number,number,number]>} opts.palette  up to 256 colours
 * @param {Array<{indices: number[]|Uint8Array, delayMs?: number}>} opts.frames
 * @param {number} [opts.transparentIndex]  palette slot to leave see-through
 * @param {number} [opts.loop]  0 = forever
 * @returns {Buffer}
 */
function encodeGif({ width, height, palette, frames, transparentIndex = -1, loop = 0 }) {
  if (!frames.length) throw new Error('a GIF needs at least one frame');
  if (palette.length > 256) throw new Error('palette is limited to 256 colours');

  // Colour tables are always a power of two, padded with black.
  let bits = 1;
  while (1 << bits < palette.length) bits++;
  const tableSize = 1 << bits;

  const bytes = [];
  bytes.push(...Buffer.from('GIF89a', 'ascii'));
  bytes.push(...u16(width), ...u16(height));
  bytes.push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0); // global table, no aspect
  for (let i = 0; i < tableSize; i++) {
    const [r, g, b] = palette[i] || [0, 0, 0];
    bytes.push(r, g, b);
  }

  // NETSCAPE2.0: the only way to say "loop".
  bytes.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 3, 1, ...u16(loop), 0);

  const minCodeSize = Math.max(2, bits);
  for (const frame of frames) {
    const delay = Math.round((frame.delayMs ?? 100) / 10); // GIF counts in 1/100s
    const hasAlpha = transparentIndex >= 0;
    // Disposal 2 (restore to background) keeps transparent pixels from smearing.
    bytes.push(0x21, 0xf9, 0x04, (2 << 2) | (hasAlpha ? 1 : 0), ...u16(delay));
    bytes.push(hasAlpha ? transparentIndex : 0, 0);

    bytes.push(0x2c, ...u16(0), ...u16(0), ...u16(width), ...u16(height), 0);
    bytes.push(minCodeSize, ...subBlocks(lzwEncode(frame.indices, minCodeSize)));
  }

  bytes.push(0x3b); // trailer
  return Buffer.from(bytes);
}

module.exports = { encodeGif, lzwEncode, BitWriter };
