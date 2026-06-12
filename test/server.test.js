'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createHookServer } = require('../src/server');

async function withServer(onEvent, fn) {
  const server = createHookServer({
    port: 0, // ephemeral
    onEvent,
    getStatus: () => ({ hello: 'clippy' }),
  });
  const addr = await server.listenOn();
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    server.close();
  }
}

test('receives hook events posted like the curl hook does', async () => {
  const seen = [];
  await withServer(
    (event, kind, payload) => seen.push({ event, kind, payload }),
    async (base) => {
      const res = await fetch(`${base}/hook/Notification?kind=permission_prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 's1', cwd: '/tmp/x' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    }
  );
  assert.deepEqual(seen, [
    {
      event: 'Notification',
      kind: 'permission_prompt',
      payload: { session_id: 's1', cwd: '/tmp/x' },
    },
  ]);
});

test('tolerates empty and malformed bodies', async () => {
  const seen = [];
  await withServer(
    (event, kind, payload) => seen.push({ event, kind, payload }),
    async (base) => {
      const r1 = await fetch(`${base}/hook/Stop`, { method: 'POST' });
      assert.equal(r1.status, 200);
      const r2 = await fetch(`${base}/hook/Stop`, { method: 'POST', body: 'not json{{' });
      assert.equal(r2.status, 200);
    }
  );
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].payload, {});
  assert.deepEqual(seen[1].payload, {});
});

test('serves /status and 404s everything else', async () => {
  await withServer(
    () => {},
    async (base) => {
      const ok = await fetch(`${base}/status`);
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { hello: 'clippy' });

      assert.equal((await fetch(`${base}/nope`)).status, 404);
      assert.equal((await fetch(`${base}/hook/Stop`)).status, 404); // GET not allowed
      assert.equal((await fetch(`${base}/hook/bad!name`, { method: 'POST' })).status, 404);
    }
  );
});
