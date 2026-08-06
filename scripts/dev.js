'use strict';

/**
 * Tiny Electron restart loop for local development. macOS supports recursive
 * fs.watch, so keeping this dependency-free is enough for this macOS app.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RESTART_DELAY_MS = 150;

function startDevWatcher({
  root = ROOT,
  watch = fs.watch,
  spawnElectron = spawn,
  electronPath,
  restartDelayMs = RESTART_DELAY_MS,
  logger = console,
} = {}) {
  const watchers = [];
  let child = null;
  let restartTimer = null;
  let restartPending = false;
  let shuttingDown = false;
  let forceKillTimer = null;

  const closeWatchers = () => {
    while (watchers.length) watchers.pop().close();
  };

  const removeSignalHandlers = () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };

  const finish = (code) => {
    clearTimeout(restartTimer);
    clearTimeout(forceKillTimer);
    closeWatchers();
    removeSignalHandlers();
    process.exitCode = code;
  };

  const launch = () => {
    if (shuttingDown) return;
    logger.log('dev: starting Electron');
    child = spawnElectron(electronPath || require('electron'), ['.'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CLIPPY_DEV: '1' },
    });
    child.once('error', (err) => {
      logger.error(`dev: could not start Electron: ${err.message}`);
    });
    // `close` follows both a normal exit and a failed spawn, after inherited
    // stdio has closed. `exit` is not guaranteed for the latter.
    child.once('close', (code, signal) => {
      child = null;
      clearTimeout(forceKillTimer);
      forceKillTimer = null;
      if (shuttingDown) return;
      if (restartPending) {
        restartPending = false;
        launch();
        return;
      }
      if (signal) logger.error(`dev: Electron exited from ${signal}`);
      finish(code == null || code < 0 ? 1 : code);
    });
  };

  const restart = () => {
    restartTimer = null;
    if (shuttingDown) return;
    if (!child) {
      launch();
      return;
    }
    restartPending = true;
    logger.log('dev: restarting Electron');
    child.kill('SIGTERM');
  };

  const changed = (_event, filename) => {
    if (shuttingDown) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(restart, restartDelayMs);
    if (filename) logger.log(`dev: changed ${filename}`);
  };

  const addWatcher = (target, options, accepts = () => true) => {
    const watcher = watch(target, options, (event, filename) => {
      if (accepts(filename)) changed(event, filename);
    });
    watcher.on('error', (err) => {
      logger.error(`dev: watcher failed for ${path.relative(root, target)}: ${err.message}`);
      shutdown('SIGTERM');
    });
    watchers.push(watcher);
  };

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    restartPending = false;
    clearTimeout(restartTimer);
    closeWatchers();
    removeSignalHandlers();
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    if (!child) return;
    child.kill(signal);
    // Electron normally exits immediately. Do not leave it behind if it is
    // wedged while the terminal running the watcher is closing.
    forceKillTimer = setTimeout(() => child && child.kill('SIGKILL'), 3000);
    forceKillTimer.unref();
  };

  const onSigint = () => shutdown('SIGINT');
  const onSigterm = () => shutdown('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  addWatcher(path.join(root, 'src'), { recursive: true });
  // Editors commonly save package.json via atomic rename. Watching its parent
  // survives the inode replacement; direct file watches do not on macOS.
  addWatcher(root, {}, (filename) => String(filename || '') === 'package.json');
  launch();

  return { shutdown };
}

if (require.main === module) startDevWatcher();

module.exports = { startDevWatcher };
