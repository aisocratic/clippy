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

// Which hook events we subscribe to. `matcher` becomes both the Claude Code
// hook matcher and the ?kind= query param so the app knows why it fired.
const SPECS = [
  { event: 'Notification', matcher: 'permission_prompt' },
  { event: 'Notification', matcher: 'idle_prompt' },
  { event: 'Stop' },
  { event: 'UserPromptSubmit' },
  { event: 'SessionStart' },
  { event: 'SessionEnd' },
];

function hookCommand(spec, port) {
  const kind = spec.matcher ? `?kind=${spec.matcher}` : '';
  const url = `http://127.0.0.1:${port}/hook/${spec.event}${kind}`;
  // -m 2: never stall Claude Code; `|| true`: never report an error if the
  // Clippy app isn't running. The trailing marker comment lets us find and
  // remove our own entries later.
  return (
    `curl -s -m 2 -X POST '${url}' -H 'Content-Type: application/json' ` +
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
    group.hooks.push({ type: 'command', command: hookCommand(spec, port), timeout: 5 });
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
      } else {
        console.log(`Clippy hooks in ${settingsPath}:`);
        for (const f of found) {
          console.log(`  - ${f.event}${f.matcher ? ` (${f.matcher})` : ''}`);
        }
      }
      break;
    }
    default:
      console.log('usage: clippy-hooks.js <install|uninstall|status> [--port N] [--settings PATH]');
      process.exit(args.cmd ? 1 : 0);
  }
}

if (require.main === module) main();

module.exports = { installHooks, uninstallHooks, listInstalled, hookCommand, SPECS, MARKER };
