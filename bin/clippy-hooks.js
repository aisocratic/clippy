#!/usr/bin/env node
'use strict';

/**
 * Installs/removes the Claude Code hooks that report session activity to the
 * Clippy app. Edits ~/.claude/settings.json (user-level, applies to all
 * projects). Safe to re-run; only touches entries tagged with our marker.
 *
 * Usage:
 *   node bin/clippy-hooks.js install   [--port N] [--settings PATH]
 *   node bin/clippy-hooks.js uninstall [--settings PATH]
 *   node bin/clippy-hooks.js status    [--settings PATH]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKER = '#claude-clippy';
const DEFAULT_PORT = 43117;

// How long an interactive ("decide") hook may wait for the user to answer in
// the Clippy UI. The app resolves every held request well before this; the
// hook `timeout` below gives curl a little headroom on top.
const DECIDE_CURL_MAX_S = 115;
const DECIDE_HOOK_TIMEOUT_S = 120;

// Tools worth surfacing in the live activity line. Read/Grep/Glob/LS/TodoWrite
// are deliberately excluded so they never fire the PreToolUse hook (no curl
// round-trip, no latency on the noisy read-only tools). This string is a
// Claude Code matcher: `A|B` matches either tool, `mcp__.*` matches MCP tools.
const MEANINGFUL_TOOLS =
  'Bash|Edit|Write|MultiEdit|NotebookEdit|WebFetch|WebSearch|Task|ExitPlanMode|mcp__.*';

// AskUserQuestion gets its own *interactive* PreToolUse hook instead of riding
// the activity matcher: answering it means replying on stdout, which the
// fire-and-forget activity hook throws away. Kept out of MEANINGFUL_TOOLS so
// the two never both fire for the same tool call.
const QUESTION_TOOL = 'AskUserQuestion';

// Which hook events we subscribe to. For Notification hooks, `matcher` doubles
// as the ?kind= query param so the app knows why it fired; for tool hooks
// (Pre/PostToolUse, PermissionRequest) `matcher` is a Claude Code tool-name
// filter only. `mode: 'decide'` marks interactive hooks: their HTTP response
// body is echoed to stdout, which Claude Code parses as the hook's decision
// (approve/deny a permission request, or send Claude back to work with review
// feedback). Everything else is fire-and-forget.
const SPECS = [
  { event: 'Notification', matcher: 'permission_prompt' },
  { event: 'Notification', matcher: 'idle_prompt' },
  { event: 'PermissionRequest', mode: 'decide' },
  { event: 'PreToolUse', matcher: QUESTION_TOOL, mode: 'decide' },
  { event: 'Stop', mode: 'decide' },
  { event: 'PreToolUse', matcher: MEANINGFUL_TOOLS },
  { event: 'PostToolUse', matcher: MEANINGFUL_TOOLS },
  // Claude Code reports a failed tool on its own event, not PostToolUse.
  { event: 'PostToolUseFailure', matcher: MEANINGFUL_TOOLS },
  { event: 'UserPromptSubmit' },
  { event: 'SessionStart' },
  { event: 'SessionEnd' },
];

// Which terminal window a session lives in. The hook shell's parent is the
// `claude` process, so its tty pins the exact tab in Terminal.app/iTerm2, and
// its pid lets the app walk up to the owning .app for every other terminal.
// Sent as headers so the payload Claude Code hands us stays untouched.
const TERM_HEADERS =
  `-H "X-Clippy-Term: \${TERM_PROGRAM:-}" ` +
  `-H "X-Clippy-Pid: $PPID" ` +
  `-H "X-Clippy-Tty: $(ps -o tty= -p $PPID 2>/dev/null | tr -d ' ')" `;

function hookCommand(spec, port) {
  const kind = spec.event === 'Notification' && spec.matcher ? `?kind=${spec.matcher}` : '';
  const url = `http://127.0.0.1:${port}/hook/${spec.event}${kind}`;
  if (spec.mode === 'decide') {
    // Interactive: stdout (the app's JSON response) is the hook decision.
    // --connect-timeout 1: if the Clippy app isn't running, fail in <1s with
    // no output, which Claude Code treats as "no decision" — zero impact.
    return (
      `curl -s --connect-timeout 1 -m ${DECIDE_CURL_MAX_S} -X POST '${url}' ` +
      `-H 'Content-Type: application/json' ${TERM_HEADERS}--data-binary @- 2>/dev/null || true ${MARKER}`
    );
  }
  // -m 2: never stall Claude Code; `|| true`: never report an error if the
  // Clippy app isn't running. The trailing marker comment lets us find and
  // remove our own entries later.
  return (
    `curl -s -m 2 -X POST '${url}' -H 'Content-Type: application/json' ${TERM_HEADERS}` +
    `--data-binary @- >/dev/null 2>&1 || true ${MARKER}`
  );
}

function isOurs(hook) {
  return hook && hook.type === 'command' && String(hook.command).includes(MARKER);
}

/** Remove all clippy hooks from a settings object (mutates + returns it). */
function uninstallHooks(settings) {
  if (!settings.hooks) return settings;
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (Array.isArray(group.hooks)) {
        group.hooks = group.hooks.filter((h) => !isOurs(h));
      }
    }
    settings.hooks[event] = groups.filter((g) => g.hooks && g.hooks.length > 0);
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return settings;
}

/** Add clippy hooks to a settings object (mutates + returns it). */
function installHooks(settings, port = DEFAULT_PORT) {
  uninstallHooks(settings); // idempotent: replace any previous install
  settings.hooks = settings.hooks || {};
  for (const spec of SPECS) {
    const groups = (settings.hooks[spec.event] = settings.hooks[spec.event] || []);
    let group = groups.find((g) => (g.matcher || '') === (spec.matcher || ''));
    if (!group) {
      group = spec.matcher ? { matcher: spec.matcher, hooks: [] } : { hooks: [] };
      groups.push(group);
    }
    group.hooks = group.hooks || [];
    group.hooks.push({
      type: 'command',
      command: hookCommand(spec, port),
      timeout: spec.mode === 'decide' ? DECIDE_HOOK_TIMEOUT_S : 5,
    });
  }
  return settings;
}

function listInstalled(settings) {
  const found = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const group of groups || []) {
      for (const hook of group.hooks || []) {
        if (isOurs(hook)) found.push({ event, matcher: group.matcher || '' });
      }
    }
  }
  return found;
}

/**
 * Compare what's installed against what this build expects. The app calls this
 * on startup: hooks live in ~/.claude/settings.json and are only rewritten by
 * an explicit `hooks:install`, so upgrading Clippy otherwise leaves new events
 * (a newly answerable question, tool failures) silently unsubscribed.
 *
 * @returns {{installed: boolean, missing: string[], wrongPort: boolean, noTerminalInfo: boolean}}
 */
function checkDrift(settings, port = DEFAULT_PORT) {
  const installed = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const group of groups || []) {
      for (const hook of group.hooks || []) {
        if (isOurs(hook)) {
          installed.push({ event, matcher: group.matcher || '', command: String(hook.command) });
        }
      }
    }
  }
  if (installed.length === 0) {
    return { installed: false, missing: [], wrongPort: false, noTerminalInfo: false };
  }

  const missing = SPECS.filter(
    (spec) => !installed.some((h) => h.event === spec.event && h.matcher === (spec.matcher || ''))
  ).map((spec) => `${spec.event}${spec.matcher ? ` (${spec.matcher})` : ''}`);

  return {
    installed: true,
    missing,
    wrongPort: installed.some((h) => !h.command.includes(`127.0.0.1:${port}/`)),
    // Older installs don't report which terminal they ran in, so "open the
    // session's window" has nothing to aim at.
    noTerminalInfo: installed.some((h) => !h.command.includes('X-Clippy-Tty')),
  };
}

/* ---------------- CLI ---------------- */

function parseArgs(argv) {
  const args = { cmd: argv[0], port: DEFAULT_PORT, settings: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--settings') args.settings = argv[++i];
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error(`invalid --port`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const settingsPath =
    args.settings || path.join(os.homedir(), '.claude', 'settings.json');

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    try {
      settings = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      console.error(`error: ${settingsPath} is not valid JSON; fix it first (${err.message})`);
      process.exit(1);
    }
  }

  const write = () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  };

  switch (args.cmd) {
    case 'install':
      installHooks(settings, args.port);
      write();
      console.log(`Installed ${SPECS.length} Clippy hooks into ${settingsPath}`);
      console.log(`They report to http://127.0.0.1:${args.port} — start the app with: npm start`);
      console.log('Restart any running Claude Code sessions to pick up the hooks.');
      break;
    case 'uninstall':
      uninstallHooks(settings);
      write();
      console.log(`Removed Clippy hooks from ${settingsPath}`);
      break;
    case 'status': {
      const found = listInstalled(settings);
      if (found.length === 0) {
        console.log(`No Clippy hooks in ${settingsPath}. Run: node bin/clippy-hooks.js install`);
        break;
      }
      console.log(`Clippy hooks in ${settingsPath}:`);
      for (const f of found) {
        console.log(`  - ${f.event}${f.matcher ? ` (${f.matcher})` : ''}`);
      }
      const drift = checkDrift(settings, args.port);
      if (drift.missing.length || drift.wrongPort || drift.noTerminalInfo) {
        console.log('\n⚠ These hooks are out of date — re-run `npm run hooks:install`:');
        for (const m of drift.missing) console.log(`  - missing: ${m}`);
        if (drift.wrongPort) console.log(`  - some hooks don't point at port ${args.port}`);
        if (drift.noTerminalInfo) console.log("  - they don't report the session's terminal window");
      }
      break;
    }
    default:
      console.log('usage: clippy-hooks.js <install|uninstall|status> [--port N] [--settings PATH]');
      process.exit(args.cmd ? 1 : 0);
  }
}

if (require.main === module) main();

module.exports = {
  installHooks,
  uninstallHooks,
  listInstalled,
  checkDrift,
  hookCommand,
  SPECS,
  MARKER,
  MEANINGFUL_TOOLS,
  QUESTION_TOOL,
  DEFAULT_PORT,
};
