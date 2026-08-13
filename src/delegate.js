'use strict';

/**
 * Working out which agent a message was meant for.
 *
 * Addressing an agent has always been manual — pick a pill, or type `@name`.
 * The intent here is to say the thing ("the tests are failing on billing-api")
 * and let Clippy work out who it is for.
 *
 * Two rules shape everything below, and both are about the cost of being
 * wrong. A prompt typed into an agent's session **cannot be taken back**: it
 * becomes work, immediately, in somebody's repository. So
 *
 *   1. nothing is ever sent on a guess — the choice is proposed and the user
 *      presses send, and
 *   2. an unreachable agent is never chosen, because "sent" would be a lie.
 *
 * The routing decision is a small language question, which is what the pet
 * model is already there for. Everything in this file is pure: building the
 * question, and reading the answer strictly enough that a confused reply
 * becomes "ask the user" rather than a wrong recipient.
 */

/** Keep prompt lines short and single-line — this text comes from a chat box. */
const line = (value, max = 160) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** `/Users/me/projects/api` -> `~/projects/api`. */
const shortPath = (dir) => String(dir || '').replace(/^\/Users\/[^/]+/, '~');

/** Only agents a message could actually reach are candidates. */
const routable = (roster) =>
  (roster || []).filter((a) => a && a.sessionId && a.reachable !== false);

/**
 * The question put to the model.
 *
 * The roster is numbered rather than named, so the answer is a token that
 * cannot be half-right: "billing-api" could match two sessions in different
 * folders, but "2" is either a row or it is nothing. `none` is offered
 * explicitly and described as the safe answer, because a model given only
 * good options will pick one.
 */
function routingPrompt(roster, text) {
  const agents = routable(roster);
  const rows = agents.map((a, i) => {
    const where = a.cwd ? ` in ${shortPath(a.cwd)}` : '';
    const doing = a.status && a.status !== 'idle' ? `, currently ${a.status}` : '';
    return `${i + 1}. ${line(a.name, 60)} — ${line(a.agent || 'claude', 20)}${where}${doing}`;
  });
  return [
    'You route messages to coding agents. Here are the agents running now:',
    '',
    ...rows,
    '',
    `The user said: "${line(text, 400)}"`,
    '',
    'Which agent is it for? Answer with the number alone, or the word none.',
    'Answer none if the message is small talk, is addressed to you, names no',
    'project you can identify, or could plausibly be for more than one of them.',
    'Being unsure is not a failure — a message sent to the wrong agent becomes',
    'work in the wrong repository and cannot be taken back.',
    'After the number, add one short sentence saying why.',
  ].join('\n');
}

/**
 * Read the model's answer.
 *
 * Deliberately strict. Anything that is not plainly a row number becomes
 * `{ agent: null }`, which the caller turns into "who did you mean?" — the
 * failure that costs a question, rather than the one that costs a wrong
 * session.
 *
 * @returns {{agent: object|null, why: string}}
 */
function parseChoice(reply, roster) {
  const agents = routable(roster);
  const said = String(reply || '').trim();
  if (!said) return { agent: null, why: '' };

  // The number has to be the first thing said. A "2" fished out of the middle
  // of a sentence is as likely to be a version or a count as a choice.
  const m = /^\s*(?:#|no\.?\s*)?(\d{1,2})\b/.exec(said);
  const why = line(said.replace(/^[^a-z]*/i, ''), 140);
  if (!m) return { agent: null, why: /\bnone\b/i.test(said) ? why : '' };

  const pick = Number(m[1]);
  if (!Number.isInteger(pick) || pick < 1 || pick > agents.length) return { agent: null, why: '' };
  return { agent: agents[pick - 1], why };
}

/** What the buddy says when it has picked someone. */
const proposalText = (agent, why) =>
  `Sounds like ${agent.name}${why ? ` — ${why}` : '.'}`;

module.exports = { routingPrompt, parseChoice, routable, proposalText, shortPath };
