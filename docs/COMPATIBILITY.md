# Compatibility

This page describes the compatibility of the current public release. It is not
a promise that every terminal or future agent-hook schema will work unchanged.
When reporting a problem, include the versions listed in the issue template.

## Current packaged release

| Component | Supported |
|---|---|
| macOS | macOS 11 or newer |
| CPU | Apple silicon (`arm64`) |
| Intel Macs | Build from source; the current DMG is not universal |
| Claude Code | Current stable local CLI sessions with lifecycle hooks enabled |
| Codex | Current stable local sessions after reviewing and trusting Clippy in `/hooks` |
| Remote/cloud sessions | Not supported unless their hooks execute on this Mac and can reach `127.0.0.1:43117` |

The DMG architecture and minimum OS are checked from the packaged executable
before a release. A future universal build should update this table and its
release notes before the download is published.

## Agent differences

Claude Code and Codex do not expose identical hook events.

- Claude permission requests, plan approval, `AskUserQuestion`, and end-of-turn
  review can be answered from Clippy.
- Codex permission, `request_user_input`, and end-of-turn decisions use the
  same cards. Question selections are returned as a model-visible blocked-tool
  result because Codex's question arguments do not expose a pre-filled answer.
- Codex has no separate notification or post-tool-failure hook. Clippy infers
  non-zero shell exits from `PostToolUse` where possible.
- Drive mode and Claude allowance calibration are Claude-specific. Codex
  context/token totals come from local rollout transcripts.

## Terminal and editor windows

- Terminal.app and iTerm2 can be raised to the exact tab through their exposed
  TTY information.
- VS Code, Cursor, Ghostty, WezTerm, Warp, kitty, and other hosts are detected
  through the owning macOS app and window title. Clippy can normally raise the
  correct app/window, but exact tab selection depends on what the host exposes.
- Perching, raising windows, and typing a follow-up require macOS Accessibility
  permission. The cards and localhost hook decisions still work if perching is
  disabled.

See [Troubleshooting](TROUBLESHOOTING.md) for diagnostic steps.
