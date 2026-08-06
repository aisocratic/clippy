'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build, builtInAssetsAreCurrent } = require('../scripts/make-buddies');

test('--if-missing requires every built-in buddy asset to be current', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-buddies-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.mkdirSync(path.join(dir, 'themes'), { recursive: true });
  const assets = build();
  assert.equal(builtInAssetsAreCurrent(dir, assets), false, 'an empty themes directory is incomplete');

  for (const [name, bytes] of Object.entries(assets)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  assert.equal(builtInAssetsAreCurrent(dir, assets), true);

  const first = Object.keys(assets)[0];
  fs.writeFileSync(path.join(dir, first), 'stale but non-empty');
  assert.equal(builtInAssetsAreCurrent(dir, assets), false, 'stale generated art must be rebuilt');
});
