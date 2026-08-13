# Privacy and local data flow

## The app

Clippy has no account, cloud relay, advertising SDK, or app telemetry. It does
not upload prompts, code, project names, transcripts, approvals, or usage data
to AI Socratic.

The one exception is **Feedback**, and it never happens on its own. Nothing is
sent until you open Settings → Feedback, pick a thumb, write something, and
press send under a line naming where it goes — privately to the AI Socratic
team, and nowhere else. What is transmitted
is exactly three values — the thumb, the text you typed, and the app version —
to `https://aisocratic.org/api/feedback`. No project names, paths, code,
transcripts, session data, IP-derived identity, email, or device id travel with
it, and the payload is built in one pure function (`src/feedback.js`) with a
test asserting nothing else can join it.

Feedback is stored in AI Socratic's own database and read by the people who
make Clippy. It is not published: nothing written there appears on the website
or anywhere public. The table carries a separate `published` column that only a
person can set, so "shown publicly" can never be a state feedback falls into by
default. There is no queue, no batching, and no retry — if a send fails, it
says so and nothing leaves.

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
