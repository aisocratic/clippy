'use strict';

/**
 * The OpenPets catalog, searchable from Settings' "Add a buddy" box.
 *
 * Settings used to take a pasted pet page and nothing else, so finding a pet
 * meant a trip to openpets.dev in the browser. Now the box searches the
 * catalog by name, a page at a time, and a click installs the pet — the board's
 * pet picker (the website's pet-picker-dialog.tsx), on this Mac.
 *
 * All of the network is here, in main. The settings window has a CSP of
 * `default-src 'self'` and keeps it: it never sees an openpets.dev URL, only
 * thumbnails this file downloaded, checked and saved under the app's own
 * folder, as file: URLs. The catalog is the same one installPack reads to find
 * a zip, so it is fetched once and handed to it rather than downloaded again
 * for every install; it is kept for an hour, and the thumbnails for good
 * (about 5KB each, the whole catalog's under 10MB).
 */

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** Tiles per page: four rows of six in the dialog. */
const PAGE_SIZE = 24;
const CATALOG_TTL_MS = 60 * 60_000;
/** How long a search waits for its thumbnails before answering with the ones it has. */
const THUMB_WAIT_MS = 3000;
const THUMB_TIMEOUT_MS = 10_000;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
/** A thumbnail that failed is not tried again this soon. */
const RETRY_MS = 10 * 60_000;
// An id ends up a file name here and a folder name under themes: Athena's check.
const PET_ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;

/** An https URL on openpets.dev (or a subdomain), else null. */
function openpetsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && /(^|\.)openpets\.dev$/i.test(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The catalog's entries as this file uses them: an id safe on disk, a name to
 * show, and a thumbnail and zip on openpets.dev. Anything else is dropped, and
 * an id listed twice keeps its first entry. Pure.
 */
function catalogEntries(raw) {
  const seen = new Map();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object' || !PET_ID.test(String(entry.id)) || seen.has(entry.id)) continue;
    const zip = openpetsUrl(entry.zip);
    if (!zip) continue;
    const name = String(entry.displayName || entry.name || '').trim() || entry.id;
    seen.set(entry.id, { id: entry.id, name, zip, thumbnail: openpetsUrl(entry.thumbnail) });
  }
  return [...seen.values()];
}

/**
 * One page of the pets matching `query`: every word has to appear in the name
 * or the id, in any order and case, as on the board. Pure.
 */
function searchPets(pets, query, page = 0, pageSize = PAGE_SIZE) {
  const words = String(query || '')
    .slice(0, 100)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const matches = pets.filter((pet) => {
    const text = `${pet.name} ${pet.id}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  const at = Math.min(Math.max(0, Math.floor(Number(page)) || 0), pages - 1);
  return { total: matches.length, page: at, pageSize, pets: matches.slice(at * pageSize, (at + 1) * pageSize) };
}

/** Which kind of image a buffer is, by its magic bytes: 'webp', 'png', or null. */
function imageKind(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }
  return null;
}

class PetCatalog {
  /**
   * @param {object} opts
   * @param {() => Promise<object[]>} opts.load  the raw catalog (add-sprite-pack's loadCatalog)
   * @param {string} opts.thumbsDir  where thumbnails are kept
   */
  constructor({ load, thumbsDir, fetchImpl = fetch, now = Date.now, log = console.warn }) {
    this.load = load;
    this.thumbsDir = thumbsDir;
    this.fetch = fetchImpl;
    this.now = now;
    this.log = log;
    this.cached = null; // { raw, pets, at }
    this.loading = null;
    this.thumbing = new Map();
    this.thumbFailedAt = new Map();
  }

  /** The catalog as downloaded, for installPack: fetched at most hourly, and once at a time. */
  async raw() {
    if (this.cached && this.now() - this.cached.at < CATALOG_TTL_MS) return this.cached.raw;
    if (!this.loading) {
      this.loading = (async () => {
        const raw = await this.load();
        const pets = catalogEntries(raw);
        if (!pets.length) throw new Error('the openpets catalog came back empty');
        this.cached = { raw, pets, at: this.now() };
        return raw;
      })().finally(() => {
        this.loading = null;
      });
    }
    return this.loading;
  }

  async pets() {
    await this.raw();
    return this.cached.pets;
  }

  /** The zip a catalog id installs from, or an error naming the id. */
  async zipFor(id) {
    const pet = PET_ID.test(String(id)) && (await this.pets()).find((p) => p.id === id);
    if (!pet) throw new Error(`no pet named “${id}” in the openpets catalog`);
    return pet.zip;
  }

  /** A thumbnail already on disk, if there is one. */
  savedThumb(id) {
    for (const kind of ['webp', 'png']) {
      const file = path.join(this.thumbsDir, `${id}.${kind}`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  /** Download one pet's thumbnail, once at a time, and keep it. Resolves either way. */
  thumb(pet) {
    if (!pet.thumbnail || this.savedThumb(pet.id)) return Promise.resolve();
    if (this.thumbing.has(pet.id)) return this.thumbing.get(pet.id);
    if (this.now() - (this.thumbFailedAt.get(pet.id) ?? -Infinity) < RETRY_MS) return Promise.resolve();
    const task = (async () => {
      const res = await this.fetch(pet.thumbnail, {
        headers: { 'User-Agent': 'clippy-for-claude' },
        redirect: 'error',
        signal: AbortSignal.timeout(THUMB_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      if (!body.length || body.length > MAX_THUMB_BYTES) throw new Error(`a ${body.length}-byte thumbnail`);
      // Saved under the kind it is, never the kind it claims: what the window
      // shows is an image, whatever the server said.
      const kind = imageKind(body);
      if (!kind) throw new Error('not a WebP or PNG');
      fs.mkdirSync(this.thumbsDir, { recursive: true });
      const file = path.join(this.thumbsDir, `${pet.id}.${kind}`);
      fs.writeFileSync(`${file}.part`, body);
      fs.renameSync(`${file}.part`, file);
    })()
      .then(
        () => this.thumbFailedAt.delete(pet.id),
        (err) => {
          this.thumbFailedAt.set(pet.id, this.now());
          this.log(`clippy: no thumbnail for ${pet.id}:`, err.message);
        }
      )
      .finally(() => this.thumbing.delete(pet.id));
    this.thumbing.set(pet.id, task);
    return task;
  }

  /**
   * A page of search results as the settings window draws them: id, name, a
   * file: URL for the thumbnail (null while it is still on its way — the window
   * asks again), and whether the pet is in the cast already.
   */
  async search(query, page, { installed = [], waitMs = THUMB_WAIT_MS } = {}) {
    const result = searchPets(await this.pets(), query, page);
    const pending = result.pets.map((pet) => this.thumb(pet));
    let timer;
    await Promise.race([Promise.all(pending), new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
    clearTimeout(timer);
    const have = new Set(installed);
    return {
      ...result,
      pets: result.pets.map((pet) => {
        const file = this.savedThumb(pet.id);
        return { id: pet.id, name: pet.name, thumb: file ? pathToFileURL(file).href : null, installed: have.has(pet.id) };
      }),
    };
  }
}

module.exports = { PetCatalog, catalogEntries, searchPets, imageKind, PAGE_SIZE, PET_ID };
