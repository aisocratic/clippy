'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { zipUrlFor } = require('../scripts/add-sprite-pack');

// A slice of the real catalog's shape: id, and a zip whose path carries the
// gallery slug.
const PETS = [
  { id: 'tmuxai', zip: 'https://zip.openpets.dev/pets/tmuxai-openpets/tmuxai.zip' },
  { id: 'nori', zip: 'https://zip.openpets.dev/pets/nori-openpets/nori.zip' },
];

test('a pet page URL resolves through its slug, a bare id through the catalog', () => {
  assert.equal(
    zipUrlFor('https://openpets.dev/pets/tmuxai-openpets/', PETS),
    'https://zip.openpets.dev/pets/tmuxai-openpets/tmuxai.zip'
  );
  assert.equal(zipUrlFor('nori', PETS), 'https://zip.openpets.dev/pets/nori-openpets/nori.zip');
});

test('a direct zip link is taken as-is; other hosts are refused', () => {
  const direct = 'https://zip.openpets.dev/pets/nori-openpets/nori.zip';
  assert.equal(zipUrlFor(direct, []), direct);
  assert.throws(() => zipUrlFor('https://example.com/pets/nori/', PETS), /openpets\.dev/);
});

test('a pet the catalog has never heard of says so', () => {
  assert.throws(() => zipUrlFor('https://openpets.dev/pets/mystery-pet/', PETS), /mystery-pet/);
  assert.throws(() => zipUrlFor('mystery', PETS), /mystery/);
});
