'use strict';

/**
 * Watching one spawned agent's transcript, without being a nuisance about it.
 *
 * A session Clippy started has no window to look at and, for its first minutes,
 * no hooks either — the only evidence it is alive is the file it writes. So
 * this polls. Not `fs.watch`: a watch still has to stat and read from an offset
 * (it saves the cheapest syscall in the loop), it pins an inode so it dies the
 * moment a /clear rewrites the file, and it cannot cross ssh — which the remote
 * case needs regardless. One mechanism with one set of bugs beats two.
 *
 * The cost is kept honest by backing off. A transcript that has not grown is a
 * single `stat`, and a session nobody is looking at drops to one of those a
 * minute. Anything that suggests the agent is busy again — new bytes, a hook,
 * the buddy becoming visible — snaps it straight back to attentive.
 */

const { startCompletionPoll } = require('./async-control');

// How often to look, by how interesting things are. The remote column is
// slower because each poll there is an ssh round trip, not a stat.
const LOCAL_TIERS = { active: 1500, idle: 5000, quiet: 20_000, asleep: 60_000 };
const REMOTE_TIERS = { active: 5000, idle: 20_000, quiet: 60_000, asleep: 120_000 };

// Quiet this long means it is parked on the user.
const QUIET_MS = 60_000;
// Quiet this long, with nobody looking, means stop asking so often.
const ASLEEP_MS = 5 * 60_000;
// Unchanged polls before easing off. Three, so one slow turn does not.
const SETTLED_POLLS = 3;

const MAX_BACKOFF = 8;
const MAX_INTERVAL = 60_000;

/**
 * @param {object} options
 * @param {{poll: () => Promise<object>}} options.reader     usually createReader()
 * @param {(turns: object[], meta: object) => void} [options.onTurns]
 * @param {(status: object) => void} [options.onStatus]
 * @param {boolean} [options.remote]   an ssh transcript: poll gently
 * @param {object} [options.timers]    injected for tests
 * @param {() => number} [options.now]
 */
function startAgentWatch({ reader, onTurns, onStatus, remote = false, timers = {}, now = Date.now }) {
  const tiers = remote ? REMOTE_TIERS : LOCAL_TIERS;

  let tier = 'active';
  let poll = null;
  let stopped = false;
  let unchanged = 0;
  let lastChangeAt = now();
  let visible = true;
  let failures = 0;
  let backoff = 1;

  const interval = () => Math.min(tiers[tier] * backoff, MAX_INTERVAL);

  const restart = () => {
    if (poll) poll.cancel();
    poll = null;
    if (stopped) return;
    poll = startCompletionPoll(tick, interval(), timers);
  };

  /**
   * How interesting is this session right now?
   *
   * The unchanged count is what settles the watcher, not elapsed time: any new
   * bytes reset it to zero, so "still writing" and "just wrote something" are
   * the same answer. Elapsed time only decides how far to back off afterwards.
   */
  const tierNow = () => {
    if (unchanged < SETTLED_POLLS) return 'active';
    const quietFor = now() - lastChangeAt;
    if (!visible && quietFor >= ASLEEP_MS) return 'asleep';
    return quietFor < QUIET_MS ? 'idle' : 'quiet';
  };

  const settle = () => {
    const next = tierNow();
    if (next !== tier) {
      tier = next;
      restart();
    }
  };

  async function tick() {
    let result;
    try {
      result = await reader.poll();
    } catch (err) {
      // Mostly an ssh problem. Back off on top of the tier and say so quietly —
      // a flaky connection must not turn into a buddy bouncing every 5 seconds.
      failures += 1;
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
      if (onStatus) onStatus({ state: 'unreachable', failures, message: String((err && err.message) || err) });
      restart();
      return;
    }

    if (failures) {
      failures = 0;
      backoff = 1;
      if (onStatus) onStatus({ state: 'ok' });
      // The tier is stale after a backoff; recompute against a fresh interval.
      restart();
    }

    if (result.gone) {
      unchanged += 1;
      if (onStatus) onStatus({ state: 'gone' });
    } else if (result.changed) {
      unchanged = 0;
      lastChangeAt = now();
      if (result.turns && result.turns.length && onTurns) {
        onTurns(result.turns, { cold: Boolean(result.cold) });
      }
    } else {
      unchanged += 1;
    }

    settle();
  }

  restart();

  return {
    /** Something says this session just got interesting — a hook, a sent prompt. */
    poke() {
      unchanged = 0;
      lastChangeAt = now();
      failures = 0;
      // The backoff matters as much as the tier here: a session that dropped
      // its connection and came back was sitting on an interval up to eight
      // times its tier's, and clearing that without restarting left the poke
      // waiting out the *old* sleep before it took effect.
      const wasBackedOff = backoff > 1;
      backoff = 1;
      if (tier !== 'active') tier = 'active';
      else if (!wasBackedOff) return;
      restart();
    },
    /** Nobody can see this buddy, so nothing it says is urgent. */
    setVisible(next) {
      visible = Boolean(next);
      if (visible) this.poke();
      else settle();
    },
    stop() {
      stopped = true;
      if (poll) poll.cancel();
      poll = null;
    },
    get tier() {
      return tier;
    },
    get interval() {
      return interval();
    },
  };
}

module.exports = { startAgentWatch, LOCAL_TIERS, REMOTE_TIERS, QUIET_MS, ASLEEP_MS, SETTLED_POLLS };
