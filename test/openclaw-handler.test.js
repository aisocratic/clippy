'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const HANDLER_PATH = path.join(__dirname, '..', 'integrations', 'openclaw', 'clippy-hook.mjs');

/**
 * The handler reads CLIPPY_PORT once at import time, so each scenario imports
 * a fresh copy (cache-busted by query string) against its own port.
 */
async function importHandler(port, tag) {
  process.env.CLIPPY_PORT = String(port);
  const mod = await import(`${pathToFileURL(HANDLER_PATH).href}?${tag}`);
  return mod.default;
}

/** Poll until `fn()` is truthy — the handler is fire-and-forget by design. */
async function waitFor(fn, ms = 2000) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for hook POST');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** An ephemeral port with nothing listening on it. */
async function deadPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('maps OpenClaw gateway events onto Clippy hook POSTs', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        type: req.headers['content-type'],
        body: body ? JSON.parse(body) : {},
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const handler = await importHandler(server.address().port, 'live');

    // Inbound user message -> UserPromptSubmit, prompt clipped to 400 chars.
    await handler({
      type: 'message',
      action: 'received',
      sessionKey: 'tg-42',
      context: { from: 'user', content: 'x'.repeat(500), workspaceDir: '/tmp/proj' },
    });
    await waitFor(() => requests.length === 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/hook/UserPromptSubmit?source=openclaw');
    assert.equal(requests[0].type, 'application/json');
    assert.deepEqual(requests[0].body, {
      session_id: 'openclaw:tg-42',
      agent: 'openclaw',
      cwd: '/tmp/proj',
      prompt: 'x'.repeat(400),
    });

    // Agent reply -> Stop. No sessionKey: falls back to the channel id, and
    // without a workspaceDir the cwd key is omitted entirely.
    await handler({
      type: 'message',
      action: 'sent',
      context: { to: 'user', content: 'done', success: true, channelId: 'chan-7' },
    });
    await waitFor(() => requests.length === 2);
    assert.equal(requests[1].url, '/hook/Stop?source=openclaw');
    assert.deepEqual(requests[1].body, { session_id: 'openclaw:chan-7', agent: 'openclaw' });

    // /stop command -> SessionEnd.
    await handler({
      type: 'command',
      action: 'stop',
      sessionKey: 'tg-42',
      context: { workspaceDir: '/tmp/proj' },
    });
    await waitFor(() => requests.length === 3);
    assert.equal(requests[2].url, '/hook/SessionEnd?source=openclaw');
    assert.deepEqual(requests[2].body, {
      session_id: 'openclaw:tg-42',
      agent: 'openclaw',
      cwd: '/tmp/proj',
    });

    // Unmapped events (other commands, gateway lifecycle) send nothing.
    await handler({ type: 'command', action: 'new', sessionKey: 'tg-42', context: {} });
    await handler({ type: 'command', action: 'reset', sessionKey: 'tg-42', context: {} });
    await handler({ type: 'gateway', action: 'shutdown' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(requests.length, 3);

    // No sessionKey and no channelId -> the shared 'main' session.
    await handler({ type: 'message', action: 'received', context: { content: 'hi' } });
    await waitFor(() => requests.length === 4);
    assert.equal(requests[3].body.session_id, 'openclaw:main');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Clippy not running never throws back into OpenClaw', async () => {
  const handler = await importHandler(await deadPort(), 'dead');

  await assert.doesNotReject(
    handler({
      type: 'message',
      action: 'received',
      sessionKey: 'x',
      context: { content: 'hello' },
    })
  );
  await assert.doesNotReject(handler({ type: 'message', action: 'sent', context: {} }));

  // Malformed events are swallowed, not thrown.
  await assert.doesNotReject(handler(null));
  await assert.doesNotReject(handler({}));

  // Give the fire-and-forget fetches a beat to fail; their rejections must be
  // handled (an unhandled rejection would fail this test file).
  await new Promise((resolve) => setTimeout(resolve, 150));
});
