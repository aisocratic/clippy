'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { startCompletionPoll, coalesceAsync } = require('../src/async-control');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('completion poll waits until each task settles before scheduling the next', async () => {
  const scheduled = [];
  const runs = [];
  const poll = startCompletionPoll(
    () => {
      const run = deferred();
      runs.push(run);
      return run.promise;
    },
    700,
    {
      setTimeout(fn, delay) {
        scheduled.push({ fn, delay, cleared: false });
        return scheduled.at(-1);
      },
      clearTimeout(timer) {
        timer.cleared = true;
      },
    }
  );

  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 700);
  scheduled.shift().fn();
  assert.equal(runs.length, 1);
  assert.equal(scheduled.length, 0, 'no second timer while the first poll is in flight');

  runs[0].resolve();
  await flush();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 700);
  poll.cancel();
});

test('completion poll does not reschedule when cancelled in flight', async () => {
  const scheduled = [];
  const run = deferred();
  const poll = startCompletionPoll(() => run.promise, 700, {
    setTimeout(fn) {
      scheduled.push(fn);
      return fn;
    },
    clearTimeout() {},
  });

  scheduled.shift()();
  poll.cancel();
  run.resolve();
  await flush();
  assert.equal(scheduled.length, 0);
});

test('coalesceAsync shares an in-flight load and starts fresh after success', async () => {
  const loads = [];
  const refresh = coalesceAsync((value) => {
    const load = deferred();
    loads.push({ value, ...load });
    return load.promise;
  });

  const first = refresh('first');
  const second = refresh('second');
  await flush();
  assert.equal(loads.length, 1);
  assert.equal(loads[0].value, 'first');
  assert.strictEqual(first, second);

  loads[0].resolve('windows');
  assert.equal(await first, 'windows');
  const third = refresh('third');
  await flush();
  assert.equal(loads.length, 2);
  loads[1].resolve('new windows');
  assert.equal(await third, 'new windows');
});

test('coalesceAsync retries after a rejected load', async () => {
  let attempts = 0;
  const refresh = coalesceAsync(async () => {
    attempts++;
    if (attempts === 1) throw new Error('temporary failure');
    return 'recovered';
  });

  await assert.rejects(refresh(), /temporary failure/);
  assert.equal(await refresh(), 'recovered');
  assert.equal(attempts, 2);
});
