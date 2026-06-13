'use strict';

const path = require('node:path');
const { DecisionBroker, describeToolCall, activityLabel } = require('./decisions');

// Drive mode: a headless Claude Code session that Clippy *owns* (via the Agent
// SDK), as opposed to the hook path which only watches the user's terminal
// sessions. Because we drive it through the SDK's `canUseTool` callback, every
// permission request, plan approval, AND multiple-choice AskUserQuestion is
// answerable from the GUI — the thing the CLI hook API can't do.
//
// The SDK (`@anthropic-ai/claude-agent-sdk`) is ESM-only and bundles the
// `claude` binary, so it's lazy-imported on first start and treated as an
// optional dependency. Pass `runQuery` to inject a fake for tests.

const QUESTION_HOLD_MS = 5 * 60 * 1000; // Drive owns the session — wait generously

/** Map a user card decision to the SDK PermissionResult shape. Pure + tested. */
function toPermissionResult(toolName, action, message, input) {
  if (toolName === 'AskUserQuestion') {
    if (action === 'answer' && message) {
      let answers;
      try {
        answers = JSON.parse(message);
      } catch {
        answers = {};
      }
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    return { behavior: 'deny', message: 'The user dismissed the question.' };
  }
  if (action === 'allow') return { behavior: 'allow', updatedInput: input };
  if (action === 'deny') return { behavior: 'deny', message: message || 'Denied by the user.' };
  // timeout / cancel / pass — Drive owns the session, so default to a safe deny.
  return { behavior: 'deny', message: message || 'No response from the user.' };
}

/** Normalize an SDK stream message into transcript / activity updates. Pure. */
function normalizeMessage(msg) {
  if (!msg || typeof msg !== 'object') return [];
  const out = [];
  if (msg.type === 'assistant') {
    const blocks = msg.message?.content || msg.content || [];
    for (const b of Array.isArray(blocks) ? blocks : []) {
      if (b.type === 'text' && b.text) out.push({ kind: 'text', role: 'assistant', text: b.text });
      else if (b.type === 'tool_use') out.push({ kind: 'activity', tool: b.name, label: activityLabel(b.name, b.input) });
    }
  } else if (msg.type === 'tool_use') {
    out.push({ kind: 'activity', tool: msg.toolName || msg.name, label: activityLabel(msg.toolName || msg.name, msg.input) });
  } else if (msg.type === 'result') {
    out.push({ kind: 'result', text: msg.result || '' });
  }
  return out;
}

class DriveSession {
  /**
   * @param {object} opts
   * @param {(event: object) => void} opts.send  push an event to the renderer
   * @param {string} [opts.cwd]
   * @param {string} [opts.id]
   * @param {(queryOpts: object) => AsyncIterable} [opts.runQuery]  inject for tests
   */
  constructor({ send, cwd = process.cwd(), id = 'drive', runQuery = null }) {
    this.send = send;
    this.cwd = cwd;
    this.id = id;
    this.name = path.basename(cwd) || 'drive';
    this._runQuery = runQuery;
    this.broker = new DecisionBroker({ hardCapMs: QUESTION_HOLD_MS + 10_000 });
    this._queue = [];
    this._waiters = [];
    this._closed = false;
    this.running = false;
  }

  async _loadRunQuery() {
    if (this._runQuery) return this._runQuery;
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    return (opts) => mod.query(opts);
  }

  /** Streaming input: yields user prompts as the GUI submits them. */
  async *_inputStream() {
    while (!this._closed) {
      if (this._queue.length === 0) {
        await new Promise((res) => this._waiters.push(res));
      }
      while (this._queue.length) {
        const text = this._queue.shift();
        if (text === null) return; // stop sentinel
        yield { type: 'user', message: { role: 'user', content: text } };
      }
    }
  }

  /** Queue a prompt from the GUI (multi-turn streaming input). */
  prompt(text) {
    if (this._closed) return;
    this.send({ kind: 'drive-transcript', role: 'user', text });
    this._queue.push(text);
    const w = this._waiters.shift();
    if (w) w();
  }

  async start({ permissionMode = 'default', model } = {}) {
    const runQuery = await this._loadRunQuery();
    this.running = true;
    this.send({ kind: 'drive-status', status: 'running', name: this.name, cwd: this.cwd });
    this._iter = runQuery({
      prompt: this._inputStream(),
      options: {
        cwd: this.cwd,
        permissionMode,
        ...(model ? { model } : {}),
        canUseTool: (toolName, input, extra) => this._canUseTool(toolName, input, extra),
      },
    });
    this._consume();
  }

  async _consume() {
    try {
      for await (const msg of this._iter) {
        if (msg && msg.session_id) this.sessionId = msg.session_id;
        for (const u of normalizeMessage(msg)) {
          if (u.kind === 'text') this.send({ kind: 'drive-transcript', role: 'assistant', text: u.text });
          else if (u.kind === 'activity') this.send({ kind: 'drive-activity', label: u.label, tool: u.tool });
          else if (u.kind === 'result') this.send({ kind: 'drive-status', status: 'turn-done' });
        }
      }
    } catch (err) {
      this.send({ kind: 'drive-status', status: 'error', message: String(err && err.message) });
    } finally {
      this.running = false;
      this.send({ kind: 'drive-status', status: 'ended' });
    }
  }

  async _canUseTool(toolName, input = {}, _extra) {
    if (toolName === 'AskUserQuestion') return this._askQuestion(input);
    const variant = toolName === 'ExitPlanMode' ? 'plan' : 'tool';
    return this._askApproval(variant, toolName, input);
  }

  _askQuestion(input) {
    const { id, promise } = this.broker.ask({ event: 'DriveQuestion', sessionId: this.id }, QUESTION_HOLD_MS);
    const { title } = describeToolCall('AskUserQuestion', input);
    this.send({
      kind: 'answer',
      requestId: id,
      name: this.name,
      title,
      questions: Array.isArray(input.questions) ? input.questions : [],
    });
    return promise.then(({ action, message }) => {
      this.send({ kind: 'request-closed', requestId: id });
      return toPermissionResult('AskUserQuestion', action, message, input);
    });
  }

  _askApproval(variant, toolName, input) {
    const { id, expiresAt, promise } = this.broker.ask(
      { event: 'DriveApproval', sessionId: this.id },
      QUESTION_HOLD_MS
    );
    const { title, detail } = describeToolCall(toolName, input);
    this.send({
      kind: 'approval',
      requestId: id,
      name: this.name,
      tool: toolName,
      variant,
      noPass: true, // Drive has no terminal to fall back to
      title,
      detail,
      expiresAt,
    });
    return promise.then(({ action, message }) => {
      this.send({ kind: 'request-closed', requestId: id });
      return toPermissionResult(toolName, action, message, input);
    });
  }

  /** Resolve a pending Drive card. Returns true if it owned the request id. */
  resolve(id, action, message) {
    return this.broker.resolve(id, action, message);
  }

  extend(id, extraMs) {
    return this.broker.extend(id, extraMs);
  }

  stop() {
    this._closed = true;
    this._queue.push(null);
    const w = this._waiters.shift();
    if (w) w();
    this.broker.cancelBySession(this.id);
  }
}

module.exports = { DriveSession, toPermissionResult, normalizeMessage, QUESTION_HOLD_MS };
