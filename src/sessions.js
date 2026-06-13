'use strict';

const path = require('node:path');
const { activityLabel } = require('./decisions');

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
      s = { sessionId: id, cwd: payload.cwd || '', status: IDLE, activity: null, updatedAt: 0 };
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
      activity: s.activity,
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
        s.activity = null;
        return this._reaction('info', 'low', s, `Now watching “${s.name}”.`);

      case 'SessionEnd':
        this.sessions.delete(s.sessionId);
        return this._reaction('remove', 'low', s, `Session “${s.name}” ended.`);

      case 'UserPromptSubmit':
        s.status = WORKING;
        s.activity = { tool: null, label: 'Working…', state: 'start', ok: true };
        return this._reaction('clear', 'low', s, '');

      case 'PreToolUse': {
        // Ambient: what Claude is about to do. The matcher already filters to
        // meaningful tools, so every PreToolUse here is worth showing.
        const tool = payload.tool_name || 'tool';
        s.status = WORKING;
        s.activity = { tool, label: activityLabel(tool, payload.tool_input), state: 'start', ok: true };
        return this._reaction('activity', 'low', s, '');
      }

      case 'PostToolUse': {
        const tool = payload.tool_name || 'tool';
        const ok = payload.success !== false; // absent -> assume success
        s.status = WORKING;
        s.activity = {
          tool,
          label: activityLabel(tool, payload.tool_input),
          state: 'done',
          ok,
        };
        return this._reaction('activity', 'low', s, ok ? '' : `${tool} failed in “${s.name}”.`);
      }

      case 'PermissionRequest':
        // Held open by the decision broker — the user can answer from Clippy.
        s.status = NEEDS_PERMISSION;
        return this._reaction(
          'approval',
          'urgent',
          s,
          `Claude wants to do something in “${s.name}” — approve it?`
        );

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

  /** Adjust a session's status after an interactive decision resolves. */
  setStatus(sessionId, status) {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.status = status;
      s.updatedAt = Date.now();
    }
  }

  /** Set the live activity for a session (used by Drive mode's SDK stream). */
  setActivity(sessionId, activity) {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.activity = activity;
      s.updatedAt = Date.now();
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
