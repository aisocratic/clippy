#!/usr/bin/env node
'use strict';

/**
 * Installs/removes the Claude Code and Codex hooks that report session activity
 * to the Clippy app. Edits the user-level JSON hook files for both agents. Safe
 * to re-run; only touches entries tagged with our marker.
 *
 * Usage:
 *   node bin/clippy-hooks.js install   [--port N] [--agent claude|codex|both]
 *   node bin/clippy-hooks.js uninstall [--agent claude|codex|both]
 *   node bin/clippy-hooks.js status    [--agent claude|codex|both]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKER = '#clippy';
const LEGACY_MARKER = '#claude-clippy';
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

// Codex implements the same core lifecycle hook protocol, but currently has
// no Notification or PostToolUseFailure events and no AskUserQuestion tool.
// Its PostToolUse event also fires for non-zero shell exits, which the session
// tracker detects from tool_response instead. Edit/Write are documented aliases
// for apply_patch, and Agent is the matcher alias for spawn_agent.
const CODEX_MEANINGFUL_TOOLS =
  'Bash|apply_patch|Edit|Write|update_plan|Agent|request_user_input|image_gen__.*|mcp__.*';

const CODEX_SPECS = [
  { event: 'PermissionRequest', mode: 'decide' },
  { event: 'Stop', mode: 'decide' },
  { event: 'PreToolUse', matcher: CODEX_MEANINGFUL_TOOLS },
  { event: 'PostToolUse', matcher: CODEX_MEANINGFUL_TOOLS },
  { event: 'UserPromptSubmit' },
  { event: 'SessionStart' },
  // Codex caps this advisory hook at three seconds.
  { event: 'SessionEnd', timeout: 3 },
];

// Which terminal window a session lives in. The hook shell's parent is the
// `claude` process, so its tty pins the exact tab in Terminal.app/iTerm2, and
// its pid lets the app walk up to the owning .app for every other terminal.
// Sent as headers so the payload Claude Code hands us stays untouched.
const TERM_HEADERS =
  `-H "X-Clippy-Term: \${TERM_PROGRAM:-}" ` +
  `-H "X-Clippy-Pid: $PPID" ` +
  `-H "X-Clippy-Tty: $(ps -o tty= -p $PPID 2>/dev/null | tr -d ' ')" `;

function hookCommand(spec, port, source = 'claude') {
  const kind = spec.event === 'Notification' && spec.matcher ? `?kind=${spec.matcher}` : '';
  const separator = kind ? '&' : '?';
  const url = `http://127.0.0.1:${port}/hook/${spec.event}${kind}${separator}source=${source}`;
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
  const command = String(hook?.command || '');
  return hook && hook.type === 'command' &&
    (command.includes(MARKER) || command.includes(LEGACY_MARKER));
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
function installHooksFor(settings, port, specs, source) {
  uninstallHooks(settings); // idempotent: replace any previous install
  settings.hooks = settings.hooks || {};
  for (const spec of specs) {
    const groups = (settings.hooks[spec.event] = settings.hooks[spec.event] || []);
    let group = groups.find((g) => (g.matcher || '') === (spec.matcher || ''));
    if (!group) {
      group = spec.matcher ? { matcher: spec.matcher, hooks: [] } : { hooks: [] };
      groups.push(group);
    }
    group.hooks = group.hooks || [];
    group.hooks.push({
      type: 'command',
      command: hookCommand(spec, port, source),
      timeout: spec.timeout || (spec.mode === 'decide' ? DECIDE_HOOK_TIMEOUT_S : 5),
    });
  }
  return settings;
}

/** Add Claude Code hooks to ~/.claude/settings.json. */
function installHooks(settings, port = DEFAULT_PORT) {
  return installHooksFor(settings, port, SPECS, 'claude');
}

/** Add Codex hooks to ~/.codex/hooks.json. */
function installCodexHooks(settings, port = DEFAULT_PORT) {
  return installHooksFor(settings, port, CODEX_SPECS, 'codex');
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
function checkDriftFor(settings, port, specs) {
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

  const missing = specs.filter(
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

function checkDrift(settings, port = DEFAULT_PORT) {
  return checkDriftFor(settings, port, SPECS);
}

function checkCodexDrift(settings, port = DEFAULT_PORT) {
  return checkDriftFor(settings, port, CODEX_SPECS);
}

/** The user-level hook file each agent reads. */
function settingsPathFor(agent) {
  return path.join(os.homedir(), `.${agent}`, agent === 'claude' ? 'settings.json' : 'hooks.json');
}

/**
 * The same read-modify-write as `clippy-hooks.js install`, callable in-process —
 * this is the app's one-click path, so a fresh DMG install never needs a
 * terminal. Returns one row per agent; a failure (say, hand-edited JSON that no
 * longer parses) is reported rather than thrown, so one broken config doesn't
 * stop the other agent's install — and the broken file is left untouched.
 */
function installToFiles({ port = DEFAULT_PORT, agents = ['claude', 'codex'], pathFor = settingsPathFor } = {}) {
  return agents.map((agent) => {
    const settingsPath = pathFor(agent);
    try {
      const settings = readSettings(settingsPath);
      (agent === 'codex' ? installCodexHooks : installHooks)(settings, port);
      writeSettings(settingsPath, settings);
      return { agent, settingsPath, ok: true };
    } catch (err) {
      return { agent, settingsPath, ok: false, error: err.message };
    }
  });
}

/* ---------------- CLI ---------------- */

function parseArgs(argv) {
  const args = { cmd: argv[0], port: DEFAULT_PORT, settings: null, agent: null };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--settings') args.settings = argv[++i];
    else if (argv[i] === '--agent') args.agent = argv[++i];
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error(`invalid --port`);
  }
  if (args.agent && !['claude', 'codex', 'both'].includes(args.agent)) {
    throw new Error(`invalid --agent`);
  }
  return args;
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, 'utf8');
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    throw new Error(`${settingsPath} is not valid JSON; fix it first (${err.message})`);
  }
}

function writeSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // --settings remains a single-file escape hatch for tests and custom Claude
  // homes. With normal paths, one command manages both supported agents.
  const selected = args.settings
    ? [args.agent === 'codex' ? 'codex' : 'claude']
    : args.agent === 'claude' || args.agent === 'codex'
    ? [args.agent]
    : ['claude', 'codex'];
  const targets = selected.map((agent) => ({
    agent,
    settingsPath: args.settings || settingsPathFor(agent),
    install: agent === 'codex' ? installCodexHooks : installHooks,
    drift: agent === 'codex' ? checkCodexDrift : checkDrift,
  }));

  if (!['install', 'uninstall', 'status'].includes(args.cmd)) {
    console.log('usage: clippy-hooks.js <install|uninstall|status> [--port N] [--agent claude|codex|both] [--settings PATH]');
    process.exit(args.cmd ? 1 : 0);
  }

  for (const target of targets) {
    let settings;
    try {
      settings = readSettings(target.settingsPath);
    } catch (err) {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
      continue;
    }

    if (args.cmd === 'install') {
      target.install(settings, args.port);
      writeSettings(target.settingsPath, settings);
      console.log(`Installed Clippy ${target.agent} hooks into ${target.settingsPath}`);
      continue;
    }
    if (args.cmd === 'uninstall') {
      uninstallHooks(settings);
      writeSettings(target.settingsPath, settings);
      console.log(`Removed Clippy hooks from ${target.settingsPath}`);
      continue;
    }

    const found = listInstalled(settings);
    if (found.length === 0) {
      console.log(`No Clippy ${target.agent} hooks in ${target.settingsPath}.`);
      continue;
    }
    console.log(`Clippy ${target.agent} hooks in ${target.settingsPath}:`);
    for (const f of found) console.log(`  - ${f.event}${f.matcher ? ` (${f.matcher})` : ''}`);
    const drift = target.drift(settings, args.port);
    if (drift.missing.length || drift.wrongPort || drift.noTerminalInfo) {
      console.log('⚠ These hooks are out of date — re-run `npm run hooks:install`:');
      for (const m of drift.missing) console.log(`  - missing: ${m}`);
      if (drift.wrongPort) console.log(`  - some hooks don't point at port ${args.port}`);
      if (drift.noTerminalInfo) console.log("  - they don't report the session's terminal window");
    }
  }

  if (args.cmd === 'install') {
    console.log(`Hooks report to http://127.0.0.1:${args.port} — start the app with: npm start`);
    console.log('Restart running agent sessions; in Codex, open /hooks and trust the new hooks.');
  }
}

if (require.main === module) main();

module.exports = {
  installHooks,
  installCodexHooks,
  installToFiles,
  settingsPathFor,
  uninstallHooks,
  listInstalled,
  checkDrift,
  checkCodexDrift,
  hookCommand,
  SPECS,
  CODEX_SPECS,
  MARKER,
  MEANINGFUL_TOOLS,
  CODEX_MEANINGFUL_TOOLS,
  QUESTION_TOOL,
  DEFAULT_PORT,
};
