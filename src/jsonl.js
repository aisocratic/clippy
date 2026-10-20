'use strict';

/**
 * Reading JSONL the way agent transcripts have to be read.
 *
 * Claude Code and Codex both append newline-delimited JSON, and both write
 * files that are hostile to the obvious approach: a busy session's transcript
 * reaches tens of megabytes, and a single line carrying a tool result can be
 * megabytes on its own. So nothing here ever slurps a file.
 *
 *   - `readBackward` walks lines newest-first, one block at a time, and stops
 *     the moment the caller has seen enough. Finding the last thing an agent
 *     said costs one 64KB read of a 26MB file.
 *   - `readForward` reads a byte range and yields only *complete* lines, handing
 *     back the trailing fragment so the next call can pick up where it left off.
 *     That is what makes tailing a growing file cheap.
 *
 * Both are careful about the same three things, which is most of why this is a
 * module and not two loops: positional reads can legally come back short even
 * for a regular file; a record can straddle any block boundary; and a JSONL
 * file need not end (or begin) with a newline.
 */

const fs = require('node:fs/promises');

// One block. Big enough that the last few records of a transcript almost always
// land in the first read, small enough that a huge file is never materialized.
const TAIL_BYTES = 64 * 1024;

const EMPTY = Buffer.alloc(0);

/** `JSON.parse` for a line that might be half-written, or not JSON at all. */
function parseLine(line) {
  if (!line || !line.length) return null;
  try {
    return JSON.parse(line.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Walk a JSONL file's lines from the end towards the start, newest first.
 *
 * `visit(line)` may return anything other than `undefined` to stop early — that
 * value is what this resolves to. Returns `undefined` if it never did, or if
 * the file could not be read at all.
 *
 * Lines longer than `maxLineBytes` are skipped rather than assembled; they are
 * tool results, never prose, and concatenating one defeats the whole point.
 *
 * @param {string} file
 * @param {(line: Buffer) => any} visit
 * @param {{chunkBytes?: number, maxLineBytes?: number}} [options]
 */
async function readBackward(file, visit, { chunkBytes = TAIL_BYTES, maxLineBytes = Infinity } = {}) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    let position = size;
    // Segments of the one line that crosses a block boundary, encountered from
    // right to left. This stays empty for the overwhelmingly common case.
    let lineParts = [];
    let partsBytes = 0;

    while (position > 0) {
      const start = Math.max(0, position - chunkBytes);
      const block = Buffer.allocUnsafe(position - start);
      let filled = 0;
      // Positional reads can legally be short, even for a regular file.
      while (filled < block.length) {
        const result = await handle.read(block, filled, block.length - filled, start + filled);
        if (!result.bytesRead) break;
        filled += result.bytesRead;
      }
      position = start;
      const bytes = filled === block.length ? block : block.subarray(0, filled);
      let lineEnd = bytes.length;

      // `lastIndexOf` is a native scan for the delimiter; walking the block a
      // byte at a time in JS costs more than reading it did, and a transcript
      // is tens of megabytes of blocks.
      let search = bytes.length - 1;
      while (search >= 0) {
        const i = bytes.lastIndexOf(0x0a, search); // JSONL is delimited by LF
        if (i === -1) break;
        const head = bytes.subarray(i + 1, lineEnd);
        lineEnd = i;
        search = i - 1;
        if (head.length + partsBytes > maxLineBytes) {
          lineParts = [];
          partsBytes = 0;
          continue;
        }
        const segments = [head];
        for (let j = lineParts.length - 1; j >= 0; j--) segments.push(lineParts[j]);
        const line = segments.length === 1 ? segments[0] : Buffer.concat(segments);
        lineParts = [];
        partsBytes = 0;
        const found = visit(line);
        if (found !== undefined) return found;
      }

      if (lineEnd) {
        lineParts.push(bytes.subarray(0, lineEnd));
        partsBytes += lineEnd;
      }
      if (!filled) break; // the file was truncated while it was being read
    }

    // A JSONL file need not have a leading or trailing newline. Once offset 0
    // is reached, the accumulated fragments are its first complete record.
    if (lineParts.length && partsBytes <= maxLineBytes) {
      const found = visit(Buffer.concat(lineParts.reverse()));
      if (found !== undefined) return found;
    }
  } catch {
    return undefined;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  return undefined;
}

/**
 * Read `[start, end)` and return the complete lines in it.
 *
 * The trailing partial line is never emitted — its bytes come back as `carry`,
 * to be passed straight back in on the next call. `read` is how many bytes were
 * actually consumed, so the caller's offset advances by exactly that much even
 * when `maxBytes` cut the range short.
 *
 * @param {string} file
 * @param {{start?: number, end?: number, carry?: Buffer, maxBytes?: number,
 *          maxLineBytes?: number, chunkBytes?: number}} [options]
 * @returns {Promise<{lines: Buffer[], carry: Buffer, read: number}>}
 */
async function readForward(
  file,
  {
    start = 0,
    end = Infinity,
    carry = EMPTY,
    maxBytes = 4 * 1024 * 1024,
    maxLineBytes = Infinity,
    chunkBytes = TAIL_BYTES,
  } = {}
) {
  const lines = [];
  let rest = carry;
  // Counted separately from `rest`: once a line is over the limit we stop
  // holding its bytes but still have to know to drop it when its LF arrives.
  let restBytes = carry.length;
  let read = 0;
  let handle;

  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    const stop = Math.min(end, size, start + maxBytes);
    let position = start;

    while (position < stop) {
      const block = Buffer.allocUnsafe(Math.min(chunkBytes, stop - position));
      let filled = 0;
      while (filled < block.length) {
        const result = await handle.read(block, filled, block.length - filled, position + filled);
        if (!result.bytesRead) break;
        filled += result.bytesRead;
      }
      if (!filled) break; // truncated mid-read
      position += filled;
      read += filled;
      const bytes = filled === block.length ? block : block.subarray(0, filled);

      let from = 0;
      for (;;) {
        // Native delimiter scan; see readBackward.
        const i = bytes.indexOf(0x0a, from);
        if (i === -1) break;
        const piece = bytes.subarray(from, i);
        from = i + 1;
        if (restBytes + piece.length <= maxLineBytes) {
          const line = rest.length ? Buffer.concat([rest, piece]) : piece;
          if (line.length) lines.push(line);
        }
        rest = EMPTY;
        restBytes = 0;
      }

      if (from < bytes.length) {
        const tail = bytes.subarray(from);
        restBytes += tail.length;
        // Copy: `bytes` is a slice of a block we are about to stop referencing.
        rest = restBytes > maxLineBytes ? EMPTY : Buffer.concat([rest, tail]);
      }
    }
  } catch {
    // Whatever was read before the failure is still worth returning.
  } finally {
    if (handle) await handle.close().catch(() => {});
  }

  return { lines, carry: rest, read };
}

module.exports = { readBackward, readForward, parseLine, TAIL_BYTES, EMPTY };
