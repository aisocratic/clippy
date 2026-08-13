'use strict';

const path = require('node:path');

/**
 * Holds hook requests that want an interactive answer from the user
 * (PreToolUse approvals, Stop reviews) and resolves them with a decision,
 * a timeout, or a cancellation. Pure logic — no Electron, fully testable.
 *
 * Every ask() resolves eventually; a held hook must never stall Claude Code
 * past the curl/hook timeout, so callers give us a holdMs and we guarantee
 * resolution by then (extensions are capped at hardCapMs from creation).
 */

let nextId = 1;

class DecisionBroker {
  constructor({ hardCapMs = 110_000 } = {}) {
    this.hardCapMs = hardCapMs;
    this.pending = new Map(); // id -> entry
  }

  /**
   * Register a request awaiting a user decision.
   * @param {object} meta  { event, sessionId, ... } anything the UI needs
   * @param {number} holdMs  how long to wait before auto-resolving
   * @returns {{ id: string, expiresAt: number, promise: Promise<{action: string, message: string, timedOut: boolean}> }}
   */
  ask(meta, holdMs) {
    const id = `d${nextId++}`;
    const createdAt = Date.now();
    // The hard cap is what keeps us inside the hook's curl deadline, so it has
    // to bound the *initial* hold too — not just extensions. Otherwise a large
    // CLIPPY_*_HOLD_SECS makes curl give up first and the card outlives the
    // hook it was supposed to answer.
    const hold = Math.max(1, Math.min(Number(holdMs) || 0, this.hardCapMs));
    const entry = {
      id,
      meta,
      createdAt,
      expiresAt: createdAt + hold,
      resolve: null,
      timer: null,
    };
    const promise = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    entry.timer = setTimeout(() => this._finish(entry, 'timeout', '', true), hold);
    this.pending.set(id, entry);
    return { id, expiresAt: entry.expiresAt, promise };
  }

  /** User made a choice. Returns false if the request is gone (already resolved). */
  resolve(id, action, message = '') {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this._finish(entry, action, message, false);
    return true;
  }

  /**
   * User is interacting (typing a reason); push the deadline out, but never
   * past hardCapMs after creation. Returns the new expiresAt, or null.
   */
  extend(id, extraMs = 30_000) {
    const entry = this.pending.get(id);
    if (!entry) return null;
    const cap = entry.createdAt + this.hardCapMs;
    const next = Math.min(Date.now() + extraMs, cap);
    if (next <= entry.expiresAt) return entry.expiresAt;
    entry.expiresAt = next;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => this._finish(entry, 'timeout', '', true),
      next - Date.now()
    );
    return next;
  }

  /** Is anything still waiting on an answer for this session? */
  hasPending(sessionId) {
    for (const entry of this.pending.values()) {
      if (entry.meta.sessionId === sessionId) return true;
    }
    return false;
  }

  /** Drop every pending request for a session (e.g. the session ended). */
  cancelBySession(sessionId) {
    for (const entry of [...this.pending.values()]) {
      if (entry.meta.sessionId === sessionId) {
        this._finish(entry, 'cancel', '', false);
      }
    }
  }

  list() {
    return [...this.pending.values()].map((e) => ({
      id: e.id,
      meta: e.meta,
      expiresAt: e.expiresAt,
    }));
  }

  _finish(entry, action, message, timedOut) {
    if (!this.pending.has(entry.id)) return;
    this.pending.delete(entry.id);
    clearTimeout(entry.timer);
    entry.resolve({ action, message, timedOut });
  }
}

/**
 * The UI sends its answer map as { questionText: label | [labels] }.
 * AskUserQuestion's `answers` field wants exactly one string per question —
 * a multi-select answer is the chosen labels comma-joined, the same shape the
 * terminal picker records. Anything the user typed that isn't one of the
 * offered options is fine too; Claude reads it as an "Other" answer.
 *
 * Returns null when there's nothing usable, so callers fall back to `{}`
 * (i.e. let the terminal picker handle it) instead of sending junk to Claude.
 */
/**
 * The same answers, but keeping a multi-select as a list.
 *
 * `normalizeAnswers` joins them with commas, because Claude's `updatedInput`
 * wants one string per question. Codex wants `answers: ["A", "B"]` — joining
 * there produced a single option labelled `"A, B"`, which matches nothing it
 * offered, so a multi-select answered in Clippy arrived as gibberish.
 *
 * @returns {Record<string, string[]>|null}
 */
function normalizeAnswerLists(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const answers = {};
  for (const [question, value] of Object.entries(obj)) {
    const list = (Array.isArray(value) ? value : [value])
      .map((v) => String(v ?? '').trim())
      .filter(Boolean);
    if (question && list.length) answers[question] = list;
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

function normalizeAnswers(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const answers = {};
  for (const [question, value] of Object.entries(obj)) {
    const text = Array.isArray(value)
      ? value.map((v) => String(v ?? '').trim()).filter(Boolean).join(', ')
      : String(value ?? '').trim();
    if (question && text) answers[question] = text;
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

/**
 * Translate a user decision into the JSON Claude Code or Codex expects on the
 * hook's stdout. `{}` means "no opinion" — the agent falls through to its
 * normal permission/question flow, so it is always safe.
 *
 * @param {object} [opts]
 * @param {object} [opts.toolInput] original tool_input, needed to answer a question.
 * @param {string} [opts.source]    hook source (`claude` or `codex`).
 * @param {string} [opts.toolName]  canonical tool name.
 */
function toHookResponse(event, action, message = '', { toolInput, source, toolName } = {}) {
  // PreToolUse on AskUserQuestion: `updatedInput` replaces the tool's arguments
  // before it runs, and an AskUserQuestion that already carries `answers` has
  // nothing left to ask — so the terminal picker never appears and Claude reads
  // our answer as the user's. This is the CLI equivalent of the Agent SDK's
  // canUseTool allow+updatedInput, and it's what makes questions answerable
  // from Clippy in watch mode.
  if (event === 'PreToolUse') {
    // Codex's request_user_input arguments do not have a pre-filled answer
    // field. Instead, consume the tool call and return the selected values in
    // the blocking reason: Codex receives that reason as the tool result and
    // can continue without ever opening its terminal picker.
    if (source === 'codex' || toolName === 'request_user_input') {
      // Lists, not a joined string: Codex takes one entry per chosen option.
      const answers = action === 'answer' ? normalizeAnswerLists(message) : null;
      if (!answers) return {}; // pass / dismiss / timeout -> native Codex picker

      const byId = {};
      for (const q of Array.isArray(toolInput?.questions) ? toolInput.questions : []) {
        const selected = answers[q.question];
        if (!selected || !q.id) continue;
        byId[q.id] = { answers: selected };
      }
      if (Object.keys(byId).length === 0) return {};

      const response = JSON.stringify({ answers: byId });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `The user answered this request through Clippy. ` +
            `Treat this as the request_user_input response and continue: ${response}`,
        },
      };
    }

    const answers = action === 'answer' ? normalizeAnswers(message) : null;
    if (!answers) return {}; // pass / dismiss / timeout / cancel -> terminal picker
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { ...(toolInput || {}), answers },
      },
    };
  }

  if (event === 'PermissionRequest') {
    if (action === 'allow') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      };
    }
    if (action === 'deny') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message: message || 'Denied by the user via Clippy.',
          },
        },
      };
    }
    return {}; // pass / timeout / cancel -> normal terminal prompt
  }

  // Stop is passive: the hook is always answered {} immediately (the chat is
  // never held), and review feedback goes back as a typed prompt instead.
  return {};
}

const clipTo = (s, n) =>
  String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? '');

/* What "read all" is allowed to hand back. A card cut at 400 characters is a
   card doing its job; a 4MB file pasted into a window over someone's desktop
   is not, so the whole version has a ceiling too — a generous one. */
const FULL_DETAIL_MAX = 20000;

/**
 * One-line-ish human summary of a tool call for the approval card, plus the
 * same summary with the card's limits taken off.
 *
 * `fullDetail` is empty whenever nothing was cut, so it doubles as the answer
 * to "is there more of this?" — which is what decides whether the card offers
 * to show the rest.
 */
function describeToolCall(toolName, toolInput = {}) {
  const card = describeWith(toolName, toolInput, (s, n = 700) => clipTo(s, n));
  const whole = describeWith(toolName, toolInput, (s) => clipTo(s, FULL_DETAIL_MAX));
  return { ...card, fullDetail: whole.detail === card.detail ? '' : whole.detail };
}

function describeWith(toolName, toolInput, clip) {
  switch (toolName) {
    case 'Bash':
      return {
        title: toolInput.description ? `Run: ${clip(toolInput.description, 80)}` : 'Run a shell command',
        detail: `$ ${clip(toolInput.command)}`,
      };
    case 'Write':
      return {
        title: 'Write a file',
        detail: `${toolInput.file_path || '?'}\n\n${clip(toolInput.content, 400)}`,
      };
    case 'Edit':
      // The name is the decision ("is Claude touching the right file?"); the
      // old/new dump was noise at card size — the diff belongs in the editor.
      return {
        title: `Edit ${path.basename(String(toolInput.file_path || '?'))}`,
        detail: toolInput.file_path || '?',
      };
    case 'MultiEdit': {
      const n = Array.isArray(toolInput.edits) ? toolInput.edits.length : '?';
      return {
        title: `Edit ${path.basename(String(toolInput.file_path || '?'))}`,
        detail: `${toolInput.file_path || '?'} (${n} edits)`,
      };
    }
    case 'apply_patch': {
      const patchText = String(toolInput.command || '');
      const match = patchText.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m);
      const file = match && match[1].trim();
      return {
        title: file ? `Edit ${path.basename(file)}` : 'Apply a patch',
        detail: file || clip(patchText, 700) || '(patch details unavailable)',
      };
    }
    case 'NotebookEdit':
      return { title: 'Edit a notebook', detail: `${toolInput.notebook_path || '?'}` };
    case 'ExitPlanMode':
      return {
        title: '📋 Review the plan',
        detail: clip(toolInput.plan, 4000) || '(no plan text)',
      };
    case 'AskUserQuestion':
    case 'request_user_input': {
      const qs = Array.isArray(toolInput.questions) ? toolInput.questions : [];
      const first = qs[0] || {};
      const detail = qs
        .map((q) => {
          const opts = (q.options || [])
            .map((o) => `  • ${o.label}${o.description ? ` — ${clip(o.description, 80)}` : ''}`)
            .join('\n');
          return `${q.question}\n${opts}`;
        })
        .join('\n\n');
      return { title: first.question ? clip(first.question, 90) : 'The agent is asking a question', detail };
    }
    default:
      return { title: `Use tool: ${toolName}`, detail: clip(JSON.stringify(toolInput, null, 1), 400) };
  }
}

/**
 * Terse, present-tense one-liner for the ambient activity line —
 * "Running: npm test", "Editing src/server.js". Shorter and more verb-forward
 * than describeToolCall (which titles the full approval card).
 */
function activityLabel(toolName, toolInput = {}) {
  const clip = (s, n = 60) =>
    String(s ?? '').length > n ? `${String(s).slice(0, n)}…` : String(s ?? '');
  const base = (p) => (p ? path.basename(String(p)) : '?');

  switch (toolName) {
    case 'Bash':
      return `Running: ${clip(toolInput.description || toolInput.command)}`;
    case 'Write':
      return `Writing ${base(toolInput.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${base(toolInput.file_path)}`;
    case 'apply_patch': {
      const match = String(toolInput.command || '').match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m);
      return match ? `Editing ${base(match[1].trim())}` : 'Applying a patch';
    }
    case 'NotebookEdit':
      return `Editing ${base(toolInput.notebook_path)}`;
    case 'WebFetch': {
      let host = toolInput.url || '';
      try {
        host = new URL(toolInput.url).host;
      } catch {}
      return `Fetching ${clip(host, 40)}`;
    }
    case 'WebSearch':
      return `Searching: ${clip(toolInput.query, 40)}`;
    case 'Task':
      return `Delegating: ${clip(toolInput.description || toolInput.subagent_type || 'subagent', 40)}`;
    case 'ExitPlanMode':
      return 'Presenting a plan';
    case 'AskUserQuestion':
    case 'request_user_input':
      return 'Asking you a question';
    default:
      return /^mcp__/.test(toolName) ? `Using ${toolName.replace(/^mcp__/, '')}` : `Using ${toolName}`;
  }
}

module.exports = {
  DecisionBroker,
  toHookResponse,
  normalizeAnswers,
  normalizeAnswerLists,
  describeToolCall,
  activityLabel,
  FULL_DETAIL_MAX,
};
