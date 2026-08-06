#!/usr/bin/env node
'use strict';

/**
 * Installs/removes the Claude Code, Codex, and OpenClaw hooks that report
 * session activity to the Clippy app. Edits the user-level JSON hook files for
 * each agent. Safe to re-run; only touches entries tagged with our marker (or,
 * for OpenClaw, handler entries pointing at our clippy-hook module).
 *
 * Usage:
 *   node bin/clippy-hooks.js install   [--port N] [--agent claude|codex|openclaw|both]
 *   node bin/clippy-hooks.js uninstall [--agent claude|codex|openclaw|both]
 *   node bin/clippy-hooks.js status    [--agent claude|codex|openclaw|both]
 *
 * OpenClaw is opted into the default (no --agent) run only when ~/.openclaw
 * already exists — Clippy never creates it for non-OpenClaw users.
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
// feedback). `reply` keeps a quick response visible too: SessionStart uses it
// for the one-line buddy identity at the top of the chat. Everything else is
// fire-and-forget.
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
  { event: 'SessionStart', mode: 'reply' },
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
  { event: 'SessionStart', mode: 'reply' },
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
  if (spec.mode === 'reply') {
    // SessionStart's response is a small systemMessage for the terminal UI.
    // Keep stdout, but retain the same fast, harmless failure as passive hooks.
    return (
      `curl -s --connect-timeout 1 -m 2 -X POST '${url}' ` +
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

  const missing = specs.filter((spec) => {
    const found = installed.find(
      (h) => h.event === spec.event && h.matcher === (spec.matcher || '')
    );
    if (!found) return true;
    // A pre-banner SessionStart hook discards the response body, so it has the
    // right event name but cannot show which buddy owns the chat.
    return spec.mode === 'reply' && found.command.includes('>/dev/null 2>&1');
  }).map((spec) => `${spec.event}${spec.matcher ? ` (${spec.matcher})` : ''}`);

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

/* ---------------- OpenClaw ---------------- */

// OpenClaw (openclaw.ai) doesn't run shell hooks; it loads ES-module handlers
// declared in ~/.openclaw/openclaw.json under hooks.internal.handlers, one
// entry per event *family*. Our single handler translates message/command
// events into the same local POSTs the curl hooks send (watch-mode only).
const OPENCLAW_EVENTS = ['message', 'command'];

// How we recognize our own handler entries: the module path carries the
// handler's filename. Matching on the name (not an exact path) also catches
// entries left by an install in another location.
const OPENCLAW_HANDLER_NAME = 'clippy-hook';

const isOurOpenclawHandler = (handler) =>
  Boolean(handler) && String(handler.module || '').includes(OPENCLAW_HANDLER_NAME);

/**
 * Ensure hooks.internal is enabled and carries exactly our two handler entries
 * (mutates + returns the parsed openclaw.json object). Idempotent, and never
 * touches handlers that aren't ours.
 */
function installOpenclawHooks(config, { port = DEFAULT_PORT, handlerPath } = {}) {
  if (!handlerPath) throw new Error('installOpenclawHooks needs a handlerPath');
  void port; // the handler reads CLIPPY_PORT from its environment
  uninstallOpenclawHooks(config); // idempotent: replace any previous install
  config.hooks = config.hooks || {};
  const internal = (config.hooks.internal = config.hooks.internal || {});
  internal.enabled = true;
  internal.handlers = internal.handlers || [];
  for (const event of OPENCLAW_EVENTS) {
    internal.handlers.push({ event, module: handlerPath });
  }
  return config;
}

/** Remove only our handler entries (mutates + returns the config). */
function uninstallOpenclawHooks(config) {
  const internal = config.hooks && config.hooks.internal;
  if (!internal || !Array.isArray(internal.handlers)) return config;
  // Other handlers may rely on hooks.internal.enabled — leave it alone.
  internal.handlers = internal.handlers.filter((h) => !isOurOpenclawHandler(h));
  return config;
}

function listOpenclawInstalled(config) {
  const handlers = config.hooks?.internal?.handlers || [];
  return handlers
    .filter(isOurOpenclawHandler)
    .map((h) => ({ event: h.event || '', matcher: '' }));
}

function checkOpenclawDrift(config) {
  const events = new Set(listOpenclawInstalled(config).map((h) => h.event));
  if (events.size === 0) {
    return { installed: false, missing: [], wrongPort: false, noTerminalInfo: false };
  }
  return {
    installed: true,
    missing: OPENCLAW_EVENTS.filter((event) => !events.has(event)),
    // The handler dials the port from its env and never knows the terminal.
    wrongPort: false,
    noTerminalInfo: false,
  };
}

/**
 * The same read-modify-write as `clippy-hooks.js install`, callable in-process —
 * this is the app's one-click path, so a fresh DMG install never needs a
 * terminal. Returns one row per agent; a failure (say, hand-edited JSON that no
 * longer parses) is reported rather than thrown, so one broken config doesn't
 * stop the other agent's install — and the broken file is left untouched.
 */
function installToFiles({ port = DEFAULT_PORT, agents = ['claude', 'codex'], pathFor } = {}) {
  const resolvePath = pathFor || settingsPathFor;
  return agents.map((agent) => {
    const settingsPath = resolvePath(agent);
    try {
      const settings = readSettings(settingsPath);
      targetFor(agent, settingsPath).install(settings, port);
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
  if (args.agent && !['claude', 'codex', 'openclaw', 'both'].includes(args.agent)) {
    throw new Error(`invalid --agent`);
  }
  return args;
}

/** The user-level config file Clippy's hooks live in, per agent. */
function settingsPathFor(agent) {
  if (agent === 'codex') return path.join(os.homedir(), '.codex', 'hooks.json');
  if (agent === 'openclaw') return path.join(os.homedir(), '.openclaw', 'openclaw.json');
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * Which agents a bare `install`/`uninstall`/`status` should touch. Claude and
 * Codex always; OpenClaw only when ~/.openclaw already exists, so we never
 * create OpenClaw config for people who don't run it (`--agent openclaw`
 * explicitly still works either way).
 */
function defaultAgents() {
  const agents = ['claude', 'codex'];
  if (fs.existsSync(path.join(os.homedir(), '.openclaw'))) agents.push('openclaw');
  return agents;
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

function openclawTarget(settingsPath) {
  // The live handler is a copy inside the OpenClaw home, so deleting or moving
  // the Clippy repo never breaks a running gateway. Absolute path: OpenClaw
  // resolves handler modules from its own cwd, not from its config file.
  const handlerPath = path.join(path.dirname(path.resolve(settingsPath)), 'hooks', 'clippy-hook.mjs');
  const handlerSource = path.join(__dirname, '..', 'integrations', 'openclaw', 'clippy-hook.mjs');
  return {
    agent: 'openclaw',
    settingsPath,
    install: (settings, port) => {
      fs.mkdirSync(path.dirname(handlerPath), { recursive: true });
      fs.copyFileSync(handlerSource, handlerPath);
      return installOpenclawHooks(settings, { port, handlerPath });
    },
    uninstall: (settings) => {
      try {
        fs.rmSync(handlerPath, { force: true });
      } catch {}
      return uninstallOpenclawHooks(settings);
    },
    list: listOpenclawInstalled,
    drift: checkOpenclawDrift,
  };
}

function targetFor(agent, settingsPath) {
  if (agent === 'openclaw') return openclawTarget(settingsPath);
  return {
    agent,
    settingsPath,
    install: agent === 'codex' ? installCodexHooks : installHooks,
    uninstall: uninstallHooks,
    list: listInstalled,
    drift: agent === 'codex' ? checkCodexDrift : checkDrift,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // --settings remains a single-file escape hatch for tests and custom agent
  // homes. With normal paths, one command manages every supported agent.
  const selected =
    args.agent && args.agent !== 'both'
      ? [args.agent]
      : args.settings
      ? ['claude']
      : defaultAgents();
  const targets = selected.map((agent) =>
    targetFor(agent, args.settings || settingsPathFor(agent))
  );

  if (!['install', 'uninstall', 'status'].includes(args.cmd)) {
    console.log('usage: clippy-hooks.js <install|uninstall|status> [--port N] [--agent claude|codex|openclaw|both] [--settings PATH]');
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
      target.uninstall(settings);
      writeSettings(target.settingsPath, settings);
      console.log(`Removed Clippy hooks from ${target.settingsPath}`);
      continue;
    }

    const found = target.list(settings);
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
    if (targets.some((t) => t.agent === 'openclaw')) {
      console.log('Restart the OpenClaw gateway so it loads the new handler.');
      if (args.port !== DEFAULT_PORT) {
        console.log(`OpenClaw handler dials port ${DEFAULT_PORT} unless CLIPPY_PORT=${args.port} is set in the gateway's environment.`);
      }
    }
  }
}

if (require.main === module) main();

module.exports = {
  installHooks,
  installCodexHooks,
  installOpenclawHooks,
  installToFiles,
  settingsPathFor,
  uninstallHooks,
  uninstallOpenclawHooks,
  listInstalled,
  listOpenclawInstalled,
  checkDrift,
  checkCodexDrift,
  checkOpenclawDrift,
  defaultAgents,
  hookCommand,
  SPECS,
  CODEX_SPECS,
  OPENCLAW_EVENTS,
  MARKER,
  MEANINGFUL_TOOLS,
  CODEX_MEANINGFUL_TOOLS,
  QUESTION_TOOL,
  DEFAULT_PORT,
};
