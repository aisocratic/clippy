'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readBackward, readForward, parseLine, EMPTY } = require('../src/jsonl');

const jsonlFile = (t, contents) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-jsonl-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, contents);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
};

/**
 * Every non-empty line the reader saw, newest first.
 *
 * A file ending in a newline has an empty final segment, and the reader visits
 * it rather than guessing what the caller wants — every real caller opens with
 * a length check, so the helper does too.
 */
const collect = async (file, options) => {
  const seen = [];
  await readBackward(file, (line) => void (line.length && seen.push(line.toString('utf8'))), options);
  return seen;
};

const text = (lines) => lines.map((l) => `${l}\n`).join('');

test('lines come back newest first, even when records cross block boundaries', async (t) => {
  // 40-byte records against a 16-byte block: every line straddles a boundary.
  const lines = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
  const file = jsonlFile(t, text(lines));

  assert.deepEqual(await collect(file, { chunkBytes: 16 }), [...lines].reverse());
});

test('a file with no trailing newline still yields its last record', async (t) => {
  const file = jsonlFile(t, 'first\nsecond\nthird');
  assert.deepEqual(await collect(file, { chunkBytes: 8 }), ['third', 'second', 'first']);
});

test('a leading newline does not invent an empty first record', async (t) => {
  const file = jsonlFile(t, '\nonly\n');
  // The empty line is still visited (callers guard on length), but the real
  // record must survive reaching offset 0.
  assert.ok((await collect(file, { chunkBytes: 4 })).includes('only'));
});

test('returning a value stops the walk before earlier blocks are read', async (t) => {
  const file = jsonlFile(t, text([...Array(500).keys()].map((i) => `line-${i}`)));
  const size = fs.statSync(file).size;

  const originalOpen = fsPromises.open;
  let bytesRead = 0;
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    handle.read = async (...readArgs) => {
      const result = await originalRead(...readArgs);
      bytesRead += result.bytesRead;
      return result;
    };
    return handle;
  };
  let found;
  try {
    found = await readBackward(file, (line) => line.toString('utf8') || undefined, {
      chunkBytes: 64,
    });
  } finally {
    fsPromises.open = originalOpen;
  }

  assert.equal(found, 'line-499');
  assert.ok(bytesRead <= 64, `read ${bytesRead} bytes of ${size}`);
});

test('a walk that never stops resolves to undefined', async (t) => {
  const file = jsonlFile(t, text(['a', 'b']));
  assert.equal(await readBackward(file, () => undefined), undefined);
});

test('an unreadable file is undefined, not a throw', async () => {
  assert.equal(await readBackward('/nope/does-not-exist.jsonl', () => 'x'), undefined);
});

test('short positional reads still assemble whole lines', async (t) => {
  const lines = ['alpha', 'bravo', 'charlie'];
  const file = jsonlFile(t, text(lines));

  // The contract that makes this loop non-obvious: read() may return fewer
  // bytes than asked for, at any offset, for a perfectly ordinary file.
  const originalOpen = fsPromises.open;
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args);
    const originalRead = handle.read.bind(handle);
    handle.read = (buffer, offset, length, position) =>
      originalRead(buffer, offset, Math.min(1, length), position);
    return handle;
  };
  try {
    assert.deepEqual(await collect(file), [...lines].reverse());
  } finally {
    fsPromises.open = originalOpen;
  }
});

test('an oversized line is skipped and its neighbours still parse', async (t) => {
  const huge = JSON.stringify({ tool_result: 'x'.repeat(3 * 1024 * 1024) });
  const file = jsonlFile(t, text(['{"n":1}', huge, '{"n":3}']));

  const seen = await collect(file, { maxLineBytes: 1024 });
  assert.deepEqual(seen.map((l) => parseLine(Buffer.from(l))?.n), [3, 1]);
});

test('readForward withholds a partial line and carry yields it exactly once', async (t) => {
  const file = jsonlFile(t, '{"n":1}\n{"n":2}\n{"n":3}');
  const size = fs.statSync(file).size;
  const half = size - 4; // lands inside the last record

  const first = await readForward(file, { start: 0, end: half });
  assert.deepEqual(
    first.lines.map((l) => parseLine(l).n),
    [1, 2]
  );
  assert.ok(first.carry.length > 0, 'the incomplete third record is held back');

  const second = await readForward(file, { start: half, end: size, carry: first.carry });
  // No trailing newline, so the final record is still incomplete on disk — it
  // comes back as carry rather than being emitted as a truncated line.
  assert.deepEqual(second.lines, []);
  assert.equal(parseLine(Buffer.concat([second.carry])).n, 3);

  const complete = await readForward(file, { start: 0, end: size + 1 });
  assert.deepEqual(
    complete.lines.map((l) => parseLine(l).n),
    [1, 2]
  );
});

test('readForward advances by exactly the bytes it consumed', async (t) => {
  const file = jsonlFile(t, text(['{"n":1}', '{"n":2}', '{"n":3}']));
  const size = fs.statSync(file).size;

  let offset = 0;
  let carry = EMPTY;
  const seen = [];
  for (let i = 0; i < 5 && offset < size; i++) {
    const batch = await readForward(file, { start: offset, end: size, carry, maxBytes: 5 });
    offset += batch.read;
    carry = batch.carry;
    seen.push(...batch.lines.map((l) => parseLine(l).n));
  }

  assert.equal(offset, size);
  assert.deepEqual(seen, [1, 2, 3]);
});

test('parseLine is null for junk, not a throw', () => {
  assert.equal(parseLine(Buffer.from('{"half":')), null);
  assert.equal(parseLine(EMPTY), null);
  assert.equal(parseLine(null), null);
  assert.deepEqual(parseLine(Buffer.from('{"ok":true}')), { ok: true });
});
