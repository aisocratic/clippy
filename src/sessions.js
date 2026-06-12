'use strict';

const path = require('node:path');

// Session statuses
const WORKING = 'working';
const NEEDS_PERMISSION = 'needs_permission';
const WAITING = 'waiting'; // Claude finished / idle, waiting for the user
const IDLE = 'idle';

/**
 * Tracks the state of every Claude Code session that reports in via hooks,
 * and turns raw hook events into "reactions" for the UI:
 *
 *   { kind: 'attention'|'info'|'clear'|'remove',
 *     urgency: 'urgent'|'normal'|'low',
 *     sessionId, name, cwd, status, message }
 */
class SessionTracker {
  constructor() {
    this.sessions = new Map();
  }

  _upsert(payload) {
    const id = payload.session_id || 'unknown';
    let s = this.sessions.get(id);
    if (!s) {
      s = { sessionId: id, cwd: payload.cwd || '', status: IDLE, updatedAt: 0 };
      this.sessions.set(id, s);
    }
    if (payload.cwd) s.cwd = payload.cwd;
    s.name = s.cwd ? path.basename(s.cwd) : id.slice(0, 8);
    s.updatedAt = Date.now();
    return s;
  }

  _reaction(kind, urgency, s, message) {
    return {
      kind,
      urgency,
      sessionId: s.sessionId,
      name: s.name,
      cwd: s.cwd,
      status: s.status,
      message,
    };
  }

  /**
   * @param {string} eventName  Hook event name (Notification, Stop, ...)
   * @param {string|null} kind  Notification matcher kind (permission_prompt, idle_prompt)
   * @param {object} payload    Hook stdin JSON
   * @returns {object|null}     Reaction for the UI, or null if nothing to do
   */
  handle(eventName, kind, payload = {}) {
    const s = this._upsert(payload);

    switch (eventName) {
      case 'SessionStart':
        s.status = IDLE;
        return this._reaction('info', 'low', s, `Now watching “${s.name}”.`);

      case 'SessionEnd':
        this.sessions.delete(s.sessionId);
        return this._reaction('remove', 'low', s, `Session “${s.name}” ended.`);

      case 'UserPromptSubmit':
        s.status = WORKING;
        return this._reaction('clear', 'low', s, '');

      case 'Stop':
        s.status = WAITING;
        return this._reaction(
          'attention',
          'normal',
          s,
          `Claude finished in “${s.name}” — it's your turn!`
        );

      case 'Notification':
        if (kind === 'permission_prompt') {
          s.status = NEEDS_PERMISSION;
          return this._reaction(
            'attention',
            'urgent',
            s,
            `Hey! Claude needs your permission in “${s.name}”.`
          );
        }
        if (kind === 'idle_prompt') {
          s.status = WAITING;
          return this._reaction(
            'attention',
            'normal',
            s,
            `Claude is still waiting for your reply in “${s.name}”.`
          );
        }
        return this._reaction(
          'attention',
          'normal',
          s,
          `Claude needs your attention in “${s.name}”.`
        );

      default:
        return null;
    }
  }

  list() {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }

  counts() {
    let waiting = 0;
    for (const s of this.sessions.values()) {
      if (s.status === NEEDS_PERMISSION || s.status === WAITING) waiting++;
    }
    return { total: this.sessions.size, waiting };
  }
}

module.exports = { SessionTracker, WORKING, NEEDS_PERMISSION, WAITING, IDLE };
