'use strict';

/**
 * The storybook: every state a buddy can be in, as the events main would send.
 *
 * `npm run dev` shows one buddy with no Claude Code attached and a little
 * control window (src/renderer/dev.html) listing these; clicking one fires the
 * events below straight at that buddy. It is the browser bench's counterpart
 * for everything the browser can't do — real window placement, real sizing,
 * the real preload bridge.
 *
 * Pure data, no Electron, so a test can keep it honest: a story that loses its
 * events is a state nobody looks at until a user finds it broken. Card titles
 * come from the real describeToolCall/activityLabel so the wording here is the
 * production wording rather than a mock-up.
 */

const { describeToolCall, activityLabel } = require('./decisions');
const { PLANS, SESSION_WINDOW_MS, WEEK_WINDOW_MS } = require('./usage');

// The session key the dev buddy is created under. `dev:` is also what tells
// the usage panel to answer from canned numbers instead of a transcript.
const DEV_SESSION = 'dev:story';
const NAME = 'storybook';

/** An event as main would send it, minus the deadline stamped at fire time. */
const evt = (e) => ({ sessionId: DEV_SESSION, name: NAME, ...e });

/** A permission card, described exactly like the real PermissionRequest hook. */
function approval(requestId, toolName, toolInput, extra = {}) {
  const { title, detail } = describeToolCall(toolName, toolInput);
  return evt({
    kind: 'approval',
    status: 'needs_permission',
    requestId,
    holdSecs: 60,
    variant: toolName === 'ExitPlanMode' ? 'plan' : 'tool',
    tool: toolName,
    title,
    detail,
    ...extra,
  });
}

/** An ambient activity line, labelled by the real activityLabel(). */
function activity(toolName, toolInput, { state = 'start', ok = true } = {}) {
  return evt({
    kind: 'activity',
    status: 'working',
    activity: { tool: toolName, label: activityLabel(toolName, toolInput), state, ok },
  });
}

const PLAN = `## Add retry to the billing webhook

1. Wrap \`postInvoice()\` in an exponential backoff (3 attempts, 200ms base).
2. Treat 409 as success — the invoice already landed.
3. Log every retry with the invoice id so support can trace it.
4. Cover both paths in test/webhook.test.js.

No schema changes; the failure mode today is a silent drop.`;

const QUESTIONS = [
  {
    question: 'Where should the retry live?',
    header: 'Placement',
    multiSelect: false,
    options: [
      { label: 'In the HTTP client', description: 'Every caller gets it for free' },
      { label: 'In the webhook handler', description: 'Narrow blast radius' },
    ],
  },
  {
    question: 'Which failures should be retried?',
    header: 'Failures',
    multiSelect: true,
    options: [
      { label: '5xx responses', description: 'Server-side errors' },
      { label: 'Network timeouts', description: 'Connection reset / ETIMEDOUT' },
      { label: '429 rate limits', description: 'Respect Retry-After' },
    ],
  },
];

// Held cards get a stable id each, so the last story can close whatever is
// still on screen without knowing which one you opened.
const HELD_IDS = ['dev-approval', 'dev-plan', 'dev-answer', 'dev-review'];

const DEV_SCENARIOS = [
  {
    id: 'started',
    group: 'Ambient',
    label: 'Session started',
    hint: 'The hello: a wave and a bubble that fades on its own.',
    events: [evt({ kind: 'info', status: 'idle', message: `Now watching “${NAME}”.` })],
  },
  {
    id: 'working',
    group: 'Ambient',
    label: 'Working (activity line)',
    hint: 'A tool started — the name plate pulses and the activity line follows it.',
    events: [activity('Bash', { description: 'run the test suite', command: 'npm test' })],
  },
  {
    id: 'tool-failed',
    group: 'Ambient',
    label: 'Tool failed',
    hint: 'A failed tool turns the activity line red and the buddy starts sweating.',
    events: [
      activity(
        'Bash',
        { description: 'run the test suite', command: 'npm test' },
        { state: 'done', ok: false }
      ),
    ],
  },
  {
    id: 'nudge-urgent',
    group: 'Nudges',
    label: 'Needs you (urgent)',
    hint: 'Bouncing buddy, speech bubble, Got it / Snooze 5m.',
    events: [
      evt({
        kind: 'attention',
        urgency: 'urgent',
        status: 'needs_permission',
        message: `Claude needs permission in “${NAME}”.`,
      }),
    ],
  },
  {
    id: 'nudge-normal',
    group: 'Nudges',
    label: 'Finished (gentle)',
    hint: 'One hop, then back to bobbing.',
    events: [
      evt({
        kind: 'attention',
        urgency: 'normal',
        status: 'waiting',
        message: `Claude finished in “${NAME}” — your turn.`,
      }),
    ],
  },
  {
    id: 'approval',
    group: 'Cards',
    label: 'Approval card',
    hint: 'Allow / Deny with a reason / Ask me in terminal, countdown running.',
    events: [
      approval('dev-approval', 'Bash', {
        description: 'delete stale invoice fixtures',
        command: 'rm -rf test/fixtures/invoices/*.json',
      }),
    ],
  },
  {
    id: 'plan',
    group: 'Cards',
    label: 'Plan card',
    hint: 'ExitPlanMode: the same card relabelled Approve plan / Revise.',
    events: [approval('dev-plan', 'ExitPlanMode', { plan: PLAN })],
  },
  {
    id: 'answer',
    group: 'Cards',
    label: 'Question — answerable',
    hint: "Claude's options as buttons; two questions, one of them multi-select.",
    events: [
      evt({
        kind: 'answer',
        status: 'waiting',
        requestId: 'dev-answer',
        holdSecs: 90,
        title: describeToolCall('AskUserQuestion', { questions: QUESTIONS }).title,
        detail: describeToolCall('AskUserQuestion', { questions: QUESTIONS }).detail,
        questions: QUESTIONS,
      }),
    ],
  },
  {
    id: 'question',
    group: 'Cards',
    label: 'Question — read-only',
    hint: 'Answering is off (or the question was malformed): go answer in the terminal.',
    events: [
      evt({
        kind: 'question',
        status: 'waiting',
        title: 'Which retry strategy should the webhook use?',
        detail:
          'Which retry strategy should the webhook use?\n' +
          '  • Exponential backoff — 3 attempts, 200ms base\n' +
          '  • Fixed interval — retry every second, 5 times\n' +
          '  • No retry — fail fast and alert instead',
        message: `Claude is asking in “${NAME}” — answer in your terminal.`,
      }),
    ],
  },
  {
    id: 'review',
    group: 'Cards',
    label: 'Turn review (with recap)',
    hint: 'Looks good vs. typed feedback, over what Claude said before it stopped.',
    events: [
      evt({
        kind: 'review',
        status: 'waiting',
        requestId: 'dev-review',
        holdSecs: 30,
        message: `Claude finished in “${NAME}”. Looks good, or should it keep going?`,
        detail:
          'Added `withRetry()` around postInvoice — 3 attempts with exponential backoff, ' +
          '200ms base, and 409 treated as success.\n\n' +
          'Both paths are covered in test/webhook.test.js and the suite passes (42 tests). ' +
          'No schema changes were needed.',
      }),
    ],
  },
  {
    id: 'sticky',
    group: 'Messages',
    label: 'Sticky message (with fix)',
    hint: "Something you have to act on: it stays until you dismiss it.",
    events: [
      evt({
        kind: 'info',
        sticky: true,
        fix: 'accessibility',
        message:
          'macOS has to let me control other apps first. I opened the right pane: ' +
          'tick Clippy (Electron) under Privacy & Security → Accessibility, then try again.',
      }),
    ],
  },
  {
    id: 'quiet',
    group: 'Messages',
    label: 'Clear — back to quiet',
    hint: 'Closes whatever card is up and puts the buddy back to a bare paperclip.',
    events: [
      ...HELD_IDS.map((requestId) =>
        evt({ kind: 'request-closed', requestId, outcome: 'timeout', timedOut: true })
      ),
      evt({ kind: 'clear', status: 'idle', activity: null }),
    ],
  },
];

/**
 * Fill in the deadline a held card counts down to. Stories are static data but
 * an expiry only means something relative to when you clicked, so `holdSecs`
 * becomes an `expiresAt` here rather than in the table.
 */
function stampEvent(event, now = Date.now()) {
  if (!event.holdSecs) return { ...event };
  const { holdSecs, ...rest } = event;
  return { ...rest, expiresAt: now + holdSecs * 1000 };
}

/** The events one story fires, ready to send. */
function eventsFor(id, now = Date.now()) {
  const story = DEV_SCENARIOS.find((s) => s.id === id);
  return story ? story.events.map((e) => stampEvent(e, now)) : [];
}

/** Just enough for the control window to draw its list of buttons. */
const storyList = () =>
  DEV_SCENARIOS.map(({ id, group, label, hint }) => ({ id, group, label, hint }));

/* ---------------- Canned usage (no transcripts to read) ---------------- */

const HOUR = 60 * 60 * 1000;
const totals = (input, output, cacheRead, cacheCreate) => ({
  input,
  output,
  cacheRead,
  cacheCreate,
});
const sumTotals = (list) =>
  list.reduce(
    (into, t) => ({
      input: into.input + t.input,
      output: into.output + t.output,
      cacheRead: into.cacheRead + t.cacheRead,
      cacheCreate: into.cacheCreate + t.cacheCreate,
    }),
    totals(0, 0, 0, 0)
  );

/**
 * What the token panel shows in development mode: a busy week on a Max plan,
 * measured from *now* so the "started 4 hours ago" lines stay true whenever you
 * open it. The session's own context is kept comfortably under the stress
 * threshold, so the buddy isn't permanently sweating at you while you work.
 */
function devUsage(name = NAME) {
  const now = Date.now();
  const win = (spanMs, startedAgo, byModel, sessions = 1) => {
    const firstAt = startedAgo ? now - startedAgo : 0;
    return {
      since: now - spanMs,
      spanMs,
      firstAt,
      lastAt: firstAt ? now - 90_000 : 0,
      agesOutAt: firstAt ? firstAt + spanMs : 0,
      totals: sumTotals(Object.values(byModel)),
      byModel,
      sessions,
      truncated: false,
    };
  };

  const week = win(
    WEEK_WINDOW_MS,
    6.2 * 24 * HOUR,
    {
      'claude-opus-5': totals(700_000, 320_000, 41_000_000, 2_100_000),
      'claude-sonnet-5': totals(240_000, 120_000, 16_000_000, 800_000),
    },
    21
  );
  const weekOpus = (() => {
    const byModel = Object.fromEntries(
      Object.entries(week.byModel).filter(([model]) => /opus/i.test(model))
    );
    return { ...week, byModel, totals: sumTotals(Object.values(byModel)) };
  })();

  const plan = PLANS.find((p) => p.id === 'max20') || PLANS[0];
  return {
    name,
    now,
    session: {
      model: 'claude-opus-5',
      turns: 24,
      context: 48_000,
      contextLimit: 200_000,
      totals: totals(48_000, 31_000, 2_400_000, 180_000),
    },
    windows: {
      session: win(SESSION_WINDOW_MS, 2.6 * HOUR, {
        'claude-opus-5': totals(48_000, 31_000, 2_400_000, 180_000),
      }),
      week,
      weekOpus,
    },
    limits: plan.limits || null,
    plan: { id: plan.id, label: plan.label, estimated: Boolean(plan.estimated) },
  };
}

module.exports = {
  DEV_SESSION,
  DEV_SCENARIOS,
  stampEvent,
  eventsFor,
  storyList,
  devUsage,
};
