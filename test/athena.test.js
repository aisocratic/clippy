'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AthenaPets, athenaConfig, petsBySession, DEFAULT_URL } = require('../src/athena');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-athena-'));

const agent = (session_id, pet, extra = {}) => ({ session_id, pet: pet && { id: pet, name: pet }, connected: true, ...extra });

const reply = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });

test('athenaConfig: off without a token', () => {
  assert.strictEqual(athenaConfig(tmpDir(), {}), null);
});

test('athenaConfig: the file, with the default URL', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'athena.json'), JSON.stringify({ token: 'tok' }));
  assert.deepStrictEqual(athenaConfig(dir, {}), { url: DEFAULT_URL, token: 'tok' });
});

test('athenaConfig: Athena’s own env names win over the file', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'athena.json'), JSON.stringify({ url: 'http://a:1', token: 'file' }));
  assert.deepStrictEqual(athenaConfig(dir, { ATHENA_URL: 'http://b:2/', ATHENA_API_TOKEN: 'env' }), {
    url: 'http://b:2',
    token: 'env',
  });
});

test('athenaConfig: a URL that is not http(s) sends the token nowhere', () => {
  assert.strictEqual(athenaConfig(tmpDir(), { ATHENA_URL: 'file:///etc', ATHENA_API_TOKEN: 't' }), null);
});

test('petsBySession: session id to pet id, skipping rows it cannot use', () => {
  const map = petsBySession({
    agents: [
      agent('s1', 'asuna'),
      agent(null, 'fox'), // a Codex pane before its first turn
      agent('s2', null), // no pet yet
      agent('s3', '../escape'), // not an id that can be a folder name
    ],
  });
  assert.deepStrictEqual([...map], [['s1', 'asuna']]);
});

test('petsBySession: a connected row wins over a gone one for the same session', () => {
  const map = petsBySession({
    agents: [agent('s1', 'new', { connected: true }), agent('s1', 'old', { connected: false })],
  });
  assert.strictEqual(map.get('s1'), 'new');
});

test('petsBySession: an odd body is no pets', () => {
  assert.strictEqual(petsBySession(null).size, 0);
  assert.strictEqual(petsBySession({ agents: 'no' }).size, 0);
});

const pets = (opts = {}) => {
  const calls = { changed: 0, installs: [], fetches: [] };
  const athena = new AthenaPets({
    config: { url: 'http://athena', token: 'tok' },
    installed: () => opts.installed || [],
    install: async (id) => {
      calls.installs.push(id);
      if (opts.installFails) throw new Error('offline');
    },
    onChange: () => calls.changed++,
    fetchImpl: async (url, init) => {
      calls.fetches.push({ url, init });
      return (opts.fetch || reply({ agents: [agent('s1', 'asuna')] }))();
    },
    log: () => {},
    now: () => opts.now || 0,
  });
  return { athena, calls };
};

test('poll: reads the fleet with the bearer token and says when pets change', async () => {
  const { athena, calls } = pets({ installed: ['asuna'] });
  await athena.poll();
  assert.strictEqual(calls.fetches[0].url, 'http://athena/api/fleet');
  assert.strictEqual(calls.fetches[0].init.headers.Authorization, 'Bearer tok');
  assert.strictEqual(calls.changed, 1);
  assert.strictEqual(athena.petFor('s1'), 'asuna');
  assert.strictEqual(athena.petFor('someone-else'), '');
  await athena.poll(); // same fleet: nothing to repaint
  assert.strictEqual(calls.changed, 1);
});

test('poll: Athena being down keeps the pets it had', async () => {
  const { athena, calls } = pets({ installed: ['asuna'] });
  await athena.poll();
  athena.fetch = reply({ error: 'Sign in to access Athena.' }, 401);
  await athena.poll();
  athena.fetch = async () => {
    throw new Error('ECONNREFUSED');
  };
  await athena.poll();
  assert.strictEqual(athena.petFor('s1'), 'asuna');
  assert.strictEqual(calls.changed, 1);
});

test('petFor: a pet not on disk yet is installed once, then announced', async () => {
  const { athena, calls } = pets();
  await athena.poll();
  assert.strictEqual(athena.petFor('s1'), ''); // usual face until it lands
  assert.strictEqual(athena.petFor('s1'), '');
  await athena.queue;
  assert.deepStrictEqual(calls.installs, ['asuna']);
  assert.strictEqual(calls.changed, 2); // the fleet, then the install
});

test('poll: installs the pets of the sessions on screen, and only those', async () => {
  const { athena, calls } = pets({
    fetch: reply({ agents: [agent('s1', 'asuna'), agent('gone', 'sphinx', { connected: false })] }),
  });
  athena.live = () => ['s1'];
  await athena.poll();
  await athena.queue;
  assert.deepStrictEqual(calls.installs, ['asuna']);
});

test('petFor: a failed install is not retried straight away', async () => {
  const opts = { installFails: true, now: 1000 };
  const { athena, calls } = pets(opts);
  await athena.poll();
  athena.petFor('s1');
  await athena.queue;
  athena.petFor('s1');
  await athena.queue;
  assert.deepStrictEqual(calls.installs, ['asuna']);
  athena.now = () => 1000 + 11 * 60_000;
  athena.petFor('s1');
  await athena.queue;
  assert.deepStrictEqual(calls.installs, ['asuna', 'asuna']);
});
