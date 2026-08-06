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

test('identifies Codex hook sources from the local callback URL', async () => {
  let source;
  await withServer(
    (_event, _kind, _payload, ctx) => { source = ctx.source; },
    async (base) => {
      await fetch(`${base}/hook/SessionStart?source=codex`, { method: 'POST', body: '{}' });
    }
  );
  assert.equal(source, 'codex');
});

test('accepts the OpenClaw source and defaults anything unknown to Claude', async () => {
  const sources = [];
  await withServer(
    (_event, _kind, _payload, ctx) => sources.push(ctx.source),
    async (base) => {
      await fetch(`${base}/hook/Stop?source=openclaw`, { method: 'POST', body: '{}' });
      await fetch(`${base}/hook/Stop?source=mystery`, { method: 'POST', body: '{}' });
      await fetch(`${base}/hook/Stop`, { method: 'POST', body: '{}' });
    }
  );
  assert.deepEqual(sources, ['openclaw', 'claude', 'claude']);
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

test('async handlers hold the response and their result becomes the body', async () => {
  let release;
  const decided = new Promise((r) => (release = r));
  await withServer(
    (event, kind, payload, ctx) => {
      assert.equal(typeof ctx.onClose, 'function');
      if (event === 'PermissionRequest') return decided;
      return undefined;
    },
    async (base) => {
      const held = fetch(`${base}/hook/PermissionRequest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 's1', tool_name: 'Bash' }),
      });

      // a fire-and-forget event is still answered immediately while the
      // interactive one is held open
      const ack = await fetch(`${base}/hook/SessionStart`, { method: 'POST', body: '{}' });
      assert.deepEqual(await ack.json(), { ok: true });

      release({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      });
      const res = await held;
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.hookSpecificOutput.decision.behavior, 'allow');
    }
  );
});

test('a rejecting handler still answers the hook', async () => {
  await withServer(
    () => Promise.reject(new Error('boom')),
    async (base) => {
      const res = await fetch(`${base}/hook/Stop`, { method: 'POST', body: '{}' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
    }
  );
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
