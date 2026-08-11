'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseProcessTable } = require('../src/terminal');
const { SpawnedSessions, buddyKeyFor, isTmuxKey, rememberProject } = require('../src/spawned');

const record = (extra = {}) => ({
  name: 'clippy-app-1',
  cwd: '/Users/me/app',
  agent: 'codex',
  paneId: '%1',
  panePid: 500,
  createdAt: 1,
  ...extra,
});

// A pane running Codex under the shell tmux started, plus an unrelated Claude
// session in the user's own terminal — the one we must never claim.
const TABLE = parseProcessTable(`
  600 500 codex
  500   1 /bin/zsh
  900 800 claude
  800 700 /bin/zsh
  700   1 /Applications/Ghostty.app/Contents/MacOS/ghostty
`);

test('a spawned session is keyed by its tmux name until a hook names it', () => {
  const spawned = new SpawnedSessions();
  const entry = spawned.add(record());

  assert.equal(buddyKeyFor(entry), 'tmux:clippy-app-1');
  assert.ok(isTmuxKey(buddyKeyFor(entry)));
  assert.ok(spawned.hasUnadopted());
  assert.equal(spawned.forKey('tmux:clippy-app-1'), entry);

  spawned.adopt('clippy-app-1', 'sess-abc');
  assert.equal(buddyKeyFor(entry), 'sess-abc');
  assert.ok(!isTmuxKey(buddyKeyFor(entry)));
  assert.ok(!spawned.hasUnadopted());
  assert.equal(spawned.forKey('sess-abc'), entry);
  assert.equal(spawned.forSession('sess-abc'), entry);
});

test('Claude is spawned already knowing its own session id', () => {
  const spawned = new SpawnedSessions();
  const entry = spawned.add(record({ agent: 'claude', sessionId: 'minted-uuid' }));

  // --session-id means there is nothing to adopt and no window of anonymity.
  assert.equal(buddyKeyFor(entry), 'minted-uuid');
  assert.ok(!spawned.hasUnadopted());
});

test("a hook is matched to the pane its process came from, and to nothing else", () => {
  const spawned = new SpawnedSessions();
  const entry = spawned.add(record());

  // codex(600) -> zsh(500), which is the pane pid we recorded.
  assert.equal(spawned.matchHookPid(600, TABLE), entry);
  // A pane whose command exec'd: the agent *is* the pane process.
  assert.equal(spawned.matchHookPid(500, TABLE), entry);
  // The user's own Claude session in Ghostty must never be claimed.
  assert.equal(spawned.matchHookPid(900, TABLE), null);
  assert.equal(spawned.matchHookPid(0, TABLE), null);
  assert.equal(spawned.matchHookPid(600, parseProcessTable('')), null);
});

test('an adopted session is no longer a candidate for the next hook', () => {
  const spawned = new SpawnedSessions();
  spawned.add(record());
  spawned.adopt('clippy-app-1', 'sess-abc');

  // Otherwise a second agent started in another pane would be handed this one.
  assert.equal(spawned.matchHookPid(600, TABLE), null);
});

test('two sessions in one folder stay distinct', () => {
  const spawned = new SpawnedSessions();
  const first = spawned.add(record());
  const second = spawned.add(record({ name: 'clippy-app-2', paneId: '%2', panePid: 700 }));

  assert.equal(spawned.matchHookPid(600, TABLE), first);
  assert.equal(spawned.matchHookPid(900, TABLE), second, 'the Ghostty chain reaches pid 700');
  assert.equal(spawned.list().length, 2);
});

test('an agent quitting hands its session back, rather than ending it', () => {
  const spawned = new SpawnedSessions();
  const entry = spawned.add(record());
  spawned.adopt('clippy-app-1', 'sess-abc');

  assert.equal(spawned.release('sess-abc'), entry);
  assert.equal(buddyKeyFor(entry), 'tmux:clippy-app-1');
  // The pane pid is unchanged, so the next agent started in it is adopted again.
  assert.equal(spawned.matchHookPid(600, TABLE), entry);
  assert.equal(spawned.release('nobody'), null);
});

test('sessions tmux no longer has are dropped, and reported', () => {
  const spawned = new SpawnedSessions();
  spawned.add(record());
  spawned.add(record({ name: 'clippy-gone-1', createdAt: 2 }));

  const removed = spawned.keep(['clippy-app-1', 'someone-elses-session']);
  assert.deepEqual(
    removed.map((r) => r.name),
    ['clippy-gone-1']
  );
  assert.deepEqual(
    spawned.list().map((r) => r.name),
    ['clippy-app-1']
  );
  assert.deepEqual(spawned.keep([]).length, 1);
  assert.deepEqual(spawned.list(), []);
});

test('the registry round-trips through settings, and ignores junk', () => {
  const spawned = new SpawnedSessions();
  spawned.add(record({ sessionId: 'sess-abc' }));

  const restored = new SpawnedSessions(JSON.parse(JSON.stringify(spawned.toJSON())));
  assert.deepEqual(restored.toJSON(), spawned.toJSON());

  const junk = new SpawnedSessions([null, {}, { cwd: '/x' }, 'nope', record()]);
  assert.deepEqual(
    junk.list().map((r) => r.name),
    ['clippy-app-1']
  );
  assert.deepEqual(new SpawnedSessions('not an array').list(), []);
  // A hand-edited agent name must not become a third kind of agent.
  assert.equal(new SpawnedSessions([record({ agent: 'evil' })]).get('clippy-app-1').agent, 'claude');
});

test('the registry is capped, oldest first out', () => {
  const spawned = new SpawnedSessions();
  for (let i = 0; i < 20; i++) spawned.add(record({ name: `clippy-s-${i}`, createdAt: i }));

  const names = spawned.list().map((r) => r.name);
  assert.equal(names.length, 16);
  assert.ok(!names.includes('clippy-s-0'), 'the oldest went');
  assert.ok(names.includes('clippy-s-19'), 'the newest stayed');
});

test('recent projects are most-recent-first, deduped by path and host', () => {
  let list = [];
  list = rememberProject(list, { path: '/a', agent: 'claude' });
  list = rememberProject(list, { path: '/b', agent: 'codex' });
  list = rememberProject(list, { path: '/a', agent: 'codex' });

  assert.deepEqual(
    list.map((p) => p.path),
    ['/a', '/b'],
    're-opening a project moves it up rather than adding a row'
  );
  assert.equal(list[0].agent, 'codex', 'and remembers how it was opened this time');

  // The same path on another machine is a different project.
  list = rememberProject(list, { path: '/a', host: 'box' });
  assert.equal(list.length, 3);

  let capped = [];
  for (let i = 0; i < 12; i++) capped = rememberProject(capped, { path: `/p${i}` });
  assert.equal(capped.length, 8);
  assert.equal(capped[0].path, '/p11');

  assert.deepEqual(rememberProject([], {}), []);
});

test('the registry is refilled in place once settings have been read', () => {
  const spawned = new SpawnedSessions();
  const held = spawned; // whatever captured it at module load must still see this

  spawned.load([record({ sessionId: 'sess-abc' })]);
  assert.equal(held.list().length, 1);
  assert.equal(held.forSession('sess-abc').name, 'clippy-app-1');

  // And loading again replaces rather than accumulates.
  spawned.load([record({ name: 'clippy-other-1' })]);
  assert.deepEqual(held.list().map((r) => r.name), ['clippy-other-1']);
});

test('what a session has been saying never reaches the settings file', () => {
  const spawned = new SpawnedSessions();
  const entry = spawned.add(record({ sessionId: 'sess-abc' }));

  // Records collect runtime company as they are used.
  entry.transcript = '/Users/me/.claude/projects/-x/abc.jsonl';
  entry.lastSay = 'a secret the user typed into their agent';
  entry.recentTurns = [{ role: 'assistant', text: 'more of it' }];

  const saved = spawned.toJSON();
  assert.deepEqual(Object.keys(saved[0]).sort(), [
    'agent', 'createdAt', 'cwd', 'host', 'name', 'paneId', 'panePid', 'remotePath', 'sessionId',
  ]);
  assert.ok(!JSON.stringify(saved).includes('secret'));
  assert.ok(!JSON.stringify(saved).includes('more of it'));
});
