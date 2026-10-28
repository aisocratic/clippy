'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createHookServer } = require('../src/server');

/**
 * A request with headers `fetch` refuses to set (Host above all), which is
 * exactly what the loopback guard is about.
 */
function raw(base, { path = '/hook/Stop', method = 'POST', headers = {}, body = '' } = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    let answered = false;
    const req = http.request(
      { host: url.hostname, port: url.port, path, method, headers },
      (res) => {
        answered = true;
        let text = '';
        res.on('data', (c) => (text += c));
        const done = () => resolve({ status: res.statusCode, text });
        res.on('end', done);
        res.on('close', done);
      }
    );
    // The server may hang up while we are still writing — that is exactly what
    // refusing an oversized body looks like — and the answer it already sent is
    // the thing under test. Only a failure with no answer at all is an error.
    req.on('error', (err) => {
      if (!answered) reject(err);
    });
    req.end(body);
  });
}

async function withServer(onEvent, fn, extra = {}) {
  const server = createHookServer({
    port: 0, // ephemeral
    onEvent,
    getStatus: () => ({ hello: 'clippy' }),
    ...extra,
  });
  const addr = await server.listenOn();
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    server.close();
    // A keep-alive socket the test left idle would otherwise hold the close
    // open for the full keepAliveTimeout.
    server.closeAllConnections();
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

test('statusline answers with the handler\'s line as plain text, passing the width', async () => {
  await withServer(
    () => {},
    async (base) => {
      const res = await fetch(`${base}/statusline?cols=120`, {
        method: 'POST',
        body: JSON.stringify({ session_id: 's1' }),
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/plain/);
      assert.equal(await res.text(), 's1@120');
    },
    { onStatusline: (payload, cols) => `${payload.session_id}@${cols}` }
  );

  // No handler, or a throwing one: an empty line, so Claude Code shows nothing.
  await withServer(
    () => {},
    async (base) => {
      const bare = await fetch(`${base}/statusline`, { method: 'POST', body: 'not json' });
      assert.equal(await bare.text(), '');
    }
  );
  await withServer(
    () => {},
    async (base) => {
      const res = await fetch(`${base}/statusline`, { method: 'POST', body: '{}' });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '');
    },
    { onStatusline: () => { throw new Error('boom'); } }
  );
});

test('focus reveals the linked session and tells the browser tab so', async () => {
  const focused = [];
  await withServer(
    () => {},
    async (base) => {
      const res = await fetch(`${base}/focus?session=s%201`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /close this tab/);
    },
    { onFocus: (id) => focused.push(id) }
  );
  assert.deepEqual(focused, ['s 1']);
});

test('refuses anything a browser page sends, however it reaches the port', async () => {
  const seen = [];
  await withServer(
    (event) => seen.push(event),
    async (base) => {
      // A page on any site: cross-origin fetch, no-cors fetch and a plain form
      // POST all carry Origin, and no hook ever does.
      const forged = await raw(base, {
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: '{"session_id":"s1"}',
      });
      assert.equal(forged.status, 403);

      // Reading held state back is refused the same way.
      const peek = await raw(base, {
        path: '/status',
        method: 'GET',
        headers: { Origin: 'https://evil.example' },
      });
      assert.equal(peek.status, 403);

      // DNS rebinding: evil.example resolves to 127.0.0.1, so the page's
      // request is same-origin and carries no Origin at all — but Host still
      // names the site rather than loopback.
      const rebound = await raw(base, {
        headers: { 'Content-Type': 'application/json', Host: `evil.example:${new URL(base).port}` },
        body: '{"session_id":"s1"}',
      });
      assert.equal(rebound.status, 403);

      // A hook on this machine, dialling loopback by either name, still works.
      for (const name of ['127.0.0.1', 'localhost']) {
        const ok = await raw(base, {
          headers: { 'Content-Type': 'application/json', Host: `${name}:${new URL(base).port}` },
          body: '{"session_id":"s1"}',
        });
        assert.equal(ok.status, 200);
      }
    }
  );
  assert.deepEqual(seen, ['Stop', 'Stop']);
});

test('caps the body and says so instead of resetting the connection', async () => {
  const seen = [];
  await withServer(
    (event) => seen.push(event),
    async (base) => {
      const res = await raw(base, {
        headers: { 'Content-Type': 'application/json' },
        body: `{"big":"${'x'.repeat(2 * 1024 * 1024)}"}`,
      });
      assert.equal(res.status, 413);
    }
  );
  assert.deepEqual(seen, []); // never reached the app
});

test('decodes a body whose UTF-8 straddles a chunk boundary', async () => {
  let payload;
  await withServer(
    (_event, _kind, p) => { payload = p; },
    async (base) => {
      const url = new URL(base);
      // The emoji is written one byte at a time, so every naive per-chunk
      // toString() in the middle of it produces replacement characters.
      const text = `pre ${'—'.repeat(4)} 🎉 post`;
      const body = Buffer.from(JSON.stringify({ note: text }), 'utf8');
      await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: url.hostname,
            port: url.port,
            path: '/hook/Stop',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
          },
          (res) => {
            res.resume();
            res.on('end', resolve);
          }
        );
        req.on('error', reject);
        for (const byte of body) req.write(Buffer.from([byte]));
        req.end();
      });
      assert.equal(payload.note, text);
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
