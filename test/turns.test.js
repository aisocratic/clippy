'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { turnsFrom, lastSaid } = require('../src/transcript');

/** The reader hands buffers of JSONL, oldest first. */
const lines = (...records) => records.map((r) => Buffer.from(JSON.stringify(r)));

const claude = (extra) => ({
  type: 'assistant',
  timestamp: '2026-08-10T10:00:00Z',
  sessionId: 's1',
  ...extra,
});

const event = (payload, timestamp = '2026-08-10T10:00:00Z') => ({ type: 'event_msg', timestamp, payload });

test('one Claude response split across lines is one turn, not five', () => {
  // A text block and each tool_use get their own JSONL line, all sharing
  // message.id. Read naively, every turn would appear several times.
  const turns = turnsFrom(
    lines(
      claude({ uuid: 'a', message: { id: 'msg_1', content: [{ type: 'text', text: 'Let me look.' }] } }),
      claude({ uuid: 'b', message: { id: 'msg_1', content: [{ type: 'tool_use', name: 'Bash', id: 't1' }] } }),
      claude({ uuid: 'c', message: { id: 'msg_1', content: [{ type: 'tool_use', name: 'Read', id: 't2' }] } })
    ),
    { agent: 'claude' }
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'Let me look.');
  assert.equal(turns[0].kind, 'say');
  assert.deepEqual(turns[0].tools, ['Bash', 'Read']);
});

test('two text blocks in one response are joined, in order', () => {
  const turns = turnsFrom(
    lines(
      claude({ message: { id: 'm', content: [{ type: 'text', text: 'first' }] } }),
      claude({ message: { id: 'm', content: [{ type: 'text', text: 'second' }] } })
    ),
    { agent: 'claude' }
  );
  assert.equal(turns[0].text, 'first\nsecond');
});

test('a response that only called tools has no words to show', () => {
  const turns = turnsFrom(
    lines(claude({ message: { id: 'm', content: [{ type: 'tool_use', name: 'Bash' }] } })),
    { agent: 'claude' }
  );
  assert.equal(turns[0].kind, 'tool');
  assert.equal(turns[0].text, '');
});

test('thinking is not something to put in a speech bubble', () => {
  const turns = turnsFrom(
    lines(
      claude({
        message: {
          id: 'm',
          content: [
            { type: 'thinking', thinking: 'hmm, the user probably means…' },
            { type: 'text', text: 'Done.' },
          ],
        },
      })
    ),
    { agent: 'claude' }
  );
  assert.equal(turns[0].text, 'Done.');
});

test('what a person typed is kept; what the harness injected is not', () => {
  const turns = turnsFrom(
    lines(
      { type: 'user', promptSource: 'typed', uuid: 'u1', message: { role: 'user', content: 'add a test' } },
      { type: 'user', isMeta: true, message: { content: 'internal bookkeeping' } },
      { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'user', message: { content: '<local-command-caveat>ignore me</local-command-caveat>' } },
      // A bare tool_result carries no words at all.
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'total 240' }] } }
    ),
    { agent: 'claude' }
  );

  assert.equal(turns.length, 1);
  assert.equal(turns[0].kind, 'prompt');
  assert.equal(turns[0].text, 'add a test');
});

test('a subagent is not this session talking', () => {
  const turns = turnsFrom(
    lines(
      claude({ isSidechain: true, message: { id: 'm1', content: [{ type: 'text', text: 'subagent words' }] } }),
      claude({ message: { id: 'm2', content: [{ type: 'text', text: 'main words' }] } })
    ),
    { agent: 'claude' }
  );
  assert.deepEqual(turns.map((x) => x.text), ['main words']);
});

test('every sidecar line type a transcript carries is survived, not parsed', () => {
  // None of these have a `.message`, a `.timestamp` or a `.cwd`. Reading one
  // as a turn is how a tailer crashes on a perfectly ordinary session.
  const turns = turnsFrom(
    lines(
      { type: 'mode', mode: 'normal', sessionId: 's1' },
      { type: 'ai-title', aiTitle: 'Cute body for coding agents', sessionId: 's1' },
      { type: 'last-prompt', lastPrompt: 'hello', leafUuid: 'x', sessionId: 's1' },
      { type: 'pr-link', sessionId: 's1' },
      { type: 'file-history-delta', sessionId: 's1' },
      { type: 'file-history-snapshot', sessionId: 's1' },
      { type: 'bridge-session', sessionId: 's1', bridgeSessionId: 'cse_1' },
      { type: 'attachment', sessionId: 's1' },
      { type: 'queue-operation', sessionId: 's1' },
      { type: 'permission-mode', sessionId: 's1' },
      { type: 'agent-name', sessionId: 's1' },
      { type: 'system', subtype: 'local_command', content: '<local-command-stdout></local-command-stdout>' },
      { type: 'assistant' }, // no message at all
      { type: 'user', message: null },
      claude({ message: { id: 'm', content: [{ type: 'text', text: 'still here' }] } })
    ),
    { agent: 'claude' }
  );

  assert.deepEqual(turns.map((x) => x.text), ['still here']);
});

test('junk in the file is skipped rather than fatal', () => {
  const turns = turnsFrom(
    [Buffer.from('{"half":'), Buffer.from(''), Buffer.from('not json')].concat(
      lines(claude({ message: { id: 'm', content: [{ type: 'text', text: 'fine' }] } }))
    ),
    { agent: 'claude' }
  );
  assert.deepEqual(turns.map((x) => x.text), ['fine']);
});

/* ---------------------------------- Codex ---------------------------------- */

test("Codex's finished answer replaces the commentary it repeats", () => {
  const turns = turnsFrom(
    lines(
      event({ type: 'user_message', message: 'what port?' }),
      event({ type: 'agent_message', message: 'The port is 43117.' }),
      event({ type: 'task_complete', last_agent_message: 'The port is 43117.' })
    ),
    { agent: 'codex' }
  );

  // Otherwise every Codex turn shows its answer twice.
  assert.equal(turns.length, 2);
  assert.equal(turns[1].kind, 'final');
  assert.equal(turns[1].text, 'The port is 43117.');
});

test('a Codex answer that differs from the commentary is kept as well', () => {
  const turns = turnsFrom(
    lines(
      event({ type: 'agent_message', message: 'let me check' }),
      event({ type: 'task_complete', last_agent_message: 'It is 43117.' })
    ),
    { agent: 'codex' }
  );
  assert.deepEqual(turns.map((x) => x.kind), ['say', 'final']);
});

test('a Codex turn that never reported task_complete still has an answer', () => {
  // The newest Codex builds omit task_complete entirely, so agent_message is
  // what actually carries the words.
  const turns = turnsFrom(
    lines(
      event({ type: 'agent_message', message: 'first thought' }),
      event({ type: 'agent_reasoning', text: 'private' }),
      event({ type: 'token_count', info: {} }),
      event({ type: 'agent_message', message: 'the answer' })
    ),
    { agent: 'codex' }
  );

  assert.deepEqual(turns.map((x) => x.text), ['first thought', 'the answer']);
  assert.equal(lastSaid(turns), 'the answer');
});

test("Codex's raw model transcript is ignored in favour of its friendly events", () => {
  const turns = turnsFrom(
    lines(
      // response_item duplicates everything, and pads user turns with injected
      // context blocks that nobody typed.
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context><cwd>/x</cwd></environment_context>' }],
        },
      },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'dupe' }] } },
      { type: 'response_item', payload: { type: 'reasoning', encrypted_content: 'gAAAA' } },
      event({ type: 'agent_message', message: 'the real one' })
    ),
    { agent: 'codex' }
  );

  assert.deepEqual(turns.map((x) => x.text), ['the real one']);
});

test('an injected Codex user message is not something a person typed', () => {
  const turns = turnsFrom(
    lines(event({ type: 'user_message', message: '<environment_context>cwd</environment_context>' })),
    { agent: 'codex' }
  );
  assert.deepEqual(turns, []);
});

/* --------------------------------- lastSaid -------------------------------- */

test('the bubble takes the last thing the agent said, not the last thing that happened', () => {
  const turns = turnsFrom(
    lines(
      claude({ message: { id: 'm1', content: [{ type: 'text', text: 'the answer' }] } }),
      claude({ message: { id: 'm2', content: [{ type: 'tool_use', name: 'Bash' }] } }),
      { type: 'user', promptSource: 'typed', message: { content: 'thanks' } }
    ),
    { agent: 'claude' }
  );

  assert.equal(lastSaid(turns), 'the answer');
  assert.equal(lastSaid([]), '');
  assert.equal(lastSaid(undefined), '');
});
