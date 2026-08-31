'use strict';

/**
 * Web test bench for Clippy's UI.
 *
 * Clippy's renderer is a plain web page that only talks to the Electron main
 * process through `window.clippyAPI`. That makes it testable in a browser: this
 * server hosts the *real* `src/renderer/` (same HTML, CSS and clippy.js, no
 * copies) inside an iframe, injects a stub bridge in place of the preload, and
 * gives you a control panel that fires the same events main would.
 *
 *   npm run demo:web        # then open http://127.0.0.1:43119
 *
 * The scenarios below are built with the real `describeToolCall` /
 * `activityLabel`, and clicking a card asks the real `toHookResponse` what
 * Claude Code would have received — so the wording and the returned JSON are
 * the production ones, not mock-ups.
 *
 * This is for eyeballing states quickly. The real end-to-end test is still
 * `npm start` + `npm run mock-session` against a live Claude Code.
 *
 * Flags:
 *   --port N   listen port (default 43119 / $CLIPPY_DEMO_PORT)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { describeToolCall, activityLabel, toHookResponse } = require('../src/decisions');
const { PALETTE } = require('../src/identity');
const { allCharacters, sizeList } = require('../src/characters');
const { ACTIONS } = require('../src/actions');
const { SESSION_WINDOW_MS, WEEK_WINDOW_MS } = require('../src/usage');

const args = process.argv.slice(2);
const argv = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const PORT = Number(argv('--port', process.env.CLIPPY_DEMO_PORT || 43119));
const ROOT = path.join(__dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');
const DEMO_DIR = path.join(ROOT, 'demo');

/* ---------------- Scenarios ---------------- */

const SESSION = 'demo-session';
const NAME = 'billing-api';

/** An event as main would send it, minus the bits that are stamped at play time. */
const evt = (e) => ({ sessionId: SESSION, name: NAME, ...e });

/** A permission card, described exactly like the real PermissionRequest hook. */
function approval(toolName, toolInput, extra = {}) {
  const { title, detail } = describeToolCall(toolName, toolInput);
  return evt({
    kind: 'approval',
    status: 'needs_permission',
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

const QUESTIONS_ONE = [
  {
    question: 'Which retry strategy should the webhook use?',
    header: 'Retries',
    multiSelect: false,
    options: [
      { label: 'Exponential backoff', description: '3 attempts, 200ms base — recommended' },
      { label: 'Fixed interval', description: 'Retry every second, 5 times' },
      { label: 'No retry', description: 'Fail fast and alert instead' },
    ],
  },
];

const QUESTIONS_MANY = [
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
      { label: '4xx responses', description: 'Usually a bug, not worth retrying' },
    ],
  },
];

/**
 * The show run: press play and Clippy walks through everything he can do,
 * hands-off, narrated step by step.
 *
 * This is the demo *and* the manual test. **When a feature is added, add it
 * here** — a state that isn't in the show run is a state nobody looks at until
 * a user finds it broken.
 *
 * Steps can carry a `note` (the caption above the stage), an `event` (what main
 * would send) and an `action` the panel performs itself — `usage` /
 * `usage-close` open and close the token panel the way clicking the buddy does,
 * `set` changes a setting.
 */
function SHOW_RUN() {
  const s = [];
  const at = (delay, step) => s.push({ delay, ...step });

  at(0, { note: 'Idle — hidden until this session actually wants you', event: evt({ kind: 'activity', status: 'idle', activity: null }) });

  at(1400, { note: 'Working — the activity line follows each tool', event: activity('Read', { file_path: '/repo/src/webhook.js' }) });
  at(1300, { event: activity('Grep', { pattern: 'postInvoice' }) });
  at(1300, { event: activity('Edit', { file_path: '/repo/src/webhook.js' }) });
  at(1300, { event: activity('Bash', { description: 'run the test suite', command: 'npm test' }) });
  at(1600, {
    note: 'A failed tool turns the line red — and the buddy starts sweating',
    event: activity('Bash', { description: 'run the test suite', command: 'npm test' }, { state: 'done', ok: false }),
  });

  at(1800, {
    note: 'Urgent nudge — bouncing buddy, speech bubble, Got it / Snooze',
    event: evt({ kind: 'attention', urgency: 'urgent', status: 'needs_permission', message: `Claude needs permission in “${NAME}”.` }),
  });

  at(3000, {
    note: 'Approval card — Allow, Deny with a reason, or hand it to the terminal',
    ref: 'perm',
    holdSecs: 22,
    event: approval('Bash', { description: 'delete stale invoice fixtures', command: 'rm -rf test/fixtures/invoices/*.json' }),
  });
  at(7000, { ref: 'perm', event: evt({ kind: 'request-closed', outcome: 'timeout', timedOut: true }) });

  at(700, {
    note: 'Plan card — the same card, relabelled Approve plan / Revise',
    ref: 'plan',
    holdSecs: 22,
    event: approval('ExitPlanMode', { plan: PLAN }),
  });
  at(7000, { ref: 'plan', event: evt({ kind: 'request-closed', outcome: 'timeout', timedOut: true }) });

  at(700, {
    note: "Question card — Claude's options as buttons, answered from here",
    ref: 'ask',
    holdSecs: 26,
    event: evt({
      kind: 'answer',
      status: 'waiting',
      title: describeToolCall('AskUserQuestion', { questions: QUESTIONS_MANY }).title,
      questions: QUESTIONS_MANY,
    }),
  });
  at(8000, { ref: 'ask', event: evt({ kind: 'request-closed', outcome: 'timeout', timedOut: true }) });

  at(700, {
    note: 'Answering off — the question is read-only, with a way to the terminal',
    event: evt({
      kind: 'question',
      status: 'waiting',
      title: 'Which retry strategy should the webhook use?',
      detail: 'Which retry strategy should the webhook use?\n  • Exponential backoff — 3 attempts, 200ms base\n  • Fixed interval — retry every second, 5 times\n  • No retry — fail fast and alert instead',
      message: `Claude is asking in “${NAME}” — answer in your terminal.`,
    }),
  });

  at(4500, {
    note: 'Review card — Looks good, or send Claude back with feedback',
    ref: 'stop',
    holdSecs: 20,
    event: evt({ kind: 'review', status: 'waiting', message: 'Claude finished: “Added retry with backoff to the billing webhook — 42 tests pass.”' }),
  });
  at(6500, { ref: 'stop', event: evt({ kind: 'request-closed', outcome: 'timeout', timedOut: true }) });

  at(700, {
    note: "Something you have to act on — it stays until you dismiss it",
    event: evt({
      kind: 'info',
      sticky: true,
      fix: 'accessibility',
      message:
        'macOS has to let me control other apps first. I opened the right pane: ' +
        'tick Clippy (Electron) under Privacy & Security → Accessibility, then try again.',
    }),
  });
  at(5000, { action: { do: 'poke-menu', item: 'btn-ok' } });

  at(700, {
    note: 'Click the buddy: one panel — status, token usage, and a box to reply in',
    action: { do: 'usage' },
  });
  at(4500, { action: { do: 'usage-close' } });

  // Perched on the session's own window, Clippy walks down to the input line
  // and points at it whenever the answer has to be typed there.
  at(600, { note: 'Perched on the terminal window', action: { do: 'dock', value: true } });
  at(1600, {
    note: '“Answer here” — he walks to the prompt and points at it',
    action: { do: 'walk-to-prompt' },
  });
  at(7000, { action: { do: 'dock', value: false } });

  // The cast, shown while a nudge has him bouncing, so it's the excited
  // animation you see rather than the calm one.
  at(400, {
    note: 'Meet the cast — every character, mid-bounce',
    event: evt({ kind: 'attention', urgency: 'urgent', status: 'waiting', message: 'Meet the cast!' }),
  });
  for (const c of allCharacters()) {
    at(1900, { note: `Character: ${c.label}`, action: { do: 'set', key: 'character', value: c.id } });
  }
  at(1900, { note: 'One size, always — and it sticks', action: { do: 'set', key: 'size', value: 'large' } });
  at(1800, { action: { do: 'set', key: 'size', value: 'small' } });
  at(1800, { action: { do: 'set', key: 'size', value: 'medium' } });
  at(1200, { action: { do: 'set', key: 'character', value: 'clip' } });

  at(600, { note: 'Drive mode — a session Clippy runs itself', event: evt({ kind: 'drive-open', cwd: '/Users/you/projects/billing-api' }) });
  at(600, { event: evt({ kind: 'drive-transcript', role: 'user', text: 'add retries to the billing webhook' }) });
  at(900, { event: evt({ kind: 'drive-activity', label: 'Reading src/webhook.js' }) });
  at(1600, { event: evt({ kind: 'drive-activity', label: 'Editing src/webhook.js' }) });
  at(1800, { event: evt({ kind: 'drive-transcript', role: 'assistant', text: 'Added withRetry() around postInvoice — 3 attempts, 409 treated as success. Tests pass.' }) });
  at(500, { event: evt({ kind: 'drive-status', status: 'turn-done' }) });
  at(2500, { event: evt({ kind: 'drive-close' }) });

  at(600, {
    note: 'Finished — nothing left to do, so he curls up',
    event: evt({ kind: 'activity', status: 'waiting', activity: null }),
  });
  at(3200, { note: 'Answered and quiet again — back to a bare buddy', event: evt({ kind: 'remove', status: 'idle' }) });
  return s;
}

/**
 * Each scenario is a little timeline. `holdSecs` turns an entry into a held
 * request (the panel stamps a fresh requestId and deadline at play time);
 * `ref` lets a later entry — a request-closed, say — point at an earlier one.
 */
const SCENARIOS = [
  /* --- what Clippy looks like between cards --- */
  {
    id: 'idle',
    group: 'Ambient',
    label: 'Idle',
    hint: 'Waiting for a prompt: bare buddy, no badge, nothing to read.',
    steps: [{ event: evt({ kind: 'activity', status: 'idle', activity: null }) }],
  },
  {
    id: 'working',
    group: 'Ambient',
    label: 'Working (activity line)',
    hint: 'A tool started — the name plate pulses and the activity line shows it.',
    steps: [{ event: activity('Bash', { description: 'run the test suite', command: 'npm test' }) }],
  },
  {
    id: 'activity-stream',
    group: 'Ambient',
    label: 'Activity stream',
    hint: 'Several tools in a row, ending in a done tick.',
    steps: [
      { event: activity('Read', { file_path: '/repo/src/webhook.js' }) },
      { delay: 1200, event: activity('Edit', { file_path: '/repo/src/webhook.js' }) },
      {
        delay: 1200,
        event: activity('Bash', { description: 'run the test suite', command: 'npm test' }),
      },
      {
        delay: 1600,
        event: activity(
          'Bash',
          { description: 'run the test suite', command: 'npm test' },
          { state: 'done' }
        ),
      },
    ],
  },
  {
    id: 'activity-failed',
    group: 'Ambient',
    label: 'Tool failed',
    hint: 'A failed tool turns the activity line red.',
    steps: [
      {
        event: activity(
          'Bash',
          { description: 'run the test suite', command: 'npm test' },
          { state: 'done', ok: false }
        ),
      },
    ],
  },

  /* --- passive nudges --- */
  {
    id: 'attention-urgent',
    group: 'Nudges',
    label: 'Needs you (urgent)',
    hint: 'Bouncing buddy + speech bubble. Got it / Snooze 5m.',
    steps: [
      {
        event: evt({
          kind: 'attention',
          urgency: 'urgent',
          status: 'needs_permission',
          message: `Claude needs permission in “${NAME}”.`,
        }),
      },
    ],
  },
  {
    id: 'attention-normal',
    group: 'Nudges',
    label: 'Finished (normal)',
    hint: 'Gentler nudge: one hop, then back to bobbing.',
    steps: [
      {
        event: evt({
          kind: 'attention',
          urgency: 'normal',
          status: 'waiting',
          message: `Claude finished in “${NAME}” — your turn.`,
        }),
      },
    ],
  },
  {
    id: 'info',
    group: 'Nudges',
    label: 'Info bubble (auto-hides)',
    hint: 'Transient message; disappears after 4s on its own.',
    steps: [{ event: evt({ kind: 'info', message: 'Watching 2 sessions.' }) }],
  },
  {
    id: 'clear',
    group: 'Nudges',
    label: 'Cleared (you typed)',
    hint: 'The user answered in the terminal — bubble goes away, work resumes.',
    steps: [
      {
        event: evt({
          kind: 'clear',
          status: 'working',
          activity: { tool: null, label: 'Working…', state: 'start', ok: true },
        }),
      },
    ],
  },

  /* --- held cards --- */
  {
    id: 'approval-bash',
    group: 'Cards',
    label: 'Approval — Bash',
    hint: 'Allow / Deny / Ask me in terminal, with the countdown bar running.',
    steps: [
      {
        holdSecs: 60,
        event: approval('Bash', {
          description: 'delete stale invoice fixtures',
          command: 'rm -rf test/fixtures/invoices/*.json',
        }),
      },
    ],
  },
  {
    id: 'approval-edit',
    group: 'Cards',
    label: 'Approval — Edit (long detail)',
    hint: 'Checks that a long diff scrolls inside the card.',
    steps: [
      {
        holdSecs: 60,
        event: approval('Edit', {
          file_path: '/Users/you/projects/billing-api/src/webhook.js',
          old_string: 'const res = await postInvoice(payload);\nif (!res.ok) throw new Error("failed");',
          new_string:
            'const res = await withRetry(() => postInvoice(payload), {\n  attempts: 3,\n  baseMs: 200,\n  retryOn: (r) => r.status >= 500 || r.status === 429,\n});\nif (!res.ok && res.status !== 409) throw new Error("failed");',
        }),
      },
    ],
  },
  {
    id: 'approval-plan',
    group: 'Cards',
    label: 'Plan review',
    hint: 'ExitPlanMode: the same card relabelled Approve plan / Revise.',
    steps: [{ holdSecs: 60, event: approval('ExitPlanMode', { plan: PLAN }) }],
  },
  {
    id: 'approval-tall',
    group: 'Cards',
    label: 'Tallest card (window growth)',
    hint: 'A long title, a full detail box and a queue — the case that used to get cut off.',
    steps: [
      {
        holdSecs: 90,
        event: approval('Bash', {
          description:
            'rebuild every fixture, re-run the migration and re-seed the staging database from the invoice snapshots',
          command:
            'npm run fixtures:rebuild -- --all && \\\n  npm run migrate -- --to latest --yes && \\\n  npm run seed -- --from snapshots/invoices-2026-07.json --truncate --verbose',
        }),
      },
      {
        delay: 400,
        holdSecs: 90,
        event: approval('Bash', { description: 'push the branch', command: 'git push -u origin main' }),
      },
    ],
  },
  {
    id: 'review',
    group: 'Cards',
    label: 'Turn review (Stop)',
    hint: 'Looks good vs. typed feedback that sends Claude back to work.',
    steps: [
      {
        holdSecs: 30,
        event: evt({
          kind: 'review',
          status: 'waiting',
          message: 'Claude finished: “Added retry with backoff to the billing webhook — 42 tests pass.”',
        }),
      },
    ],
  },
  {
    id: 'answer-one',
    group: 'Cards',
    label: 'Question — single choice',
    hint: 'AskUserQuestion answered from Clippy; Submit feeds it straight back.',
    steps: [
      {
        holdSecs: 90,
        event: evt({
          kind: 'answer',
          status: 'waiting',
          title: describeToolCall('AskUserQuestion', { questions: QUESTIONS_ONE }).title,
          questions: QUESTIONS_ONE,
        }),
      },
    ],
  },
  {
    id: 'answer-many',
    group: 'Cards',
    label: 'Question — multi-select',
    hint: 'Two questions, one multi-select. Submit stays disabled until both are answered.',
    steps: [
      {
        holdSecs: 90,
        event: evt({
          kind: 'answer',
          status: 'waiting',
          title: describeToolCall('AskUserQuestion', { questions: QUESTIONS_MANY }).title,
          questions: QUESTIONS_MANY,
        }),
      },
    ],
  },
  {
    id: 'question-readonly',
    group: 'Cards',
    label: 'Question — read-only',
    hint: 'Answering is off (or the question was malformed): go answer in the terminal.',
    steps: [
      {
        event: evt({
          kind: 'question',
          status: 'waiting',
          title: 'Which retry strategy should the webhook use?',
          detail:
            'Which retry strategy should the webhook use?\n  • Exponential backoff — 3 attempts, 200ms base\n  • Fixed interval — retry every second, 5 times\n  • No retry — fail fast and alert instead',
          message: `Claude is asking in “${NAME}” — answer in your terminal.`,
        }),
      },
    ],
  },
  {
    id: 'queue',
    group: 'Cards',
    label: 'Queue — 3 stacked',
    hint: 'Three held requests at once: the head shows "+2 more" and they pop in order.',
    steps: [
      {
        holdSecs: 90,
        event: approval('Bash', { description: 'install dependencies', command: 'npm ci' }),
      },
      {
        delay: 400,
        holdSecs: 90,
        event: approval('Write', {
          file_path: '/Users/you/projects/billing-api/src/retry.js',
          content: 'export async function withRetry(fn, { attempts = 3, baseMs = 200 } = {}) {\n  …\n}',
        }),
      },
      { delay: 400, holdSecs: 90, event: approval('ExitPlanMode', { plan: PLAN }) },
    ],
  },
  {
    id: 'expiring',
    group: 'Cards',
    label: 'Card about to expire (6s)',
    hint: 'Short hold: watch the countdown drain, then main closes it.',
    steps: [
      {
        ref: 'a',
        holdSecs: 6,
        event: approval('Bash', { description: 'push the branch', command: 'git push -u origin main' }),
      },
      {
        delay: 6200,
        ref: 'a',
        event: evt({ kind: 'request-closed', outcome: 'timeout', timedOut: true }),
      },
    ],
  },

  /* --- Drive mode --- */
  {
    id: 'drive',
    group: 'Drive mode',
    label: 'Drive — full turn',
    hint: 'Clippy-driven SDK session: prompt, activity, streamed reply.',
    steps: [
      { event: evt({ kind: 'drive-open', cwd: '/Users/you/projects/billing-api' }) },
      { delay: 300, event: evt({ kind: 'drive-transcript', role: 'user', text: 'add retries to the billing webhook' }) },
      { delay: 600, event: evt({ kind: 'drive-activity', label: 'Reading src/webhook.js' }) },
      { delay: 1400, event: evt({ kind: 'drive-activity', label: 'Editing src/webhook.js' }) },
      {
        delay: 1800,
        event: evt({
          kind: 'drive-transcript',
          role: 'assistant',
          text: 'Added withRetry() around postInvoice — 3 attempts with exponential backoff, 409 treated as success. Tests pass.',
        }),
      },
      { delay: 400, event: evt({ kind: 'drive-status', status: 'turn-done' }) },
    ],
  },
  {
    id: 'drive-answer',
    group: 'Drive mode',
    label: 'Drive — question (no terminal)',
    hint: 'In Drive mode there is no terminal to punt to, so "Ask me in terminal" is gone.',
    steps: [
      { event: evt({ kind: 'drive-open', cwd: '/Users/you/projects/billing-api' }) },
      {
        delay: 300,
        holdSecs: 90,
        event: evt({
          kind: 'answer',
          noPass: true,
          status: 'waiting',
          title: describeToolCall('AskUserQuestion', { questions: QUESTIONS_ONE }).title,
          questions: QUESTIONS_ONE,
        }),
      },
    ],
  },
  {
    id: 'drive-error',
    group: 'Drive mode',
    label: 'Drive — error & end',
    hint: 'What a failed or finished driven session looks like.',
    steps: [
      { event: evt({ kind: 'drive-open', cwd: '/Users/you/projects/billing-api' }) },
      {
        delay: 300,
        event: evt({ kind: 'drive-status', status: 'error', message: 'Agent SDK not installed' }),
      },
      { delay: 900, event: evt({ kind: 'drive-status', status: 'ended' }) },
    ],
  },
  {
    id: 'drive-close',
    group: 'Drive mode',
    label: 'Drive — close panel',
    steps: [{ event: evt({ kind: 'drive-close' }) }],
  },

  /* --- the whole arc, hands-off --- */
  {
    id: 'story',
    group: 'Show run',
    label: '▶ Show run — the whole feature set',
    hint:
      'Hands-off tour: idle → thinking → approval → work → question → review, ' +
      'with the bubbles, the panels and both animations along the way. ' +
      'Add every new feature to this run.',
    showRun: true,
    steps: SHOW_RUN(),
  },
];

/* ---------------- Fake usage payloads (clippyAPI.usage) ---------------- */

const totals = (input, output, cacheRead, cacheCreate) => ({
  input,
  output,
  cacheRead,
  cacheCreate,
});

const HOUR = 60 * 60 * 1000;
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
 * The usage payloads, built fresh on every request.
 *
 * The panel says when each window's spend starts, so these can't be a frozen
 * constant: a window that started three hours ago has to still have started
 * three hours ago whenever you open the bench.
 */
function usagePayloads() {
  const now = Date.now();

  /** One window of spend, as main's sweep would report it. */
  const win = (spanMs, startedAgo, byModel, { sessions = 1, truncated = false } = {}) => {
    const models = Object.entries(byModel);
    const firstAt = startedAgo ? now - startedAgo : 0;
    return {
      since: now - spanMs,
      spanMs,
      firstAt,
      lastAt: firstAt ? now - 90_000 : 0,
      agesOutAt: firstAt ? firstAt + spanMs : 0,
      totals: sumTotals(models.map(([, t]) => t)),
      byModel,
      sessions,
      truncated,
    };
  };

  const opusOnly = (week) => {
    const byModel = Object.fromEntries(
      Object.entries(week.byModel).filter(([model]) => /opus/i.test(model))
    );
    return { ...week, byModel, totals: sumTotals(Object.values(byModel)) };
  };

  /** A payload is a session and the three windows — allowances only ever come
      from Claude Code's own /usage cache (the `official` block), never settings.
      `codexWeek` is the GPT share main reads from ~/.codex rollouts, so the
      bench shows the Codex row wherever a machine with Codex on it would. */
  const payload = (session, block, week, codexWeek = null) => ({
    name: NAME,
    now,
    session,
    windows: { session: block, week, weekOpus: opusOnly(week) },
    codexWeek,
  });

  const busyWeek = win(
    WEEK_WINDOW_MS,
    6.2 * 24 * HOUR,
    {
      'claude-opus-5': totals(700_000, 320_000, 41_000_000, 2_100_000),
      'claude-sonnet-5': totals(240_000, 120_000, 16_000_000, 800_000),
      'claude-haiku-4-5-20251001': totals(80_000, 40_000, 4_000_000, 200_000),
    },
    { sessions: 21 }
  );

  const heavyWeek = win(
    WEEK_WINDOW_MS,
    6.9 * 24 * HOUR,
    {
      'claude-opus-5[1m]': totals(2_900_000, 1_600_000, 180_000_000, 10_000_000),
      'claude-sonnet-5': totals(500_000, 300_000, 30_000_000, 2_000_000),
    },
    { sessions: 44, truncated: true }
  );

  return {
    // Nothing has been written yet: no bar may claim to know anything.
    empty: payload(
      { model: '', turns: 0, context: 0, contextLimit: 200_000, totals: totals(0, 0, 0, 0) },
      win(SESSION_WINDOW_MS, 0, {}, { sessions: 0 }),
      win(WEEK_WINDOW_MS, 0, {}, { sessions: 0 })
    ),

    // Ten minutes into a new session, on a quiet week.
    fresh: payload(
      {
        model: 'claude-sonnet-5',
        turns: 3,
        context: 24_000,
        contextLimit: 200_000,
        totals: totals(6_000, 4_000, 180_000, 22_000),
      },
      win(SESSION_WINDOW_MS, 12 * 60 * 1000, {
        'claude-sonnet-5': totals(6_000, 4_000, 180_000, 22_000),
      }),
      win(
        WEEK_WINDOW_MS,
        2 * 24 * HOUR,
        { 'claude-sonnet-5': totals(120_000, 60_000, 3_400_000, 210_000) },
        { sessions: 3 }
      )
    ),

    // A long session with the context nearly full — the bar that matters most.
    context: payload(
      {
        model: 'claude-opus-5',
        turns: 118,
        context: 188_000,
        contextLimit: 200_000,
        totals: totals(310_000, 205_000, 24_000_000, 1_400_000),
      },
      win(SESSION_WINDOW_MS, 4.1 * HOUR, {
        'claude-opus-5': totals(310_000, 205_000, 24_000_000, 1_400_000),
      }),
      busyWeek
    ),

    // Plenty of spend, nobody has said what the allowance is: shares of the week.
    // This machine also ran Codex, so the panel carries the GPT week too.
    noplan: payload(
      {
        model: 'claude-opus-5',
        turns: 24,
        context: 61_000,
        contextLimit: 200_000,
        totals: totals(48_000, 31_000, 2_400_000, 180_000),
      },
      win(SESSION_WINDOW_MS, 2.6 * HOUR, {
        'claude-opus-5': totals(48_000, 31_000, 2_400_000, 180_000),
      }),
      busyWeek,
      win(
        WEEK_WINDOW_MS,
        3.8 * 24 * HOUR,
        {
          'gpt-5.3-codex': totals(240_000, 130_000, 9_000_000, 0),
          'gpt-5.3-codex-mini': totals(40_000, 18_000, 900_000, 0),
        },
        { sessions: 4 }
      )
    ),

    // A heavy week on the big context window — the shares run hot.
    spent: payload(
      {
        model: 'claude-opus-5[1m]',
        turns: 96,
        context: 402_000,
        contextLimit: 1_000_000,
        totals: totals(310_000, 205_000, 24_000_000, 1_400_000),
      },
      win(SESSION_WINDOW_MS, 3.4 * HOUR, {
        'claude-opus-5[1m]': totals(1_100_000, 700_000, 88_000_000, 4_000_000),
      }),
      heavyWeek
    ),
  };
}

/* ---------------- Static file serving ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendFile(res, file) {
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
}

function sendJson(res, data, code = 200) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(body);
}

/**
 * A real page from `src/renderer/`, with its Electron bridge swapped for the
 * matching browser stub. Serving it rather than copying it is the whole point:
 * what you click in the browser is the same markup Electron loads.
 */
function servePage(res, page, script, stub) {
  fs.readFile(path.join(RENDERER_DIR, page), 'utf8', (err, html) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`cannot read ${page}`);
      return;
    }
    const tag = `<script src="${script}"></script>`;
    const patched = html.replace(tag, `<script src="${stub}"></script>\n  ${tag}`);
    if (patched === html) console.warn(`⚠ no ${script} script tag in ${page} — did it change?`);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
    res.end(patched);
  });
}

/** Keep requests inside a directory, whatever ../.. the URL tries. */
function safeJoin(dir, rel) {
  const target = path.join(dir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  return target.startsWith(dir) ? target : null;
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/api/scenarios') {
    return sendJson(res, {
      scenarios: SCENARIOS,
      usage: usagePayloads(),
      palette: PALETTE,
      characters: allCharacters(),
      sizes: sizeList(),
      actions: ACTIONS,
    });
  }

  // What Claude Code would actually have received for the button you clicked.
  if (pathname === '/api/decision' && req.method === 'POST') {
    const { event, action, message, toolInput } = await readBody(req);
    return sendJson(res, {
      response: toHookResponse(String(event || ''), String(action || ''), String(message || ''), {
        toolInput,
      }),
    });
  }

  // The settings window, with its own bridge stubbed the same way.
  if (pathname === '/api/settings-state') {
    return sendJson(res, {
      approvals: true,
      reviewOnStop: true,
      answerQuestions: true,
      autoPerch: true,
      appearanceSound: 'pop',
      characterByProject: {},
      sizeByProject: {},
      characterBySession: {},
      sizeBySession: {},
      size: 'medium',
      characters: allCharacters(),
      sizes: sizeList(),
      actions: ACTIONS,
      port: 43117,
      windowAccess: false, // so the banner is visible while working on it
      appName: 'Electron',
      appPath: '/path/to/clippy/node_modules/electron/dist/Electron.app',
      sessions: [
        { sessionId: 'demo-1', name: NAME, color: '#4fa3d1', status: 'working', character: 'clip' },
        // A second agent in the *same* folder as demo-1: the case where picking
        // a pet for one row must leave the other row alone.
        { sessionId: 'demo-1b', name: NAME, color: '#d18f4f', status: 'idle', character: 'clod' },
        { sessionId: 'demo-2', name: 'clippy', color: '#6cbf6c', status: 'waiting', character: 'cat' },
      ],
    });
  }
  if (pathname === '/settings') {
    // Without the trailing slash the page's own assets resolve against /.
    res.writeHead(302, { Location: '/settings/' });
    return res.end();
  }
  if (pathname === '/settings/') {
    return servePage(res, 'settings.html', 'settings.js', 'settings-stub.js');
  }
  if (pathname === '/settings/settings-stub.js') {
    return sendFile(res, path.join(DEMO_DIR, 'settings-stub.js'));
  }
  if (pathname.startsWith('/settings/')) {
    const file = safeJoin(RENDERER_DIR, pathname.slice('/settings/'.length));
    return file ? sendFile(res, file) : sendJson(res, { error: 'bad path' }, 400);
  }

  if (pathname === '/renderer' ) {
    res.writeHead(302, { Location: '/renderer/' });
    return res.end();
  }
  if (pathname === '/renderer/') return servePage(res, 'index.html', 'clippy.js', 'stub-api.js');

  if (pathname === '/renderer/stub-api.js') {
    return sendFile(res, path.join(DEMO_DIR, 'stub-api.js'));
  }
  if (pathname.startsWith('/renderer/')) {
    const file = safeJoin(RENDERER_DIR, pathname.slice('/renderer/'.length));
    return file ? sendFile(res, file) : sendJson(res, { error: 'bad path' }, 400);
  }

  const rel = pathname === '/' ? 'index.html' : pathname === '/gallery' ? 'gallery.html' : pathname.slice(1);
  const file = safeJoin(DEMO_DIR, rel);
  return file ? sendFile(res, file) : sendJson(res, { error: 'bad path' }, 400);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`📎 Clippy web test bench → http://127.0.0.1:${PORT}`);
  console.log(`   Sandbox gallery (every state at once) → http://127.0.0.1:${PORT}/gallery`);
  console.log('   Serving the real src/renderer with a stubbed clippyAPI.');
  console.log('   (End-to-end still means: npm start + npm run mock-session.)');
  // `npm run sandbox` passes --open <path>: pop the page straight into the
  // browser so "iterate on the design" is one command with nothing to run first.
  const openAt = args.indexOf('--open');
  if (openAt !== -1 && process.platform === 'darwin') {
    require('node:child_process').execFile('open', [
      `http://127.0.0.1:${PORT}${args[openAt + 1] || '/'}`,
    ]);
  }
});
