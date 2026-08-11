'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { startAgentWatch, LOCAL_TIERS, REMOTE_TIERS } = require('../src/agent-watch');

/**
 * A hand-cranked clock and timer queue: the watcher's whole job is deciding
 * *when* to look, so the test has to own time rather than wait for it.
 */
function harness() {
  let clock = 0;
  const pending = new Map();
  let nextId = 1;

  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    onError() {},
  };

  return {
    timers,
    now: () => clock,
    /** Run whichever timer is due next, and move the clock to it. */
    async step(times = 1) {
      for (let i = 0; i < times; i++) {
        const due = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) return;
        const [id, entry] = due;
        pending.delete(id);
        // Never backwards: a test that advanced the clock past this timer is
        // simulating a gap, and firing must not undo it.
        clock = Math.max(clock, entry.at);
        await entry.fn();
        await Promise.resolve();
      }
    },
    advance(ms) {
      clock += ms;
    },
    get scheduled() {
      return [...pending.values()].map((e) => e.at - clock);
    },
  };
}

/** A reader whose answers the test supplies. */
function fakeReader(answers = []) {
  const calls = [];
  return {
    calls,
    queue: answers,
    async poll() {
      calls.push(true);
      const next = answers.length ? answers.shift() : { turns: [], changed: false };
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const unchanged = () => ({ turns: [], changed: false });
const said = (text) => ({ turns: [{ role: 'assistant', kind: 'say', text }], changed: true });

test('a busy transcript is watched closely', async () => {
  const h = harness();
  const reader = fakeReader([said('one'), said('two')]);
  const seen = [];

  const watch = startAgentWatch({
    reader,
    onTurns: (turns) => seen.push(...turns.map((t) => t.text)),
    timers: h.timers,
    now: h.now,
  });

  assert.equal(watch.interval, LOCAL_TIERS.active);
  await h.step(2);
  assert.deepEqual(seen, ['one', 'two']);
  assert.equal(watch.tier, 'active');
  watch.stop();
});

test('a settled transcript is asked about less and less often', async () => {
  const h = harness();
  const watch = startAgentWatch({ reader: fakeReader(), timers: h.timers, now: h.now });

  // Three unchanged polls is "the turn is over", not "one slow tool call".
  await h.step(3);
  assert.equal(watch.tier, 'idle');
  assert.equal(watch.interval, LOCAL_TIERS.idle);

  // A minute of silence means it is parked on the user.
  h.advance(70_000);
  await h.step();
  assert.equal(watch.tier, 'quiet');

  // And with the buddy hidden, there is nothing worth waking up for.
  watch.setVisible(false);
  h.advance(6 * 60_000);
  await h.step();
  assert.equal(watch.tier, 'asleep');
  assert.equal(watch.interval, LOCAL_TIERS.asleep);
  watch.stop();
});

test('anything interesting snaps the watcher back to attentive', async () => {
  const h = harness();
  const reader = fakeReader();
  const watch = startAgentWatch({ reader, timers: h.timers, now: h.now });

  await h.step(4);
  assert.notEqual(watch.tier, 'active');

  // A hook fired, or the user just sent a prompt.
  watch.poke();
  assert.equal(watch.tier, 'active');
  assert.equal(watch.interval, LOCAL_TIERS.active);

  // Settle again, then let new bytes do it instead of a poke.
  await h.step(4);
  assert.notEqual(watch.tier, 'active');
  reader.queue.push(said('back'));
  await h.step();
  assert.equal(watch.tier, 'active');

  // Showing the buddy counts too.
  await h.step(4);
  watch.setVisible(false);
  watch.setVisible(true);
  assert.equal(watch.tier, 'active');
  watch.stop();
});

test('a remote transcript is polled gently, because each look is a round trip', async () => {
  const h = harness();
  const watch = startAgentWatch({ reader: fakeReader(), remote: true, timers: h.timers, now: h.now });

  assert.equal(watch.interval, REMOTE_TIERS.active);
  await h.step(3);
  assert.equal(watch.interval, REMOTE_TIERS.idle);
  watch.stop();
});

test('an unreachable transcript backs off, and recovers on the first success', async () => {
  const h = harness();
  const reader = fakeReader([new Error('ssh: connect failed'), new Error('ssh: connect failed')]);
  const status = [];
  const watch = startAgentWatch({
    reader,
    onStatus: (s) => status.push(s.state),
    timers: h.timers,
    now: h.now,
  });

  await h.step();
  assert.equal(watch.interval, LOCAL_TIERS.active * 2);
  await h.step();
  assert.equal(watch.interval, LOCAL_TIERS.active * 4, 'doubling, not hammering');
  assert.deepEqual(status, ['unreachable', 'unreachable']);

  reader.queue.push(said('back online'));
  await h.step();
  assert.equal(status.at(-1), 'ok');
  assert.equal(watch.interval, LOCAL_TIERS.active, 'the backoff is gone, not merely smaller');
  watch.stop();
});

test('backoff is capped, however long the network stays away', async () => {
  const h = harness();
  const reader = fakeReader();
  reader.queue.push(...Array.from({ length: 12 }, () => new Error('gone')));
  const watch = startAgentWatch({ reader, remote: true, timers: h.timers, now: h.now });

  await h.step(12);
  assert.ok(watch.interval <= 60_000, `interval grew to ${watch.interval}`);
  watch.stop();
});

test('a transcript that vanished is reported, and does not stop the watch', async () => {
  const h = harness();
  const status = [];
  const watch = startAgentWatch({
    reader: fakeReader([{ turns: [], changed: false, gone: true }]),
    onStatus: (s) => status.push(s.state),
    timers: h.timers,
    now: h.now,
  });

  await h.step();
  assert.deepEqual(status, ['gone']);
  // The session may come back — a /clear writes a new file at a new path.
  assert.ok(h.scheduled.length > 0, 'still watching');
  watch.stop();
});

test('a cold start is flagged, so the renderer can tell history from news', async () => {
  const h = harness();
  const meta = [];
  const watch = startAgentWatch({
    reader: fakeReader([{ ...said('history'), cold: true }, said('news')]),
    onTurns: (_turns, m) => meta.push(m.cold),
    timers: h.timers,
    now: h.now,
  });

  await h.step(2);
  assert.deepEqual(meta, [true, false]);
  watch.stop();
});

test('a stopped watch never looks again', async () => {
  const h = harness();
  const reader = fakeReader();
  const watch = startAgentWatch({ reader, timers: h.timers, now: h.now });

  await h.step();
  const before = reader.calls.length;
  watch.stop();

  assert.deepEqual(h.scheduled, [], 'nothing left on the clock');
  await h.step(3);
  assert.equal(reader.calls.length, before);
});

test('an empty poll is not reported as something the agent said', async () => {
  const h = harness();
  let called = 0;
  const watch = startAgentWatch({
    reader: fakeReader([{ turns: [], changed: true }, unchanged()]),
    onTurns: () => (called += 1),
    timers: h.timers,
    now: h.now,
  });

  await h.step(2);
  assert.equal(called, 0);
  watch.stop();
});
