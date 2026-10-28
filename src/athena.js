'use strict';

/**
 * The pets Athena gives its agents, worn by their sessions here.
 *
 * Athena (the orchestrator behind aisocratic.org's board) hands every agent it
 * sees a pet from the OpenPets catalog and keeps it; a person can change it
 * from the admin's pet picker. Its `GET /api/fleet` lists each agent with the
 * Claude or Codex `session_id` it runs and that `pet` — and a session id is
 * exactly what Clippy keys its buddies on. So a session Athena knows wears the
 * pet Athena picked, not one Clippy hashes up for it, and a pet changed on the
 * board shows here on the next poll.
 *
 * OpenPets is also where Clippy's own "add a pet" box downloads from, and a
 * pack installs under its catalog id, so Athena's pet id *is* the character
 * id. A pet that is not installed yet is installed the first time a session
 * asks for it; until that lands the session keeps its usual face.
 *
 * Off unless there is a token: Athena answers nothing without one, and with
 * no Athena on this Mac there is nothing to poll.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_URL = 'http://127.0.0.1:3400';
const POLL_MS = 15_000;
const TIMEOUT_MS = 4_000;
// The id ends up a folder name under the themes folder: Athena's own check.
const PET_ID = /^[a-z0-9][a-z0-9-]{0,99}$/i;
// A pet whose install failed is not tried again this soon.
const RETRY_MS = 10 * 60_000;

/**
 * Where Athena is and the token it wants, or null when there is no token.
 *
 * Kept in `athena.json` next to the settings rather than in them: the
 * settings are sent whole to every window, and a bearer token has no business
 * in a renderer. `ATHENA_URL` and `ATHENA_API_TOKEN` — the names Athena's own
 * CLI reads — override the file.
 *
 *   <userData>/athena.json   { "url": "http://127.0.0.1:3400", "token": "…" }
 *
 * @param {string} dir  the app's userData folder
 * @param {object} env
 */
function athenaConfig(dir, env = process.env) {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(path.join(dir, 'athena.json'), 'utf8')) || {};
  } catch {
    // no file: env or nothing
  }
  const url = String(env.ATHENA_URL || saved.url || DEFAULT_URL).replace(/\/+$/, '');
  const token = String(env.ATHENA_API_TOKEN || saved.token || '').trim();
  if (!token || !/^https?:\/\/[^/]/i.test(url)) return null;
  return { url, token };
}

/**
 * Session id → pet id, from a fleet body. Pure.
 *
 * The fleet keeps agents that have since disconnected, and one session can sit
 * in it twice (a run Athena started, and the herdr pane it ran in): a connected
 * row wins over a gone one. Rows without a session id (Codex, before its first
 * turn) or without a usable pet are skipped.
 */
function petsBySession(fleet) {
  const agents = Array.isArray(fleet && fleet.agents) ? fleet.agents : [];
  const bySession = new Map();
  const ordered = [...agents].sort((a, b) => Number(Boolean(a && a.connected)) - Number(Boolean(b && b.connected)));
  for (const agent of ordered) {
    const session = agent && agent.session_id;
    const pet = agent && agent.pet && agent.pet.id;
    if (typeof session === 'string' && session && typeof pet === 'string' && PET_ID.test(pet)) {
      bySession.set(session, pet);
    }
  }
  return bySession;
}

const sameMap = (a, b) => a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);

class AthenaPets {
  /**
   * @param {object} opts
   * @param {{url: string, token: string}} opts.config  from athenaConfig
   * @param {() => string[]} opts.installed    character ids on disk now
   * @param {(id: string) => Promise<unknown>} opts.install  installs an OpenPets pet by id
   * @param {() => void} opts.onChange  a session's pet changed, or one finished installing
   * @param {() => string[]} [opts.live]  the sessions Clippy is tracking: their pets are installed
   *   ahead of being asked for, since the shared buddy never asks
   */
  constructor({ config, installed, install, onChange, live = () => [], fetchImpl = fetch, log = console.warn, now = Date.now }) {
    this.config = config;
    this.installed = installed;
    this.live = live;
    this.install = install;
    this.onChange = onChange;
    this.fetch = fetchImpl;
    this.log = log;
    this.now = now;
    this.bySession = new Map();
    this.installing = new Set();
    this.failedAt = new Map();
    // One download at a time: a fleet of new pets is not a burst of zips.
    this.queue = Promise.resolve();
    this.lastError = '';
    this.timer = null;
  }

  /** The pet this session should wear, if Athena gave it one and it is installed. */
  petFor(sessionId) {
    const id = this.bySession.get(sessionId);
    if (!id) return '';
    if (this.installed().includes(id)) return id;
    this.ensure(id);
    return '';
  }

  ensure(id) {
    if (this.installing.has(id)) return;
    if (this.now() - (this.failedAt.get(id) ?? -Infinity) < RETRY_MS) return;
    this.installing.add(id);
    this.queue = this.queue
      .then(() => this.install(id))
      .then(
        () => {
          this.failedAt.delete(id);
          this.onChange();
        },
        (err) => {
          this.failedAt.set(id, this.now());
          this.log(`clippy: could not install Athena's pet ${id}:`, err.message);
        }
      )
      .finally(() => this.installing.delete(id));
  }

  /** Read the fleet once. Athena being down is ordinary, so it is said once, not every poll. */
  async poll() {
    try {
      const res = await this.fetch(`${this.config.url}/api/fleet`, {
        headers: { Authorization: `Bearer ${this.config.token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = petsBySession(await res.json());
      this.lastError = '';
      if (!sameMap(next, this.bySession)) {
        this.bySession = next;
        this.onChange();
      }
      // Only the sessions on screen: the fleet remembers every agent it has ever run.
      for (const sessionId of this.live()) this.petFor(sessionId);
    } catch (err) {
      if (err.message !== this.lastError) this.log(`clippy: Athena not read (${this.config.url}):`, err.message);
      this.lastError = err.message;
    }
  }

  start(everyMs = POLL_MS) {
    this.poll();
    this.timer = setInterval(() => this.poll(), everyMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { AthenaPets, athenaConfig, petsBySession, DEFAULT_URL };
