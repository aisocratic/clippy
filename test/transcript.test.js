'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  encodeProjectDir,
  claudeTranscriptPath,
  findCodexRollout,
  resolveSession,
  dayDirsBetween,
  createReader,
  readTail,
  localIo,
} = require('../src/transcript');

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-resolve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const write = (file, contents) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
};

const jsonl = (...records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

const meta = (cwd, extra = {}) => ({
  timestamp: '2026-08-10T20:45:52.883Z',
  type: 'session_meta',
  payload: { session_id: 'codex-1', cwd, ...extra },
});

test('a project directory is encoded the way Claude Code names it', () => {
  assert.equal(
    encodeProjectDir('/Users/federicoulfo/projects/aisocratic/clippy'),
    '-Users-federicoulfo-projects-aisocratic-clippy'
  );
  assert.equal(encodeProjectDir('/Users/x/pro.ject_a'), '-Users-x-pro-ject-a');
  assert.equal(encodeProjectDir('/'), '-');
});

test("a Claude session we named ourselves needs no searching at all", async (t) => {
  const dir = tmp(t);
  const cwd = '/Users/me/app';
  const file = claudeTranscriptPath(dir, cwd, 'minted-uuid');
  write(file, jsonl({ type: 'user', message: { content: 'hi' } }));

  const found = await resolveSession({
    agent: 'claude',
    cwd,
    sessionId: 'minted-uuid',
    roots: { claudeProjects: dir },
  });
  assert.equal(found.path, file);
  assert.equal(found.source, 'minted');
});

test('a Claude session that has not written anything yet is simply not there', async (t) => {
  const dir = tmp(t);
  // The first minute of every spawned session: the buddy exists, the file does not.
  assert.equal(
    await resolveSession({
      agent: 'claude',
      cwd: '/Users/me/app',
      sessionId: 'not-yet',
      roots: { claudeProjects: dir },
    }),
    null
  );
  assert.equal(await resolveSession({ agent: 'claude', cwd: '/x', roots: { claudeProjects: dir } }), null);
});

test('a Codex rollout is found by the cwd on its first line', async (t) => {
  const root = tmp(t);
  const day = dayDirsBetween(Date.now(), Date.now())[0];
  const mine = write(
    path.join(root, day, 'rollout-2026-08-10T10-00-00-aaa.jsonl'),
    jsonl(meta('/Users/me/app'), { type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } })
  );
  write(path.join(root, day, 'rollout-2026-08-10T09-00-00-bbb.jsonl'), jsonl(meta('/Users/me/other')));

  const found = await findCodexRollout({ cwd: '/Users/me/app', sessionsRoot: root });
  assert.equal(found.path, mine);
  assert.equal(found.sessionId, 'codex-1');
  assert.equal(await findCodexRollout({ cwd: '/nowhere', sessionsRoot: root }), null);
});

test("Codex's own subagent threads are not the session the user is talking to", async (t) => {
  const root = tmp(t);
  const day = dayDirsBetween(Date.now(), Date.now())[0];
  const helper = path.join(root, day, 'rollout-2026-08-10T11-00-00-sub.jsonl');
  write(helper, jsonl(meta('/Users/me/app', { thread_source: 'subagent' })));
  // Newer mtime, so it would win on recency if it were eligible.
  const top = write(path.join(root, day, 'rollout-2026-08-10T10-00-00-top.jsonl'), jsonl(meta('/Users/me/app')));
  fs.utimesSync(helper, new Date(), new Date());

  const found = await findCodexRollout({ cwd: '/Users/me/app', sessionsRoot: root });
  assert.equal(found.path, top);
});

test('a rollout with no thread_source at all is a real session', async (t) => {
  const root = tmp(t);
  const day = dayDirsBetween(Date.now(), Date.now())[0];
  // Absent means top-level; only an explicit 'subagent' disqualifies.
  const file = write(
    path.join(root, day, 'rollout-2026-08-10T10-00-00-c.jsonl'),
    jsonl({ timestamp: '2026-08-10T10:00:00Z', type: 'session_meta', payload: { id: 'x', cwd: '/Users/me/app' } })
  );
  assert.equal((await findCodexRollout({ cwd: '/Users/me/app', sessionsRoot: root })).path, file);
});

test('resolving a Codex session reads line one, and only line one', async (t) => {
  const root = tmp(t);
  const day = dayDirsBetween(Date.now(), Date.now())[0];
  // Line 2 is deliberately unparseable: touching it at all would throw.
  write(
    path.join(root, day, 'rollout-2026-08-10T10-00-00-a.jsonl'),
    `${JSON.stringify(meta('/Users/me/app'))}\n{not json at all\n`
  );

  const cache = new Map();
  assert.ok(await findCodexRollout({ cwd: '/Users/me/app', sessionsRoot: root, cache }));
  assert.equal(cache.size, 1, 'and the answer is cached, because line one never changes');
});

test('a Codex rollout older than the window is never opened', async (t) => {
  const root = tmp(t);
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  const day = path.join(
    String(old.getFullYear()),
    String(old.getMonth() + 1).padStart(2, '0'),
    String(old.getDate()).padStart(2, '0')
  );
  write(path.join(root, day, 'rollout-old.jsonl'), jsonl(meta('/Users/me/app')));

  assert.equal(
    await findCodexRollout({ cwd: '/Users/me/app', sessionsRoot: root, sinceMs: Date.now() - 1000 }),
    null
  );
});

test('the day walk covers the window and stops', () => {
  const days = dayDirsBetween(Date.now() - 2 * 24 * 60 * 60 * 1000, Date.now());
  assert.ok(days.length >= 3 && days.length <= 9, `got ${days.length}`);
  assert.match(days[0], /^\d{4}\/\d{2}\/\d{2}$/);
});

/* ------------------------------- the tailing reader ------------------------------ */

const claudeSay = (id, text) =>
  JSON.stringify({
    type: 'assistant',
    uuid: `u-${id}`,
    timestamp: '2026-08-10T10:00:00Z',
    message: { id, content: [{ type: 'text', text }] },
  });

test('a reader cold-starts from the tail, then only reads what is new', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 's.jsonl');
  write(file, `${claudeSay('m1', 'first')}\n`);

  const reader = createReader({ path: file, agent: 'claude' });
  const cold = await reader.poll();
  assert.equal(cold.cold, true);
  assert.deepEqual(cold.turns.map((x) => x.text), ['first']);

  // Nothing moved: one stat, no turns, and explicitly not "changed".
  assert.deepEqual(await reader.poll(), { turns: [], changed: false });

  fs.appendFileSync(file, `${claudeSay('m2', 'second')}\n`);
  const next = await reader.poll();
  assert.deepEqual(next.turns.map((x) => x.text), ['second'], 'only the delta');
  assert.ok(!next.cold);
});

test('a reader picks up a line that arrives in two writes', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 's.jsonl');
  write(file, `${claudeSay('m1', 'first')}\n`);

  const reader = createReader({ path: file, agent: 'claude' });
  await reader.poll();

  const line = claudeSay('m2', 'split across writes');
  fs.appendFileSync(file, line.slice(0, 20));
  assert.deepEqual((await reader.poll()).turns, [], 'a half-written line is not a turn');

  fs.appendFileSync(file, `${line.slice(20)}\n`);
  assert.deepEqual(
    (await reader.poll()).turns.map((x) => x.text),
    ['split across writes']
  );
});

test('a transcript truncated under the reader is re-read, not mis-read', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 's.jsonl');
  write(file, `${claudeSay('m1', 'before')}\n${claudeSay('m2', 'more')}\n`);

  const reader = createReader({ path: file, agent: 'claude' });
  await reader.poll();
  assert.ok(reader.offset > 0);

  // A /clear rewrites the file from the top.
  fs.writeFileSync(file, `${claudeSay('m3', 'after clear')}\n`);
  const after = await reader.poll();
  assert.deepEqual(after.turns.map((x) => x.text), ['after clear']);
  assert.equal(after.cold, true, 'a shorter file means the offset is meaningless');
});

test('a transcript that disappears is reported, not thrown', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 's.jsonl');
  write(file, `${claudeSay('m1', 'x')}\n`);
  const reader = createReader({ path: file, agent: 'claude' });
  await reader.poll();

  fs.rmSync(file);
  assert.deepEqual(await reader.poll(), { turns: [], changed: false, gone: true });
});

test('a reader that falls far behind resyncs instead of catching up byte by byte', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 's.jsonl');
  write(file, `${claudeSay('m1', 'first')}\n`);

  const reader = createReader({ path: file, agent: 'claude' });
  await reader.poll();

  // Three megabytes of tool traffic, then the thing worth reading.
  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } });
  fs.appendFileSync(file, `${filler}\n`.repeat(1600));
  fs.appendFileSync(file, `${claudeSay('m9', 'the latest')}\n`);

  const caught = await reader.poll();
  assert.ok(
    caught.turns.some((x) => x.text === 'the latest'),
    'the newest turn survives the skip'
  );
  assert.equal(reader.offset, fs.statSync(file).size, 'and the reader is caught up');
});

test('readTail asks for the last few turns, not the whole file', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 's.jsonl');
  write(file, Array.from({ length: 50 }, (_, i) => claudeSay(`m${i}`, `turn ${i}`)).join('\n') + '\n');

  const turns = await readTail(file, { agent: 'claude', limit: 3 });
  assert.deepEqual(turns.map((x) => x.text), ['turn 47', 'turn 48', 'turn 49']);
});

test('readTail clips a turn that would not fit anywhere sensible', async (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 's.jsonl');
  write(file, `${claudeSay('m1', 'y'.repeat(500))}\n`);

  const [turn] = await readTail(file, { agent: 'claude', maxChars: 100 });
  assert.equal(turn.text.length, 101, 'clipped, with an ellipsis');
  assert.ok(turn.text.endsWith('…'));
});

test('localIo answers honestly about things that are not there', async () => {
  assert.equal(await localIo.stat('/nope/missing'), null);
  assert.deepEqual(await localIo.list('/nope/missing'), []);
  assert.equal((await localIo.readHead('/nope/missing', 10)).length, 0);
});
