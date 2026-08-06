# Privacy and local data flow

## The app

Clippy has no account, cloud relay, advertising SDK, or app telemetry. It does
not upload prompts, code, project names, transcripts, approvals, or usage data
to AI Socratic.

The coding agent still communicates with its own provider under that product's
terms. Clippy does not change that provider relationship.

Agent hooks POST lifecycle events to `http://127.0.0.1:43117` on the same Mac.
The server binds to loopback only. Interactive hook responses carry the user's
decision back to the agent process that made the request. Nothing is ever
auto-approved. If Clippy is closed, unreachable, dismissed, or times out, the
normal terminal prompt takes over.

To provide its local features, Clippy may read:

- the Clippy-tagged entries in `~/.claude/settings.json` and
  `~/.codex/hooks.json` to install, update, or remove its hooks;
- local Claude Code and Codex session/rollout files to calculate context and
  token totals;
- local process, terminal, and window metadata to associate a buddy with the
  correct session window; and
- its own Electron settings and generated buddy assets.

macOS may request Accessibility, Automation, and Notification permissions.
Accessibility is used to locate/raise session windows and, when requested, type
a follow-up into the selected terminal. These permissions can be revoked in
System Settings at any time.

## The website

The marketing website can be built with an optional Umami tracker for aggregate
pageviews and CTA events. The tracker is omitted entirely unless both analytics
environment variables are configured, respects the browser's Do Not Track
setting, and is separate from the downloaded app. It must not be configured for
session replay or user identification.

The website events contain only the action name and page location, for example
`download_click` at `hero`. They never contain code, prompts, project names, or
app activity.

## Removing Clippy

Use the menu-bar uninstall action or `npm run hooks:uninstall` to remove only
the entries tagged as Clippy hooks. Then delete the app. The uninstaller leaves
all unrelated Claude Code and Codex configuration untouched.
