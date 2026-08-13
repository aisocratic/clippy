'use strict';

/**
 * Telling us how Clippy is going.
 *
 * This is the only thing Clippy ever sends anywhere that came from the user,
 * and it only happens when they open the panel, pick a thumb, write something,
 * and press send — under a line naming where it goes. There is no telemetry
 * behind it: nothing is queued, nothing is batched, and nothing goes out on
 * its own.
 *
 * It goes to the AI Socratic team's own database and no further — a private
 * message to the people who make Clippy, not a review and not a testimonial.
 *
 * What leaves the machine is exactly three things — the thumb, the words they
 * typed, and the build number. No project names, no paths, no session data, no
 * device id. `buildPayload` is the whole of it, and it is a pure function so
 * that claim is something a test can hold us to rather than a promise in a
 * README.
 */

const ENDPOINT = process.env.CLIPPY_FEEDBACK_URL || 'https://aisocratic.org/api/feedback';

// Matches the cap the route enforces, so the counter in the panel and the
// server never disagree about what fits.
const MAX_MESSAGE = 4000;
const RATINGS = ['up', 'down'];

/** How long to wait before deciding the network isn't going to answer. */
const TIMEOUT_MS = 10_000;

/**
 * What actually goes on the wire.
 *
 * Returns `{ error }` instead of throwing, because every caller here is a UI
 * that has to say something useful rather than a stack trace.
 */
function buildPayload({ rating, message = '', appVersion = '' } = {}) {
  if (!RATINGS.includes(rating)) return { error: 'Pick 👍 or 👎 first.' };

  const text = String(message).trim().slice(0, MAX_MESSAGE);
  if (!text) return { error: 'Tell us a little about it first.' };

  return {
    payload: {
      rating,
      message: text,
      appVersion: String(appVersion || ''),
      // Consent is the send itself. The panel names the destination directly
      // above the button, so pressing it is the yes — there is nothing else
      // this path could mean, and nothing reaches here without it. The field
      // stays on the wire because the route records that the words arrived
      // with permission, and a caller cannot set it to anything else.
      consentShare: true,
    },
  };
}

/** Turn whatever went wrong into something worth reading. */
function describeFailure(status, body) {
  if (status === 400 && body && body.error) return body.error;
  if (status === 429) return 'That is a lot of feedback at once — try again in a minute.';
  if (status >= 500) return "Our side is having a moment. Your words weren't sent — try again later.";
  return 'That could not be sent. Check your connection and try again.';
}

/**
 * POST the feedback.
 *
 * Deliberately called from the main process rather than the settings window:
 * a renderer doing its own networking would need the endpoint in its CSP and
 * would put the one outbound call in the least sandboxed place. Main already
 * owns every other network call Clippy makes.
 *
 * @param {object} input        see buildPayload
 * @param {object} [options]    `fetchImpl`, `endpoint` and `timeoutMs` are for tests
 */
async function sendFeedback(
  input,
  { fetchImpl = globalThis.fetch, endpoint = ENDPOINT, timeoutMs = TIMEOUT_MS } = {}
) {
  const built = buildPayload(input);
  if (built.error) return { ok: false, error: built.error };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(built.payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      return { ok: false, error: describeFailure(response.status, body) };
    }
    return { ok: true };
  } catch (err) {
    // An abort is a timeout; everything else is the network being the network.
    const offline = err && (err.name === 'AbortError' || /fetch failed|network/i.test(err.message || ''));
    return {
      ok: false,
      error: offline
        ? "Couldn't reach aisocratic.org. Your words weren't sent."
        : 'That could not be sent. Check your connection and try again.',
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { buildPayload, sendFeedback, describeFailure, ENDPOINT, MAX_MESSAGE, RATINGS };
