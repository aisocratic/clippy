'use strict';

const path = require('node:path');
const { activityLabel } = require('./decisions');

// Session statuses
const WORKING = 'working';
const NEEDS_PERMISSION = 'needs_permission';
const WAITING = 'waiting'; // Claude finished / idle, waiting for the user
const IDLE = 'idle';

// A terminal that gets killed (or a machine that sleeps) never sends
// SessionEnd, so sessions can linger forever and inflate the "waiting on you"
// count. Busy sessions emit tool hooks constantly, so silence means gone;
// sessions parked on the user are legitimately quiet and get a long leash.
const STALE_ACTIVE_MS = 30 * 60 * 1000;
const STALE_PARKED_MS = 6 * 60 * 60 * 1000;

const firstLine = (s) => String(s ?? '').split('\n')[0].slice(0, 200);

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
    this.terminals = new Map(); // sessionId -> { program, tty, pid }
    this.transcripts = new Map(); // sessionId -> transcript_path
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
        this.terminals.delete(s.sessionId);
        this.transcripts.delete(s.sessionId);
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
        // Claude Code only fires PostToolUse when the tool *succeeded* —
        // failures come through PostToolUseFailure below. The extra checks are
        // belt-and-braces for tools that report a soft error in their result.
        const tool = payload.tool_name || 'tool';
        const ok = payload.success !== false && !payload.tool_response?.is_error;
        s.status = WORKING;
        s.activity = {
          tool,
          label: activityLabel(tool, payload.tool_input),
          state: 'done',
          ok,
        };
        return this._reaction('activity', 'low', s, ok ? '' : `${tool} failed in “${s.name}”.`);
      }

      case 'PostToolUseFailure': {
        // The tool actually failed (non-zero exit, error thrown, …) — payload
        // carries `error`. An interrupt is the user hitting esc, not a failure,
        // so it gets a plain "done" rather than a ⚠.
        const tool = payload.tool_name || 'tool';
        const interrupted = payload.is_interrupt === true;
        s.status = WORKING;
        s.activity = {
          tool,
          label: activityLabel(tool, payload.tool_input),
          state: 'done',
          ok: interrupted,
          error: interrupted ? '' : firstLine(payload.error),
        };
        return this._reaction(
          'activity',
          'low',
          s,
          interrupted ? '' : `${tool} failed in “${s.name}”.`
        );
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

  /**
   * Remember which terminal window a session is running in (from the hook's
   * X-Clippy-* headers) so Clippy can raise it and perch on it. Kept beside the
   * session map rather than inside it, so it doesn't depend on which hook
   * arrives first. Ignores empty context — hooks from an older install send none.
   *
   * @returns {boolean} true the first time we learn a session's terminal
   */
  setTerminal(sessionId, terminal) {
    if (!sessionId || !terminal) return false;
    const isNew = !this.terminals.has(sessionId);
    this.terminals.set(sessionId, terminal);
    return isNew;
  }

  /** The terminal context we last saw for a session, if any. */
  terminalFor(sessionId) {
    return this.terminals.get(sessionId) || null;
  }

  /** The project directory a session runs in ('' if we haven't seen it yet). */
  cwdFor(sessionId) {
    return this.sessions.get(sessionId)?.cwd || '';
  }

  /** Where Claude Code is writing this session's transcript (for token usage). */
  setTranscript(sessionId, transcriptPath) {
    if (sessionId && transcriptPath) this.transcripts.set(sessionId, transcriptPath);
  }

  transcriptFor(sessionId) {
    return this.transcripts.get(sessionId) || '';
  }

  /** Set the live activity for a session (used by Drive mode's SDK stream). */
  setActivity(sessionId, activity) {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.activity = activity;
      s.updatedAt = Date.now();
    }
  }

  /**
   * Drop sessions we haven't heard from in a long time (killed terminal, no
   * SessionEnd). Returns the removed sessions so the caller can clean up the
   * UI and any cards still held for them.
   */
  sweepStale(now = Date.now(), { activeMs = STALE_ACTIVE_MS, parkedMs = STALE_PARKED_MS } = {}) {
    const removed = [];
    for (const s of [...this.sessions.values()]) {
      const parked = s.status === WAITING || s.status === NEEDS_PERMISSION;
      if (now - s.updatedAt > (parked ? parkedMs : activeMs)) {
        this.sessions.delete(s.sessionId);
        this.terminals.delete(s.sessionId);
        this.transcripts.delete(s.sessionId);
        removed.push({ ...s });
      }
    }
    return removed;
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      ...s,
      terminal: this.terminals.get(s.sessionId) || null,
    }));
  }

  counts() {
    let waiting = 0;
    for (const s of this.sessions.values()) {
      if (s.status === NEEDS_PERMISSION || s.status === WAITING) waiting++;
    }
    return { total: this.sessions.size, waiting };
  }
}

module.exports = {
  SessionTracker,
  WORKING,
  NEEDS_PERMISSION,
  WAITING,
  IDLE,
  STALE_ACTIVE_MS,
  STALE_PARKED_MS,
};
