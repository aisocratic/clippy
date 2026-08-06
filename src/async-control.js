'use strict';

/**
 * Run an asynchronous task repeatedly without ever overlapping invocations.
 * The delay starts after each invocation settles, and cancellation prevents a
 * task that is already in flight from scheduling another pass.
 */
function startCompletionPoll(task, delayMs, timers = {}) {
  const setTimer = timers.setTimeout || setTimeout;
  const clearTimer = timers.clearTimeout || clearTimeout;
  const onError = timers.onError || (() => {});
  let timer = null;
  let cancelled = false;

  const schedule = () => {
    if (cancelled) return;
    timer = setTimer(run, delayMs);
    timer?.unref?.();
  };

  const run = async () => {
    timer = null;
    try {
      await task();
    } catch (err) {
      onError(err);
    } finally {
      schedule();
    }
  };

  schedule();
  return {
    cancel() {
      cancelled = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

/**
 * Share one execution of an asynchronous loader among concurrent callers.
 * Once it settles (successfully or otherwise), the next caller starts fresh.
 */
function coalesceAsync(load) {
  let inFlight = null;
  return (...args) => {
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(() => load(...args))
        .then(
          (value) => {
            inFlight = null;
            return value;
          },
          (err) => {
            inFlight = null;
            throw err;
          }
        );
    }
    return inFlight;
  };
}

module.exports = { startCompletionPoll, coalesceAsync };
