'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { server, safeJoin, isLocalRequest, DEMO_DIR } = require('../scripts/demo-web');

/* ---------------- safeJoin ---------------- */

test('safeJoin refuses every way out of the directory it is given', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-safejoin-')));
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'fine');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'also fine');

  assert.equal(safeJoin(dir, 'ok.txt'), path.join(dir, 'ok.txt'));
  assert.equal(safeJoin(dir, 'sub/deep.txt'), path.join(dir, 'sub', 'deep.txt'));

  // The URL path arrives percent-decoded, so `%2e%2e%2f` is just `../` by the
  // time it gets here — all of these have to come back null, not be filed down
  // into a path that still points somewhere else.
  for (const rel of [
    '..',
    '../secret',
    '../../etc/passwd',
    'sub/../../escape',
    '/etc/passwd',
    './../../escape',
    'a\0b',
    '',
  ]) {
    assert.equal(safeJoin(dir, rel), null, `refused: ${JSON.stringify(rel)}`);
  }

  // A sibling that merely shares the prefix is outside too.
  fs.mkdirSync(`${dir}-evil`);
  fs.writeFileSync(path.join(`${dir}-evil`, 'loot.txt'), 'nope');
  assert.equal(safeJoin(dir, `../${path.basename(dir)}-evil/loot.txt`), null);

  // A symlink resolving inside the tree is fine; one pointing out of it is not.
  fs.symlinkSync(path.join(dir, 'sub', 'deep.txt'), path.join(dir, 'inside.txt'));
  fs.symlinkSync(path.join(`${dir}-evil`, 'loot.txt'), path.join(dir, 'escape.txt'));
  assert.equal(safeJoin(dir, 'inside.txt'), path.join(dir, 'sub', 'deep.txt'));
  assert.equal(safeJoin(dir, 'escape.txt'), null);

  // Something that simply isn't there still resolves — sendFile answers 404.
  assert.equal(safeJoin(dir, 'missing.txt'), path.join(dir, 'missing.txt'));

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(`${dir}-evil`, { recursive: true, force: true });
});

/* ---------------- who is allowed to talk to the bench ---------------- */

test('only loopback Hosts and same-origin callers are answered', () => {
  const req = (headers) => ({ headers });
  assert.equal(isLocalRequest(req({ host: '127.0.0.1:43119' })), true);
  assert.equal(isLocalRequest(req({ host: 'localhost:43119' })), true);
  assert.equal(isLocalRequest(req({ host: '[::1]:43119' })), true);
  assert.equal(
    isLocalRequest(req({ host: '127.0.0.1:43119', origin: 'http://127.0.0.1:43119' })),
    true
  );

  // A name the attacker owns, pointed at 127.0.0.1: the socket is local, the
  // Host header is not — this is the DNS-rebinding shape.
  assert.equal(isLocalRequest(req({ host: 'clippy.attacker.test:43119' })), false);
  // A page somewhere else POSTing at the bench carries its own Origin.
  assert.equal(
    isLocalRequest(req({ host: '127.0.0.1:43119', origin: 'https://evil.example' })),
    false
  );
  // And a sandboxed frame's opaque origin is nobody we know.
  assert.equal(isLocalRequest(req({ host: '127.0.0.1:43119', origin: 'null' })), false);
  assert.equal(isLocalRequest(req({})), false);
});

/* ---------------- the server end to end ---------------- */

let base;

before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('the bench serves its own pages and the real renderer', async () => {
  for (const page of ['/', '/states']) {
    const res = await fetch(`${base}${page}`);
    assert.equal(res.status, 200, page);
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
  // The shared bridge both pages load has to be reachable at the path they ask
  // for, or every control on either page is dead on arrival.
  const bridge = await fetch(`${base}/bridge.js`);
  assert.equal(bridge.status, 200);
  assert.match(await bridge.text(), /ClippyBench/);
  assert.ok(fs.existsSync(path.join(DEMO_DIR, 'bridge.js')));
});

test('a traversal, a bad escape and a foreign origin are all refused', async () => {
  // Encoded traversal: the server decodes it, then has to refuse it.
  const climb = await fetch(`${base}/%2e%2e%2f%2e%2e%2fpackage.json`);
  assert.equal(climb.status, 400);
  const rendererClimb = await fetch(`${base}/renderer/..%2f..%2fpackage.json`);
  assert.equal(rendererClimb.status, 400);

  // A stray percent is not a path; decoding it throws, and that used to end the
  // process rather than the request.
  const broken = await fetch(`${base}/%`);
  assert.equal(broken.status, 400);
  assert.ok(server.listening, 'and the bench is still up');

  const foreign = await fetch(`${base}/api/scenarios`, {
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(foreign.status, 403);
});

test('/api/decision answers with the real hook response, and caps the body', async () => {
  const res = await fetch(`${base}/api/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'PermissionRequest', action: 'allow' }),
  });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).response, 'a decision comes back');

  const huge = await fetch(`${base}/api/decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'Stop', message: 'x'.repeat(2 * 1024 * 1024) }),
  });
  // Answered, not left hanging on a socket the handler destroyed underneath it.
  assert.equal(huge.status, 413);
});
