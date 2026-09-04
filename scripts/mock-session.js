'use strict';

/**
 * Mock Claude Code session — drives a realistic sequence of hook POSTs at a
 * running Clippy so you can watch (and test) how it reacts, without a real
 * `claude` session. Held hooks (PermissionRequest / AskUserQuestion / Stop)
 * block until you answer in the Clippy UI; the script prints the decision that
 * came back — exactly like a real session would receive it.
 *
 *   npm start                 # in one terminal: launch Clippy
 *   npm run mock-session      # in another: drive it, click the cards
 *
 * Flags:
 *   --auto         Answer the held cards automatically via Chrome DevTools
 *                  (launch the app with --remote-debugging-port=<cdp> first)
 *                  and assert each returned hook decision. Good for CI.
 *   --fast         Short pauses.
 *   --port N       Clippy hook port (default 43117 / $CLIPPY_PORT).
 *   --cdp-port N   DevTools port for --auto (default 9333).
 *   --session ID   Override the mock session id.
 *   --cwd PATH     Override the mock project directory.
 */

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const i = args.indexOf(f);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const AUTO = has('--auto');
const FAST = has('--fast');
const PORT = Number(val('--port', process.env.CLIPPY_PORT || 43117));
const CDP_PORT = Number(val('--cdp-port', 9333));
const SESSION = val('--session', `mock-${process.pid}`);
const CWD = val('--cwd', '/Users/you/projects/billing-api');
const BASE = `http://127.0.0.1:${PORT}`;
const NAME = CWD.split('/').filter(Boolean).pop();

const sleep = (ms) => new Promise((r) => setTimeout(r, FAST ? Math.min(ms, 250) : ms));
const base = () => ({ session_id: SESSION, cwd: CWD, permission_mode: 'default' });

let pass = 0;
let fail = 0;
const log = (...a) => console.log(...a);
const ok = (msg) => (pass++, log(`   ✓ ${msg}`));
const bad = (msg) => (fail++, log(`   ✗ ${msg}`));

// The real hooks report which terminal they ran in; send this script's own so
// "open session window" points at the terminal you're running the mock from.
const TERM_HEADERS = {
  'X-Clippy-Term': process.env.TERM_PROGRAM || '',
  'X-Clippy-Pid': String(process.ppid),
  'X-Clippy-Tty': (() => {
    try {
      return require('node:child_process')
        .execFileSync('/bin/ps', ['-o', 'tty=', '-p', String(process.ppid)])
        .toString()
        .trim();
    } catch {
      return '';
    }
  })(),
};

function post(event, payload) {
  return fetch(`${BASE}/hook/${event}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...TERM_HEADERS },
    body: JSON.stringify({ hook_event_name: event, ...payload }),
  });
}

/** Fire-and-forget hook: returns immediately. */
async function fire(event, payload, note) {
  await post(event, payload).catch(() => {});
  if (note) log(`→ ${event}: ${note}`);
}

/**
 * Held hook: POST blocks until the user (or --auto) answers. Returns the
 * decision JSON Claude Code would receive on the hook's stdout.
 */
async function held(event, payload, note, auto) {
  log(`→ ${event} [HELD]: ${note}`);
  const pending = post(event, payload).then((r) => r.json());
  if (AUTO && auto) {
    await sleep(900);
    await cdp(auto.expr).catch((e) => bad(`CDP click failed: ${e.message}`));
  } else {
    log(`   …waiting for you to answer in Clippy`);
  }
  const decision = await pending;
  log(`   ← decision: ${JSON.stringify(decision)}`);
  if (AUTO && auto) auto.assert(decision);
  return decision;
}

/* ---- Minimal Chrome DevTools eval (for --auto), same wire as cdp-eval.js ---- */

async function cdp(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
  const pages = targets.filter((t) => t.type === 'page' && /index\.html/.test(t.url));
  // Every session shares one buddy window, and its URL keeps the id of
  // whichever session opened it. Ours if we were first; otherwise the one
  // window that is not a sandbox buddy — which is the shared one.
  const sessionOf = (t) => new URL(t.url).searchParams.get('session') || '';
  const page =
    pages.find((t) => sessionOf(t) === SESSION) ||
    pages.find((t) => !sessionOf(t).startsWith('sandbox:'));
  if (!page) {
    throw new Error(
      `no Clippy window for session ${SESSION} on CDP port ${CDP_PORT} ` +
        `(${pages.length} window(s) open) — launch with --remote-debugging-port=${CDP_PORT}`
    );
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
  const reply = new Promise((res, rej) => {
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id === 1) (msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result));
    };
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression } }));
  await reply;
  ws.close();
}

/* ----------------------------------- story ----------------------------------- */

async function main() {
  // Preflight: is Clippy up?
  try {
    await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(1500) });
  } catch {
    console.error(`Clippy isn't answering on ${BASE}. Start it with \`npm start\` first.`);
    process.exit(1);
  }

  log(`\n📎 Mock session "${NAME}" → ${BASE}${AUTO ? '  (auto, CDP ' + CDP_PORT + ')' : ''}\n`);

  await fire('SessionStart', { ...base(), source: 'startup' }, `now watching "${NAME}"`);
  await sleep(900);

  await fire('UserPromptSubmit', { ...base(), prompt: 'Add rate limiting to the API' }, 'user prompt submitted');
  await sleep(900);

  // Live activity line: a couple of meaningful tool calls.
  await fire('PreToolUse', { ...base(), tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the test suite' } }, 'activity → Running tests');
  await sleep(1200);
  await fire('PostToolUse', { ...base(), tool_name: 'Bash', tool_input: { command: 'npm test' }, success: true, tool_output: 'PASS' }, 'activity → tests passed');
  await sleep(900);
  await fire('PreToolUse', { ...base(), tool_name: 'Edit', tool_input: { file_path: `${CWD}/src/server.js`, old_string: 'a', new_string: 'b' } }, 'activity → Editing server.js');
  await sleep(1300);

  // A tool that fails reports on its own event, with the error attached.
  await fire('PreToolUse', { ...base(), tool_name: 'Bash', tool_input: { command: 'npm run lint', description: 'Lint the project' } }, 'activity → Linting');
  await sleep(1000);
  await fire(
    'PostToolUseFailure',
    {
      ...base(),
      tool_name: 'Bash',
      tool_input: { command: 'npm run lint', description: 'Lint the project' },
      error: 'Exit code 1\n2 problems (2 errors, 0 warnings)',
      is_interrupt: false,
    },
    'activity → ⚠ Bash failed'
  );
  await sleep(1300);

  // Held approval card.
  await held(
    'PermissionRequest',
    { ...base(), tool_name: 'Bash', tool_input: { command: 'rm -rf build && npm run build', description: 'Clean rebuild' } },
    'Claude wants to run a destructive command',
    {
      expr: `document.getElementById('btn-allow').click()`,
      assert: (d) =>
        d?.hookSpecificOutput?.decision?.behavior === 'allow'
          ? ok('approval → allow')
          : bad(`approval expected allow, got ${JSON.stringify(d)}`),
    }
  );
  await sleep(700);

  // Held question card: the picked options go back as updatedInput.answers, so
  // the terminal picker never appears.
  const questionInput = {
    questions: [
      {
        question: 'Which rate-limit store should I use?',
        header: 'Store',
        options: [
          { label: 'Redis', description: 'Shared across instances' },
          { label: 'In-memory', description: 'Simplest, single instance' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which routes should it cover?',
        header: 'Routes',
        options: [
          { label: '/api/v1', description: 'The public API' },
          { label: '/admin', description: 'Admin endpoints' },
        ],
        multiSelect: true,
      },
    ],
  };
  await held(
    'PreToolUse',
    { ...base(), tool_name: 'AskUserQuestion', tool_input: questionInput },
    'Claude is asking a multiple-choice question — pick the answers',
    {
      // Click the first option of question 1, then both options of question 2.
      expr: `(() => {
        const groups = [...document.querySelectorAll('#card-options .opt-group')];
        groups[0].querySelectorAll('.opt')[0].click();
        groups[1].querySelectorAll('.opt').forEach((b) => b.click());
        document.getElementById('btn-submit').click();
        return 'answered';
      })()`,
      assert: (d) => {
        const out = d?.hookSpecificOutput || {};
        const answers = out.updatedInput?.answers || {};
        const good =
          out.permissionDecision === 'allow' &&
          answers['Which rate-limit store should I use?'] === 'Redis' &&
          // multi-select answers come back comma-joined, one string per question
          answers['Which routes should it cover?'] === '/api/v1, /admin' &&
          // the rest of the tool input must survive untouched
          out.updatedInput?.questions?.length === 2;
        return good
          ? ok('question → answers injected as updatedInput.answers')
          : bad(`question expected answered input, got ${JSON.stringify(d)}`);
      },
    }
  );
  await sleep(900);

  // Plan-mode activity, then a held plan-approval card.
  const plan = '# Plan: API rate limiting\n\n1. Add a token-bucket middleware\n2. Wire it into the router\n3. Add config for limits per route\n4. Tests for 200/429 paths';
  await fire('PreToolUse', { ...base(), tool_name: 'ExitPlanMode', tool_input: { plan } }, 'activity → Presenting a plan');
  await sleep(700);
  await held(
    'PermissionRequest',
    { ...base(), permission_mode: 'plan', tool_name: 'ExitPlanMode', tool_input: { plan } },
    'Claude is presenting a plan for approval',
    {
      expr: `document.getElementById('btn-allow').click()`, // "Approve plan"
      assert: (d) =>
        d?.hookSpecificOutput?.decision?.behavior === 'allow'
          ? ok('plan → approve')
          : bad(`plan expected allow, got ${JSON.stringify(d)}`),
    }
  );
  await sleep(900);

  // Held review on Stop — open the feedback box, type, send Claude back to
  // work. The box is hidden until "Send feedback" is clicked, so the first
  // click opens it and the second submits.
  await held(
    'Stop',
    { ...base(), stop_hook_active: false },
    'Claude finished — review it',
    {
      expr: `(() => { const b = document.getElementById('btn-feedback'); b.click(); const i = document.getElementById('card-input'); if (i.classList.contains('hidden')) return 'feedback box did not open'; i.value = 'Also add a 429 integration test'; i.dispatchEvent(new Event('input')); b.click(); return 'sent'; })()`,
      assert: (d) =>
        d?.decision === 'block' && /429/.test(d?.reason || '')
          ? ok('review → feedback blocks the stop')
          : bad(`review expected block+reason, got ${JSON.stringify(d)}`),
    }
  );
  await sleep(700);

  await fire('SessionEnd', { ...base() }, `session "${NAME}" ended`);

  if (AUTO) {
    log(`\n${fail ? '❌' : '✅'} auto checks: ${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
  } else {
    log(`\n✅ Mock session complete. (Run with --auto to assert decisions via CDP.)\n`);
  }
}

main().catch((err) => {
  console.error('mock-session error:', err);
  process.exit(1);
});
