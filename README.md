# 📎 Clippy for Claude Code

A little Clippy that lives on your MacBook, **knows what every Claude Code
session is doing right now**, and lets you **answer from Clippy** when one needs
you: approve or deny permission requests, approve or revise a plan, review
Claude's work when it finishes, and get nudged when Claude asks you a question —
without hunting through terminal tabs.

> *"Hey! Claude wants to run `rm -rf /tmp/build` in “my-app” — allow it?"*

| Approve or deny | Approve or revise a plan | Surface a question |
|---|---|---|
| ![approval](shots/7-approval-card.png) | ![plan](shots/10-plan-card.png) | ![question](shots/11-question-card.png) |

A live **activity line** under Clippy shows what each session is doing —
`⚙ my-app — Running: npm test`, `✏ Editing server.js`, `✓ done — your turn`,
`⚠ Bash failed` — so you always know the state at a glance.

*(Real captures of the app driven by simulated hook events — regenerate with
`xvfb-run npx electron scripts/demo-screenshots.js`. On your Mac the dark
backdrop is transparent: just Clippy floating over your windows.)*

You kick off a long Claude Code task, switch to Slack, and twenty minutes later
discover it's been sitting at a permission prompt the whole time. Clippy fixes
that: a floating, draggable paperclip (always on top, on every Space) that
knows the live state of every session — and it doesn't give up, re-nudging
every 90 seconds until you respond, snooze, or dismiss.

## How it works

```
Claude Code session(s)
   │  hooks: PermissionRequest / Stop / Pre+PostToolUse / Notification / Session*
   ▼  curl POST → http://127.0.0.1:43117/hook/<event>   (response = hook decision)
Clippy app (Electron)
   ├─ session tracker: who's working, waiting, blocked — and what they're doing now
   ├─ decision broker: holds interactive hooks open until you click (or timeout)
   ├─ floating Clippy: activity line, approval/plan/review/question cards, snooze
   ├─ native macOS notifications (clickable)
   └─ menu bar item 📎 with a count of sessions waiting on you
```

Claude Code's [hooks](https://code.claude.com/docs/en/hooks) fire shell
commands on lifecycle events, and a hook's stdout JSON can *answer* the event.
The installer registers nine tiny `curl` hooks in `~/.claude/settings.json`
that POST each event's JSON to the app on localhost. Two of them are
interactive — their HTTP response is the hook's decision:

| Hook event | Clippy reaction |
|---|---|
| `PermissionRequest` | 🛂 **Approval card** — Allow / Deny (with a reason Claude sees) / send to terminal. For `ExitPlanMode` it becomes a **plan card**: Approve / Revise (your note sends Claude back to planning) |
| `Stop` | ✅ **Review card** — "Looks good" lets Claude stop; typed feedback sends it back to work |
| `PreToolUse` *(Bash, Edit, Write, Web*, Task, …)* | ⚙ **Activity line** — what Claude is doing now. For `AskUserQuestion` it pops a **question card** + notification so you go answer in the terminal |
| `PostToolUse` *(same tools)* | ✓ marks the action done; ⚠ surfaces failures |
| `Notification` (`permission_prompt`) | 🔴 Urgent bounce — a prompt is waiting in the terminal |
| `Notification` (`idle_prompt`) | 🟡 Reminder — Claude has been waiting for your reply |
| `UserPromptSubmit` | clears alerts & pending cards for that session (you're on it) |
| `SessionStart` / `SessionEnd` | tracks sessions appearing/disappearing |

The activity hooks match **only meaningful tools** (`Bash|Edit|Write|…|mcp__.*`)
— `Read`, `Grep`, `Glob`, and `TodoWrite` are excluded, so the noisy read-only
tools never even fire a hook (no latency, no spam).

**Why a question only gets *surfaced*, not answered:** the CLI hook API can't
inject the chosen answer back into a running session — only the Agent SDK's
`canUseTool` can. So in this **watch mode** Clippy notifies you and shows the
question; you pick in the terminal. To answer multiple-choice questions
remotely, see **Drive mode** below.

Safety properties of the interactive hooks:

- `PermissionRequest` fires **only when Claude Code would actually show a
  permission prompt** — allowlisted commands run at full speed, untouched.
- If you don't answer in time (60s for approvals, 30s for reviews — typing
  extends the hold), Clippy answers "no decision" and the normal terminal
  prompt takes over. Nothing is ever auto-approved.
- When the app isn't running, the hooks fail instantly
  (`--connect-timeout 1 … || true`) and Claude Code behaves exactly as if
  Clippy didn't exist.
- Both behaviors can be toggled from the ✓ pills under Clippy or the 📎 menu
  bar item ("approvals" / "review"), and the toggles persist.

## Quick start

```bash
npm install            # pulls Electron
npm run hooks:install  # registers hooks in ~/.claude/settings.json
npm start              # Clippy appears bottom-right; 📎 appears in the menu bar
```

Restart any already-running Claude Code sessions so they pick up the hooks,
then ask Claude to do something that needs permission — Clippy will let you
know.

## Using it

- **Activity line**: the small line under Clippy shows what each session is
  doing right now (`⚙ Running: npm test`, `✏ Editing server.js`, `✓ done`,
  `⚠ Bash failed`). Ambient — it never pops the window.
- **Approval card**: when Claude asks for permission, the card shows the exact
  command/edit. **Allow** runs it, **Deny** blocks it (anything you typed in
  the box is sent to Claude as the reason — "use rg instead", "wrong dir"),
  **To terminal** hands it back to the normal prompt.
- **Plan card**: when Claude presents a plan (plan mode), the card shows the
  plan. **Approve plan** lets it start; type a change and **Revise** to send it
  back to planning with your note.
- **Question card**: when Claude asks a multiple-choice question, Clippy shows
  it and notifies you — answer it in the terminal (watch mode can't inject the
  answer; **Drive mode** can).
- **Review card**: when Claude finishes, click **Looks good** to let it stop,
  or type what's missing and **Send feedback** — Claude keeps working with
  your note, no terminal round-trip.
- **Drag Clippy** anywhere; he floats above full-screen apps on all Spaces.
- **Click Clippy** to re-open the latest message.
- **Got it** acknowledges everything; **Snooze 5m** pauses the nagging.
- The red badge and the menu bar `📎 N` show how many sessions need you.
- **hide** (hover below Clippy) hides the window; bring it back from the
  menu bar. Quit from the menu bar too.
- Works with any number of parallel sessions — each is tracked by
  `session_id` and named after its project directory.

## Drive mode — answer *everything* from Clippy (Agent SDK)

Watch mode (above) can't *answer* a multiple-choice `AskUserQuestion` — the CLI
hook API has no way to inject the chosen answer into a running session. **Drive
mode** closes that gap: from the 📎 menu bar, **New Clippy-driven session…**
picks a folder and launches a headless Claude session that Clippy *owns* via
the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). You type
prompts in the GUI and get a streamed transcript — and every interaction is
answerable from Clippy:

| | Drive panel | Answer a question |
|---|---|---|
| | ![drive](shots/12-drive-panel.png) | ![answer](shots/13-answer-card.png) |

The SDK's `canUseTool` callback routes each request to a card: permission
requests and plan approvals (allow/deny/revise) reuse the same cards as watch
mode, and **AskUserQuestion becomes clickable option buttons** whose selection
is fed straight back to Claude.

It's a *separate* headless session from your terminal `claude`, with its own
auth:

- The SDK is an **optional dependency** — install it with
  `npm install @anthropic-ai/claude-agent-sdk` (it bundles the `claude`
  binary). The app runs fine without it; you just can't start a driven session.
- It uses whatever credentials `claude` uses on this machine — your existing
  Claude Code login, `claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`), or
  `ANTHROPIC_API_KEY`. **Billing note:** subscription-plan SDK usage draws from
  a separate Agent SDK credit; an API key bills per token. Watch mode (hooks)
  has no such cost — it's just your normal terminal sessions.

## Configuration

| What | How |
|---|---|
| Port (default `43117`) | `CLIPPY_PORT=5005 npm start` and `npm run hooks:install -- --port 5005` |
| Approval hold time (default 60s) | `CLIPPY_APPROVAL_HOLD_SECS=120 npm start` |
| Review hold time (default 30s) | `CLIPPY_REVIEW_HOLD_SECS=60 npm start` |
| Inspect live state | `curl localhost:43117/status` |
| Check installed hooks | `npm run hooks:status` |
| Remove hooks | `npm run hooks:uninstall` (only touches entries tagged `#claude-clippy`) |

## Try it without a real session (mock harness)

`scripts/mock-session.js` fires a realistic sequence of hook POSTs at the
running app so you can watch — and test — every reaction without starting a
real `claude`. Held cards block until you answer; the script prints the
decision that came back, exactly like a real session.

```bash
npm start              # one terminal
npm run mock-session   # another: drive it, click the cards in Clippy
```

You'll see the activity line update, an approval card on `rm -rf`, a question
card on `AskUserQuestion`, a plan card on `ExitPlanMode`, and a review card on
`Stop`. For an unattended end-to-end check that auto-answers via Chrome
DevTools and asserts each decision:

```bash
npx electron . --remote-debugging-port=9333
npm run mock-session -- --auto --fast     # exits non-zero if any decision is wrong
```

## Development

```bash
npm test   # node:test suite for the server, session tracker, decisions, installer
```

- `src/server.js` — dependency-free localhost HTTP server for hook events;
  interactive hooks hold the response open until a decision arrives
- `src/decisions.js` — decision broker, hook-decision JSON, tool-call
  rendering (`describeToolCall`) and the terse `activityLabel`
- `src/sessions.js` — session state machine + live `activity`; turns hook
  events into reactions
- `src/main.js` — Electron main: window, tray, notifications, settings, the
  hook handlers (approvals, plans, reviews, activity, question surfacing)
- `src/sdk-session.js` — Drive mode: wraps the Agent SDK `query()` and routes
  `canUseTool` (incl. answerable AskUserQuestion) to Clippy's cards
- `src/renderer/` — the Clippy himself (hand-drawn SVG, blinks, bounces)
- `bin/clippy-hooks.js` — hook installer/uninstaller for `~/.claude/settings.json`
- `scripts/mock-session.js` — mock Claude Code session (above)
- `scripts/cdp-eval.js` — drive the renderer over CDP for e2e checks
  (`npx electron . --remote-debugging-port=9333`)

## Security notes

The hook server binds to `127.0.0.1` only and accepts nothing but hook event
JSON; nothing is exposed to the network and no session content leaves your
machine.
