'use strict';

/**
 * Chatting with the *pet*, not with the agent it watches.
 *
 * Everything else in the panel talks to the coding session: the composer types
 * into its terminal, the cards answer its hooks. This is the other thing —
 * saying hello to the buddy sitting on your screen and getting a sentence back
 * in character.
 *
 * Why not route it through the watched session? The hook API is one-shot:
 * Claude Code calls us, we answer, the exchange is over. There is no channel a
 * hook can use to start a conversation with a session that is already running,
 * so an aside typed here would land in that session's prompt as work — exactly
 * what "chat with the pet, not with the agent" is asking us not to do. Instead
 * the pet gets its own tiny Agent SDK query: no tools, no repo settings, a
 * small model, and a persona that knows who it is and which session it sits on.
 *
 * The SDK is an optional dependency (it bundles the `claude` binary), so it is
 * lazy-imported on first use and its absence is a message, not a crash — the
 * same deal Drive mode makes. Pass `runQuery` to inject a fake in tests.
 */

// How much of the conversation rides along on the next question. The pet is a
// desk companion, not a notebook: a handful of exchanges is enough to keep a
// thread, and the prompt stays small enough to stay quick.
const HISTORY_TURNS = 8;

// Small and fast on purpose. This is a one-line aside, and it is spending the
// same allowance the user's real session needs.
const PET_MODEL = 'claude-haiku-4-5-20251001';

/** Trim a value to something safe to paste into a prompt line. */
const line = (value, max = 120) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Who the pet is, in its own words. Pure — the tests read this.
 *
 * @param {object} ctx
 * @param {string} ctx.pet        the pet's name ("Noodle")
 * @param {string} ctx.character  what it is ("Fox", "Clippy")
 * @param {string} ctx.project    the folder its session runs in
 * @param {string} ctx.agent      "Claude Code" / "Codex"
 * @param {string} [ctx.model]    the model that session is spending
 * @param {string} [ctx.status]   idle / working / waiting / needs_permission
 */
function petSystemPrompt(ctx = {}) {
  const pet = line(ctx.pet, 40) || 'Buddy';
  const character = line(ctx.character, 40) || 'desk buddy';
  const project = line(ctx.project, 80) || 'a project';
  const agent = line(ctx.agent, 40) || 'a coding agent';
  const model = line(ctx.model, 60);
  const status = line(ctx.status, 40);

  return [
    `You are ${pet}, a small pixel-art ${character} who lives on the user's screen.`,
    `You sit on top of a coding session: ${agent} running in the folder "${project}"` +
      `${model ? `, on ${model}` : ''}${status ? `. That session is currently ${status}` : ''}.`,
    '',
    'You are the pet, not the agent. You do not write code, run commands, read',
    'files, or take on tasks — if the user wants work done, tell them cheerfully',
    'to say it to the session itself (the box under Expand types into its',
    'terminal). You are here for company and the occasional opinion.',
    '',
    'Speak in first person as the pet. Keep it to one or two short sentences —',
    'this lands in a speech bubble about 200 pixels wide. Warm, a bit playful,',
    'never syrupy, and never pretend to know things about the code that you have',
    'not been told above. Plain text: no markdown, no lists, no emoji spam.',
  ].join('\n');
}

/**
 * The next question, with as much of the conversation as the pet keeps. Pure.
 *
 * @param {Array<{role: string, text: string}>} history  oldest first
 * @param {string} text  what the user just said
 */
function conversationPrompt(history, text) {
  const recent = (history || []).slice(-HISTORY_TURNS * 2);
  if (!recent.length) return String(text || '');
  const said = recent
    .map((turn) => `${turn.role === 'pet' ? 'You' : 'User'}: ${String(turn.text || '').trim()}`)
    .join('\n');
  return `Earlier in this conversation:\n${said}\n\nUser: ${String(text || '')}`;
}

/** Pull the assistant's words out of whatever the SDK streamed back. Pure. */
function replyText(messages) {
  const parts = [];
  let failure = '';
  let failed = false;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (msg.type === 'assistant') {
      const blocks = msg.message?.content || msg.content || [];
      for (const b of Array.isArray(blocks) ? blocks : []) {
        if (b.type === 'text' && b.text) parts.push(b.text);
      }
    } else if (msg.type === 'result') {
      // `is_error` is the only honest signal here: a refusal to serve arrives
      // wearing the assistant's own voice — a spend limit comes back as an
      // assistant text block reading "Credit balance is too low", and the
      // result alongside it still says subtype "success". Taken at face value
      // that becomes the pet's own words, which is how a billing problem ends
      // up looking like a small animal saying something strange to you.
      if (msg.is_error === true || /error/i.test(String(msg.subtype || ''))) {
        failed = true;
        failure = failure || String(msg.result || msg.subtype || '').trim();
      } else if (!parts.length && typeof msg.result === 'string') {
        parts.push(msg.result);
      }
    }
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  // When the turn failed, whatever was "said" is the explanation, not a reply.
  if (failed) return { text: '', error: failure || text };
  return { text, error: '' };
}

class PetChat {
  /**
   * @param {object} opts
   * @param {() => object} opts.context  the pet's situation, read fresh each turn
   * @param {(queryOpts: object) => AsyncIterable} [opts.runQuery]  inject for tests
   */
  constructor({ context, runQuery = null }) {
    this.context = context;
    this._runQuery = runQuery;
    this.history = [];
    this.busy = false;
  }

  async _loadRunQuery() {
    if (this._runQuery) return this._runQuery;
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    return (opts) => mod.query(opts);
  }

  /**
   * Say something to the pet and wait for its answer.
   *
   * @returns {Promise<{text?: string, error?: string}>} never throws: the panel
   *   shows whatever comes back, and a missing SDK is a sentence, not a crash.
   */
  /**
   * Ask the pet model a question that is not conversation.
   *
   * Used for routing (src/delegate.js): the same small model, but no persona,
   * no history and nothing kept afterwards — this is a decision, not a chat,
   * and it must not leave the pet talking as if it had been asked something.
   *
   * @returns {Promise<{text?: string, error?: string}>}
   */
  async ask(prompt) {
    const question = String(prompt || '').trim();
    if (!question) return { error: 'nothing to decide' };
    if (this.busy) return { error: 'still thinking about the last one…' };
    this.busy = true;
    const messages = [];
    let thrown = null;
    try {
      const runQuery = await this._loadRunQuery();
      for await (const msg of runQuery({
        prompt: question,
        options: {
          model: PET_MODEL,
          allowedTools: [],
          settingSources: [],
          maxTurns: 1,
        },
      })) {
        messages.push(msg);
      }
    } catch (err) {
      thrown = err;
    } finally {
      this.busy = false;
    }

    // Same order as say(): what the SDK *said* went wrong beats the exit code
    // it left behind. "Credit balance is too low" is worth reading; "process
    // exited with code 1" is what that looked like before this.
    const { text, error } = replyText(messages);
    if (text) return { text };
    if (error) return { error: error.slice(0, 200) };
    return { error: String((thrown && thrown.message) || thrown || 'no answer').slice(0, 200) };
  }

  async say(text) {
    const said = String(text || '').trim();
    if (!said) return { error: 'say something first' };
    // One question at a time: the pet is a single small animal.
    if (this.busy) return { error: 'still thinking about the last one…' };
    this.busy = true;

    const ctx = (this.context && this.context()) || {};
    const messages = [];
    let thrown = null;
    try {
      const runQuery = await this._loadRunQuery();
      for await (const msg of runQuery({
        prompt: conversationPrompt(this.history, said),
        options: {
          ...(ctx.cwd ? { cwd: ctx.cwd } : {}),
          model: PET_MODEL,
          systemPrompt: petSystemPrompt(ctx),
          // A pet with tools would be an agent. It gets none, and none of the
          // repo's own settings or CLAUDE.md either — this is small talk.
          allowedTools: [],
          settingSources: [],
          maxTurns: 1,
        },
      })) {
        messages.push(msg);
      }
    } catch (err) {
      thrown = err;
    } finally {
      this.busy = false;
    }

    // The answer first, even when the stream fell over on the way out: the SDK
    // can hand over a perfectly good reply and *then* exit non-zero, and the
    // pet saying nothing because of that is a worse bug than the tidy one.
    const { text: reply, error: failed } = replyText(messages);
    if (reply) {
      this.history.push({ role: 'user', text: said }, { role: 'pet', text: reply });
      // Keep the tail only — the prompt already ignores the rest.
      if (this.history.length > HISTORY_TURNS * 2) {
        this.history = this.history.slice(-HISTORY_TURNS * 2);
      }
      return { text: reply };
    }

    // The SDK reported why there is no answer — a spend limit, a rate limit,
    // an auth problem. Say that, rather than letting it wear the pet's voice.
    if (failed) return { error: failed.slice(0, 200) };
    if (!thrown) return { error: 'the pet had nothing to say' };
    const message = String((thrown && thrown.message) || thrown);
    // The one failure worth explaining, because it has a fix.
    if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(message)) {
      return { error: 'Pet chat needs the Agent SDK: npm install @anthropic-ai/claude-agent-sdk' };
    }
    return { error: message.slice(0, 200) };
  }
}

module.exports = { PetChat, petSystemPrompt, conversationPrompt, replyText, HISTORY_TURNS, PET_MODEL };
