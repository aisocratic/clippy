'use strict';

/**
 * Mock Claude Code session — drives a realistic sequence of hook POSTs at a
 * running Clippy so you can watch (and test) how it reacts, without a real
 * `claude` session. Held hooks (PermissionRequest / Stop) block until you
 * answer in the Clippy UI; the script prints the decision that came back —
 * exactly like a real session would receive it.
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

function post(event, payload) {
  return fetch(`${BASE}/hook/${event}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url));
  if (!page) throw new Error(`no Clippy renderer on CDP port ${CDP_PORT} — launch with --remote-debugging-port=${CDP_PORT}`);
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

  // Surface a multiple-choice question (PreToolUse, fire-and-forget — answered in the terminal).
  await fire(
    'PreToolUse',
    {
      ...base(),
      tool_name: 'AskUserQuestion',
      tool_input: {
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
        ],
      },
    },
    'AskUserQuestion → question card + notification (answer in terminal)'
  );
  if (AUTO) {
    await sleep(600);
    await cdp(`document.getElementById('qcard').classList.contains('hidden') ? 'hidden' : 'shown'`)
      .then(() => ok('question card surfaced'))
      .catch((e) => bad(`question card check failed: ${e.message}`));
  }
  await sleep(1500);

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

  // Held review on Stop — type feedback to send Claude back to work.
  await held(
    'Stop',
    { ...base(), stop_hook_active: false },
    'Claude finished — review it',
    {
      expr: `(() => { const i = document.getElementById('card-input'); i.value = 'Also add a 429 integration test'; i.dispatchEvent(new Event('input')); document.getElementById('btn-feedback').click(); return 'sent'; })()`,
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
