'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { buildPayload, sendFeedback, MAX_MESSAGE } = require('../src/feedback');

test('a thumb and some words are the whole of it', () => {
  const { payload } = buildPayload({
    rating: 'up',
    message: '  the perch is lovely  ',
    appVersion: '0.3.0',
  });

  // The exact shape that leaves the machine. If this list ever grows, it
  // should be because someone decided it should — not by accident.
  assert.deepEqual(Object.keys(payload).sort(), [
    'appVersion',
    'consentShare',
    'message',
    'rating',
  ]);
  assert.equal(payload.message, 'the perch is lovely');
  assert.equal(payload.rating, 'up');
  assert.equal(payload.appVersion, '0.3.0');
});

test('nothing about the machine or the work rides along', () => {
  // Everything a caller might carelessly pass through has to be dropped: a
  // project name or a path in here would be a privacy promise broken.
  const { payload } = buildPayload({
    rating: 'down',
    message: 'the buddy hid behind my terminal',
    appVersion: '0.3.0',
    cwd: '/Users/someone/secret-project',
    sessionId: 'abc-123',
    transcript: 'every word the agent said',
    email: 'someone@example.com',
  });

  const serialized = JSON.stringify(payload);
  for (const leaked of ['secret-project', 'abc-123', 'every word', 'example.com']) {
    assert.ok(!serialized.includes(leaked), `${leaked} must not be sent`);
  }
});

test('consent is the send itself, and no caller can say otherwise', () => {
  // The panel names the destination directly above the button, so pressing it
  // is the yes. What must not happen is a caller deciding that for itself in
  // either direction: the field records that the words arrived with
  // permission, and nothing but reaching here can set it.
  for (const value of [undefined, null, false, 'false', 0, {}]) {
    const built = buildPayload({ rating: 'up', message: 'hi', consentShare: value });
    assert.ok(!built.error, `${String(value)} must not block a send the user asked for`);
    assert.equal(built.payload.consentShare, true, String(value));
  }
});

test('a thumb without words, or words without a thumb, is not feedback yet', () => {
  assert.match(buildPayload({ rating: 'up', message: '   ' }).error, /about it/i);
  assert.match(buildPayload({ rating: 'sideways', message: 'hi' }).error, /👍|👎/);
  assert.match(buildPayload({ message: 'hi' }).error, /👍|👎/);
  assert.ok(!buildPayload({ rating: 'up', message: 'hi' }).error);
});

test('an essay is clipped rather than refused', () => {
  const { payload } = buildPayload({ rating: 'down', message: 'x'.repeat(MAX_MESSAGE + 500) });
  assert.equal(payload.message.length, MAX_MESSAGE);
});

test('sending posts JSON once, and says so', async () => {
  const calls = [];
  const result = await sendFeedback(
    { rating: 'up', message: 'good clip', appVersion: '0.3.0' },
    {
      endpoint: 'https://example.test/api/feedback',
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        return { ok: true, status: 201, json: async () => ({ ok: true, id: 1 }) };
      },
    }
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.test/api/feedback');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    rating: 'up',
    message: 'good clip',
    appVersion: '0.3.0',
    consentShare: true,
  });
});

test('an invalid submission never reaches the network', async () => {
  let called = false;
  const result = await sendFeedback(
    { rating: 'up', message: '' },
    {
      fetchImpl: async () => {
        called = true;
        return { ok: true, status: 201, json: async () => ({}) };
      },
    }
  );

  assert.equal(called, false);
  assert.equal(result.ok, false);
});

test('a refusal from the server is explained, not swallowed', async () => {
  const reply = (status, body) => async () => ({
    ok: false,
    status,
    json: async () => body,
  });

  const bad = await sendFeedback({ rating: 'up', message: 'hi' }, { fetchImpl: reply(400, { error: 'rating must be up or down' }) });
  assert.match(bad.error, /rating must be/);

  const busy = await sendFeedback({ rating: 'up', message: 'hi' }, { fetchImpl: reply(429, {}) });
  assert.match(busy.error, /try again/i);

  const broken = await sendFeedback({ rating: 'up', message: 'hi' }, { fetchImpl: reply(503, {}) });
  assert.match(broken.error, /weren't sent/i);
});

test('being offline says the words were not sent, rather than pretending', async () => {
  const result = await sendFeedback(
    { rating: 'down', message: 'hi' },
    {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /weren't sent/i);
});

test('a server that never answers gives up rather than hanging the window', async () => {
  const result = await sendFeedback(
    { rating: 'up', message: 'hi' },
    {
      timeoutMs: 20, // the behaviour under test is the giving up, not the waiting
      fetchImpl: async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          // Exactly what fetch does on abort.
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /Couldn't reach/i);
});
