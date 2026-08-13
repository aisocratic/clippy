# Troubleshooting

## The downloaded app will not open

The official `v0.3.1` release and later are Developer ID signed and
Apple-notarized, so macOS should open them normally. If macOS says the app
cannot be verified, delete that copy and download the current asset from the
official GitHub release; do not bypass Gatekeeper for a binary from any other
source.

The current DMG is Apple-silicon-only and requires macOS 11 or newer. Intel Mac
users must build from source for now. See [Compatibility](COMPATIBILITY.md).

## No agent sessions appear

1. Open the 📎 menu-bar item and choose **Install hooks** or the hook update
   action.
2. Restart agent sessions that were already running when the hooks changed.
3. For Codex, open `/hooks`, review the Clippy definitions, and trust them.
4. From a source checkout, run `npm run hooks:status`.
5. Confirm only one Clippy instance is running. The first process to bind
   `127.0.0.1:43117` owns the hook server.

When Clippy is not running, its curl hooks fail quickly and the agent continues
with its normal terminal behavior.

## Clippy cannot find, raise, or type into the right window

Open **System Settings → Privacy & Security → Accessibility** and enable
**Clippy for Claude Code**. A source build appears as **Electron** instead.
Restart the app if macOS does not apply the change immediately.

Terminal.app and iTerm2 expose exact tab/TTY information. Other terminals and
editors may only allow Clippy to raise the owning app or best matching window.
Disable **Perch on the session's own window** in Quick settings if the host
does not expose reliable window information.

## A card timed out or moved back to the terminal

That is the safety fallback. Approvals, questions, and reviews are held only
for a bounded period. Dismissing a card, closing Clippy, or reaching the timeout
returns no decision so the agent can show its native prompt.

## A hook settings file is invalid

The in-app installer never overwrites unparseable JSON. Fix the reported
`~/.claude/settings.json` or `~/.codex/hooks.json`, then choose **Install hooks**
again. Installation for a healthy agent configuration can still succeed while
the other file is invalid.

## Still stuck?

Open a [bug report](https://github.com/AISocratic/clippy/issues/new?template=bug.yml)
with macOS/CPU, app version, agent version, terminal/editor, expected behavior,
and the smallest safe reproduction. Remove code, prompts, secrets, usernames,
and private paths before attaching logs or screenshots.
