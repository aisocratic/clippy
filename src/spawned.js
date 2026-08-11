'use strict';

/**
 * The sessions Clippy started, and how a hook finds its way back to one.
 *
 * A watched session announces itself: the first hook carries its `session_id`,
 * and everything downstream is keyed by that. A session Clippy *spawned* is the
 * other way round — we know the tmux session, the pane and its pid before the
 * agent has said anything at all, and there is no SessionStart hook, so the
 * first word from a fresh agent arrives whenever the user first prompts it.
 *
 * Claude closes that gap by letting us pick the session id (`--session-id`), so
 * its buddy is correctly keyed from the moment it is spawned. Codex has no such
 * flag, so its record starts anonymous and gets *adopted* when a hook turns up
 * whose process is descended from our pane — see `matchHookPid`.
 *
 * Adoption is reversible on purpose. The pane outlives the agent (the launch
 * command ends in `exec $SHELL -il`), so an agent quitting means the session
 * goes back to being anonymous, not that it is gone.
 */

const { ancestorsOf } = require('./terminal');

// Enough to be generous, small enough that a settings file stays readable.
const SESSION_CAP = 16;
const PROJECT_CAP = 8;

/** The key a spawned session's buddy lives under, before and after adoption. */
const buddyKeyFor = (record) => (record && record.sessionId) || `tmux:${record && record.name}`;

/** Is this buddy key one of ours-but-not-yet-adopted? */
const isTmuxKey = (key) => typeof key === 'string' && key.startsWith('tmux:');

const clean = (record) => {
  if (!record || typeof record.name !== 'string' || !record.name) return null;
  return {
    name: record.name,
    cwd: typeof record.cwd === 'string' ? record.cwd : '',
    agent: record.agent === 'codex' ? 'codex' : 'claude',
    host: typeof record.host === 'string' ? record.host : '',
    remotePath: typeof record.remotePath === 'string' ? record.remotePath : '',
    paneId: typeof record.paneId === 'string' ? record.paneId : '',
    panePid: Number(record.panePid) || 0,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
    createdAt: Number(record.createdAt) || 0,
  };
};

class SpawnedSessions {
  /** @param {object[]} [records] Whatever was in settings last time. */
  constructor(records = []) {
    this.records = new Map();
    this.load(records);
  }

  /**
   * Replace the registry with what the settings file holds.
   *
   * Separate from the constructor because the settings file is only read once
   * the app is ready, long after this module is loaded — and rebinding the
   * instance instead would leave anything that captured the old one holding an
   * empty registry.
   */
  load(records) {
    this.records.clear();
    for (const raw of Array.isArray(records) ? records : []) {
      const record = clean(raw);
      if (record) this.records.set(record.name, record);
    }
    return this;
  }

  add(record) {
    const entry = clean(record);
    if (!entry) return null;
    this.records.set(entry.name, entry);
    // Oldest first out, so a long-running session is never dropped for a
    // handful of short-lived ones started after it.
    while (this.records.size > SESSION_CAP) {
      const oldest = [...this.records.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      this.records.delete(oldest.name);
    }
    return entry;
  }

  get(name) {
    return this.records.get(name) || null;
  }

  list() {
    return [...this.records.values()];
  }

  remove(name) {
    return this.records.delete(name);
  }

  forSession(sessionId) {
    if (!sessionId) return null;
    for (const record of this.records.values()) {
      if (record.sessionId === sessionId) return record;
    }
    return null;
  }

  /** Resolve either kind of buddy key — an adopted session id, or `tmux:<name>`. */
  forKey(key) {
    if (!key) return null;
    return isTmuxKey(key) ? this.get(key.slice(5)) : this.forSession(key);
  }

  /** Is anything still waiting for a hook to tell us who it is? */
  hasUnadopted() {
    for (const record of this.records.values()) if (!record.sessionId) return true;
    return false;
  }

  adopt(name, sessionId) {
    const record = this.get(name);
    if (!record || !sessionId) return null;
    record.sessionId = sessionId;
    return record;
  }

  /** The agent behind this session ended; the tmux session did not. */
  release(sessionId) {
    const record = this.forSession(sessionId);
    if (!record) return null;
    record.sessionId = '';
    return record;
  }

  /**
   * Which spawned session does a hook belong to?
   *
   * The hook reports the agent's own pid. Its parent is the shell tmux put in
   * the pane, whose pid we recorded at spawn. A walk rather than an equality
   * test, because the chain can legitimately grow a link — an npm shim, a
   * wrapper script — and because a pane whose command `exec`s has no
   * intermediate shell at all.
   *
   * Only unadopted records are candidates, so a hook can never be stolen from
   * a session that already knows its own name.
   */
  matchHookPid(pid, table, { maxHops = 12 } = {}) {
    if (!pid || !table) return null;
    const chain = ancestorsOf(pid, table, { maxHops });
    if (!chain.length) return null;
    for (const record of this.records.values()) {
      if (!record.sessionId && record.panePid && chain.includes(record.panePid)) return record;
    }
    return null;
  }

  /**
   * Drop everything tmux no longer has. Returns what went, so the caller can
   * clean up the buddies and scratch files that went with them.
   */
  keep(liveNames) {
    const live = new Set(liveNames || []);
    const removed = [];
    for (const record of [...this.records.values()]) {
      if (live.has(record.name)) continue;
      this.records.delete(record.name);
      removed.push(record);
    }
    return removed;
  }

  /**
   * What belongs in the settings file, and only that.
   *
   * Records pick up runtime company as they are used — the resolved transcript
   * path, the last thing the agent said, the turns kept for the panel. None of
   * that is settings, and the conversation least of all: it is read from a file
   * that already exists and has no business being copied into another one.
   */
  toJSON() {
    return this.list().map(clean);
  }
}

/**
 * The recent-projects list, most recent first.
 *
 * Keyed by path *and* host: the same path on two machines is two projects, and
 * re-opening one should move it to the top rather than add a second row.
 */
function rememberProject(list, entry, { cap = PROJECT_CAP } = {}) {
  const path = entry && typeof entry.path === 'string' ? entry.path : '';
  const host = entry && typeof entry.host === 'string' ? entry.host : '';
  if (!path && !host) return Array.isArray(list) ? list.slice(0, cap) : [];

  const next = {
    path,
    host,
    remotePath: (entry && entry.remotePath) || '',
    agent: entry && entry.agent === 'codex' ? 'codex' : 'claude',
    at: Number(entry && entry.at) || 0,
  };
  const rest = (Array.isArray(list) ? list : []).filter(
    (item) => item && !(item.path === path && (item.host || '') === host)
  );
  return [next, ...rest].slice(0, cap);
}

module.exports = { SpawnedSessions, buddyKeyFor, isTmuxKey, rememberProject, SESSION_CAP, PROJECT_CAP };
