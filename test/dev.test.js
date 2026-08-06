'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { startDevWatcher } = require('../scripts/dev');

const quiet = { log() {}, error() {} };

test('the dev watcher debounces changes, restarts, and closes with Electron', async () => {
  const watched = [];
  const children = [];

  const watch = (...args) => {
    const callback = args.at(-1);
    const watcher = new EventEmitter();
    watcher.closed = false;
    watcher.callback = callback;
    watcher.close = () => {
      watcher.closed = true;
    };
    watched.push(watcher);
    return watcher;
  };

  const spawnElectron = () => {
    const child = new EventEmitter();
    child.killedWith = [];
    child.kill = (signal) => {
      child.killedWith.push(signal);
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    };
    children.push(child);
    return child;
  };

  startDevWatcher({
    root: '/tmp/clippy-dev-watcher-test',
    watch,
    spawnElectron,
    electronPath: '/tmp/fake-electron',
    restartDelayMs: 5,
    logger: quiet,
  });

  assert.equal(children.length, 1);
  watched[0].callback('change', 'main.js');
  watched[0].callback('change', 'main.js');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(children[0].killedWith, ['SIGTERM']);
  assert.equal(children.length, 2, 'two quick changes cause one restart');

  children[1].emit('close', 0, null);
  assert.ok(watched.every((watcher) => watcher.closed));
});

test('the dev watcher forwards shutdown and closes its filesystem watchers', async () => {
  const previousExitCode = process.exitCode;
  const signalListeners = {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
  };
  const watched = [];
  const child = new EventEmitter();
  child.killedWith = [];
  child.kill = (signal) => {
    child.killedWith.push(signal);
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };

  const watch = () => {
    const watcher = new EventEmitter();
    watcher.closed = false;
    watcher.close = () => {
      watcher.closed = true;
    };
    watched.push(watcher);
    return watcher;
  };

  try {
    const dev = startDevWatcher({
      root: '/tmp/clippy-dev-shutdown-test',
      watch,
      spawnElectron: () => child,
      electronPath: '/tmp/fake-electron',
      logger: quiet,
    });
    dev.shutdown('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(child.killedWith, ['SIGINT']);
    assert.ok(watched.every((watcher) => watcher.closed));
    assert.equal(process.exitCode, 130);
    assert.equal(process.listenerCount('SIGINT'), signalListeners.SIGINT);
    assert.equal(process.listenerCount('SIGTERM'), signalListeners.SIGTERM);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('the dev watcher cleans up when Electron cannot spawn', async () => {
  const previousExitCode = process.exitCode;
  const watched = [];
  const child = new EventEmitter();
  child.kill = () => true;
  const watch = () => {
    const watcher = new EventEmitter();
    watcher.closed = false;
    watcher.close = () => {
      watcher.closed = true;
    };
    watched.push(watcher);
    return watcher;
  };

  try {
    startDevWatcher({
      root: '/tmp/clippy-dev-spawn-test',
      watch,
      spawnElectron: () => child,
      electronPath: '/tmp/missing-electron',
      logger: quiet,
    });
    child.emit('error', new Error('ENOENT'));
    child.emit('close', -2, null);
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(watched.every((watcher) => watcher.closed));
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});
