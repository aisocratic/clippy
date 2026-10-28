'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { PetCatalog, catalogEntries, searchPets, imageKind } = require('../src/pet-catalog');

const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8L'), Buffer.alloc(8)]);

// The catalog's own shape: displayName, and URLs on openpets.dev.
const entry = (id, displayName = id) => ({
  id,
  displayName,
  thumbnail: `https://openpets.dev/pets/${id}-openpets/thumb.webp`,
  zip: `https://zip.openpets.dev/pets/${id}-openpets/${id}.zip`,
});

const RAW = [entry('miso', 'Miso'), entry('raichu', 'Raichu'), entry('azure', 'Azure Dragon'), entry('fox', 'Fox')];

function catalog(t, { raw = RAW, fetchImpl, now } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-thumbs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let loads = 0;
  const pets = new PetCatalog({
    load: async () => {
      loads += 1;
      return raw;
    },
    thumbsDir: dir,
    fetchImpl: fetchImpl || (async () => new Response(WEBP)),
    now,
    log: () => {},
  });
  return { pets, dir, loads: () => loads };
}

test('only entries with a usable id and openpets.dev URLs are kept, once each', () => {
  const pets = catalogEntries([
    entry('miso', 'Miso'),
    entry('miso', 'Miso again'),
    { ...entry('../etc'), id: '../etc' },
    { ...entry('evil'), zip: 'https://evil.example/evil.zip' },
    { ...entry('plain'), zip: 'http://zip.openpets.dev/pets/plain/plain.zip' },
    { ...entry('nothumb'), thumbnail: 'https://elsewhere.example/t.webp' },
    null,
  ]);
  assert.deepEqual(
    pets.map((p) => [p.id, p.name, Boolean(p.thumbnail)]),
    [
      ['miso', 'Miso', true],
      ['nothumb', 'nothumb', false], // installable, just nothing to show
    ]
  );
  assert.deepEqual(catalogEntries(null), []);
});

test('a search matches every word in the name or id, and pages the matches', () => {
  const pets = catalogEntries(RAW);
  assert.deepEqual(searchPets(pets, 'dragon AZ').pets.map((p) => p.id), ['azure']);
  assert.deepEqual(searchPets(pets, '').total, 4);
  assert.equal(searchPets(pets, 'nobody').total, 0);

  const paged = searchPets(pets, '', 1, 3);
  assert.deepEqual([paged.total, paged.page, paged.pets.map((p) => p.id)], [4, 1, ['fox']]);
  // A page past the end is the last one, and nonsense is the first.
  assert.equal(searchPets(pets, '', 9, 3).page, 1);
  assert.equal(searchPets(pets, '', 'x', 3).page, 0);
});

test('the catalog is downloaded once an hour however often it is searched', async (t) => {
  let clock = 0;
  const { pets, loads } = catalog(t, { now: () => clock });
  await Promise.all([pets.search('', 0, { waitMs: 0 }), pets.search('mi', 0, { waitMs: 0 }), pets.raw()]);
  assert.equal(loads(), 1);
  clock += 59 * 60_000;
  await pets.raw();
  assert.equal(loads(), 1);
  clock += 2 * 60_000;
  await pets.raw();
  assert.equal(loads(), 2);
});

test('a catalog that fails or comes back empty is not kept', async (t) => {
  const { pets, loads } = catalog(t, { raw: [] });
  await assert.rejects(pets.search(''), /empty/);
  await assert.rejects(pets.search(''), /empty/);
  assert.equal(loads(), 2);
});

test('a pet installs from the zip its catalog entry names', async (t) => {
  const { pets } = catalog(t);
  assert.equal(await pets.zipFor('miso'), 'https://zip.openpets.dev/pets/miso-openpets/miso.zip');
  await assert.rejects(pets.zipFor('nobody'), /nobody/);
  await assert.rejects(pets.zipFor('../miso'), /no pet named/);
});

test('thumbnails are saved locally and handed over as file URLs, with what is installed', async (t) => {
  const asked = [];
  const { pets, dir } = catalog(t, {
    fetchImpl: async (url) => {
      asked.push(url);
      return new Response(WEBP);
    },
  });
  const page = await pets.search('', 0, { installed: ['fox'] });
  assert.deepEqual(
    page.pets.map((p) => [p.id, p.installed]),
    [
      ['miso', false],
      ['raichu', false],
      ['azure', false],
      ['fox', true],
    ]
  );
  assert.equal(page.pets[0].thumb, pathToFileURL(path.join(dir, 'miso.webp')).href);
  assert.ok(asked.every((url) => url.startsWith('https://openpets.dev/pets/')));

  // Kept: the next search downloads nothing.
  await pets.search('', 0);
  assert.equal(asked.length, 4);
});

test('a thumbnail that is not an image is never saved, and not retried at once', async (t) => {
  let calls = 0;
  const { pets, dir } = catalog(t, {
    raw: [entry('miso')],
    fetchImpl: async () => {
      calls += 1;
      return new Response('<html>not a picture</html>');
    },
  });
  const page = await pets.search('', 0);
  assert.equal(page.pets[0].thumb, null);
  assert.deepEqual(fs.readdirSync(dir), []);
  await pets.search('', 0);
  assert.equal(calls, 1);
});

test('an image is known by its bytes, not its name', () => {
  assert.equal(imageKind(WEBP), 'webp');
  assert.equal(imageKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'png');
  assert.equal(imageKind(Buffer.from('GIF89a')), null);
});
