'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { zipUrlFor, catalogPets } = require('../scripts/add-sprite-pack');

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

test('a paged catalog is followed, and a one-file one is still read', async () => {
  const pages = {
    'https://openpets.dev/pets/catalog.v3/page-000.json': { pets: [PETS[0]] },
    'https://openpets.dev/pets/catalog.v3/page-001.json': { pets: [PETS[1]] },
  };
  const getJson = async (url) => pages[url];

  // v3: a manifest of pages, which have to be followed and concatenated —
  // this is the whole reason a pet published after the v2 snapshot could not
  // be found while its page and zip were both live.
  assert.deepEqual(
    await catalogPets({ version: 3, pages: Object.keys(pages) }, getJson),
    PETS
  );

  // v2: everything in one file. Still read, and without touching the network.
  assert.deepEqual(
    await catalogPets({ version: 2, pets: PETS }, () => assert.fail('should not fetch')),
    PETS
  );
});

test('a catalog shape we do not recognise is empty, not a crash', async () => {
  const boom = () => assert.fail('should not fetch');
  assert.deepEqual(await catalogPets({ version: 9 }, boom), []);
  assert.deepEqual(await catalogPets(null, boom), []);
  // A page that came back malformed costs its pets, not the whole install.
  assert.deepEqual(await catalogPets({ pages: ['a', 'b'] }, async (u) => (u === 'a' ? { pets: PETS } : null)), PETS);
});
