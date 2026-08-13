'use strict';

const { toHookResponse } = require('./decisions');

/**
 * Everything Clippy can do with a Claude Code session, as data.
 *
 * The settings window renders this, so what it shows can't drift from what the
 * app does: each entry names the hook that triggers it, the switch that turns
 * it off, the pose the buddy strikes while it's happening, and — for the
 * interactive ones — the exact JSON each button hands back, straight from
 * `toHookResponse`. If a button's meaning changes, this page changes with it.
 */

const json = (event, action, message, toolInput) =>
  JSON.stringify(toHookResponse(event, action, message, { toolInput }));

const ASK = { questions: [{ question: 'Which store?', options: [{ label: 'Redis' }] }] };

const ACTIONS = [
  {
    id: 'approval',
    pose: 'excited',
    scenario: 'approval-bash',
    icon: '🛂',
    title: 'Approve or deny a tool call',
    appliesTo: 'Claude + Codex',
    hook: 'PermissionRequest',
    setting: 'approvals',
    when: 'The agent is about to do something it needs permission for — and only ' +
      'then. Allowlisted commands never reach Clippy.',
    shows: 'A card with the exact command or edit, a box for a reason, and a countdown.',
    choices: [
      { label: 'Allow', effect: 'the agent runs it', json: json('PermissionRequest', 'allow') },
      {
        label: 'Deny',
        effect: 'the agent is blocked and told why',
        json: json('PermissionRequest', 'deny', 'use rg instead'),
      },
      {
        label: 'Ask me in terminal',
        effect: 'the normal prompt appears there instead',
        json: json('PermissionRequest', 'pass'),
      },
    ],
  },
  {
    id: 'plan',
    pose: 'excited',
    scenario: 'approval-plan',
    icon: '📋',
    title: 'Approve or revise a plan',
    appliesTo: 'Claude',
    hook: 'PermissionRequest (ExitPlanMode)',
    setting: 'approvals',
    when: 'Claude finishes planning and asks to start work.',
    shows: 'The same card carrying the plan, relabelled Approve plan / Revise.',
    choices: [
      { label: 'Approve plan', effect: 'Claude starts working', json: json('PermissionRequest', 'allow') },
      {
        label: 'Revise',
        effect: 'back to planning with your note',
        json: json('PermissionRequest', 'deny', 'split step 3 in two'),
      },
    ],
  },
  {
    id: 'question',
    pose: 'excited',
    scenario: 'answer-one',
    icon: '❓',
    title: "Answer the agent's question",
    appliesTo: 'Claude + Codex',
    hook: 'PreToolUse (AskUserQuestion / request_user_input)',
    setting: 'answerQuestions',
    when: 'Claude or Codex asks a multiple-choice question.',
    shows: "Each option as a button — multi-select where Claude allows it.",
    choices: [
      {
        label: 'Submit answer',
        effect: 'fed back to the agent, so the terminal picker never appears',
        json: json('PreToolUse', 'answer', '{"Which store?":"Redis"}', ASK),
      },
      {
        label: 'Move to terminal',
        effect: 'released, so the picker opens there — and Clippy walks you to it',
        json: json('PreToolUse', 'pass', '', ASK),
      },
    ],
  },
  {
    id: 'review',
    pose: 'excited',
    scenario: 'review',
    icon: '✅',
    title: 'Review a finished turn',
    appliesTo: 'Claude + Codex',
    hook: 'Stop',
    setting: 'reviewOnStop',
    when: 'The agent finishes a turn. The hook is answered immediately — the chat is never held open.',
    shows: 'A review card with what the agent just said. It waits as long as you do — there is no countdown.',
    // No `json` on these: the Stop hook is answered before the card is even
    // shown, so no button hands Claude Code any JSON — feedback arrives as a
    // typed prompt instead.
    choices: [
      { label: 'Looks good', effect: 'the card goes away — the agent already stopped' },
      {
        label: 'Send feedback',
        effect: 'your note is typed into that session’s terminal as the next prompt',
      },
    ],
  },
  {
    id: 'trouble',
    pose: 'stress',
    scenario: 'activity-failed',
    icon: '😰',
    title: 'Show when things are going wrong',
    appliesTo: 'Claude + Codex',
    hook: 'PostToolUseFailure',
    when: 'A tool fails, or this session has used more than 30% of its context window.',
    shows: 'The buddy sweats and shivers until it settles — and the activity line turns red.',
    passive: true,
  },
  {
    id: 'activity',
    pose: 'think',
    scenario: 'activity-stream',
    icon: '⚙',
    title: 'Show what the agent is doing',
    appliesTo: 'Claude + Codex',
    hook: 'PreToolUse / PostToolUse',
    when: 'Any meaningful tool runs — Bash, Edit, Write, WebFetch, Task, MCP tools. ' +
      'Read, Grep, Glob and TodoWrite are excluded, so they never even fire a hook.',
    shows: 'A one-line activity line under the buddy: “Running: npm test”, “✓ done”, “⚠ Bash failed”.',
    passive: true,
  },
  {
    id: 'nudge',
    pose: 'excited',
    scenario: 'attention-urgent',
    icon: '🔴',
    title: "Nudge when a session needs you",
    appliesTo: 'Claude notifications · both agents for held cards',
    hook: 'Notification',
    when: 'A prompt is waiting in the terminal, or Claude has been waiting on your reply.',
    shows: 'A bouncing buddy and a speech bubble, re-nudging every 90 seconds until ' +
      'you answer, snooze it, or wave it away.',
    passive: true,
  },
  {
    id: 'point',
    pose: 'point',
    scenario: 'story',
    icon: '👇',
    title: 'Walk to the prompt and point at it',
    setting: 'autoPerch',
    when: 'Something goes back to the terminal — you sent it there, or a card timed out — ' +
      'while Clippy is perched on that window.',
    shows: 'He walks down to the input line, holds an “answer here” arrow on it, and strolls back.',
    passive: true,
  },
  {
    id: 'perch',
    pose: 'idle',
    scenario: 'story',
    icon: '📌',
    title: "Sit on the session's own window",
    setting: 'autoPerch',
    when: 'A buddy has something to say and we can find the window its session runs in.',
    shows: "He appears on that terminal's top-right corner and follows it around, " +
      'instead of waiting in the corner of the screen.',
    passive: true,
  },
  {
    id: 'usage',
    pose: 'idle',
    scenario: 'story',
    icon: '📊',
    title: 'Report context and spend',
    appliesTo: 'Claude + Codex',
    when: "You ask for it — click the buddy, then Stats & token usage.",
    shows: 'How much context is left, what this session has spent, and the totals for ' +
      "today and the week, read from Claude Code's own transcripts.",
    passive: true,
  },
  {
    id: 'drive',
    pose: 'think',
    scenario: 'drive',
    icon: '🕹',
    title: 'Run a session of its own',
    appliesTo: 'Claude',
    when: 'You start a Clippy-driven session from the menu bar (needs the Agent SDK).',
    shows: 'A transcript panel you can type into — Clippy answers its permission ' +
      'requests and questions through the same cards.',
    passive: true,
  },
  {
    id: 'spawn',
    pose: 'excited',
    scenario: 'story',
    icon: '🚀',
    title: 'Start an agent itself',
    appliesTo: 'Claude + Codex',
    when: 'You pick New agent in the menu bar and choose a folder — or an SSH host.',
    shows: 'A buddy for a session Clippy started, in a tmux session it owns. Typing at ' +
      'it goes straight in, so no window has to be raised and macOS has nothing to ' +
      'block; “Attach in Terminal” hands you the same session whenever you want to ' +
      'take over. It outlives Clippy — quitting the app leaves the work running.',
    passive: true,
  },
  {
    id: 'transcript',
    pose: 'idle',
    scenario: 'story',
    icon: '📜',
    title: 'Read what a session it started is saying',
    appliesTo: 'Claude + Codex',
    when: 'Continuously, for sessions Clippy started — including over SSH, where hooks ' +
      'report to the other machine and never reach here.',
    shows: "The agent's own transcript, read from disk rather than scraped off a " +
      'terminal: the latest message in the bubble, and the last few under Recent ' +
      'messages. A quiet session costs one look at the file every twenty seconds.',
    passive: true,
  },
  {
    id: 'chat',
    pose: 'wave',
    scenario: 'story',
    icon: '💬',
    title: 'Talk to the buddy, and through it to your agents',
    appliesTo: 'Clippy itself',
    when: 'You press 💬 under the buddy.',
    shows: 'A word with the pet itself — its own small model, no tools, and nothing ' +
      'that reaches a session. Above it, a row of who you could be talking to ' +
      'instead: the agent this buddy sits on, or — with one buddy standing in for ' +
      'every agent — all of them. Pick one and what you type goes into that ' +
      "agent's session, through its tmux pane or its terminal window. This is the " +
      'only box in the window that types at an agent; the panel behind ▾ is ' +
      'numbers, and nothing you can type into.',
    passive: true,
  },
  {
    id: 'quiet',
    pose: 'idle',
    scenario: 'story',
    icon: '🤫',
    title: 'Stay out of the way when you are already there',
    appliesTo: 'Claude + Codex',
    setting: 'quietWhenFocused',
    when: 'A session wants you and the window it runs in is the one you are ' +
      'looking at — the right app in front, and for Terminal and iTerm the right ' +
      'tab as well.',
    shows: 'Nothing. No buddy, no notification, and a held question is handed back ' +
      "to that window so the agent's own prompt appears where you are already " +
      'typing. The tray still counts it. Whenever it cannot tell for certain — ' +
      'no answer from the window server, a terminal whose tabs it cannot read — ' +
      'it speaks up rather than risk a message you never see.',
    passive: true,
  },
  {
    id: 'feedback',
    pose: 'wave',
    scenario: 'story',
    icon: '💬',
    title: 'Tell us how it is going',
    appliesTo: 'Clippy itself',
    when: 'You open Settings → Feedback, pick a thumb, and press send. Never on its own.',
    shows: 'A thumb and a box. It goes privately to the people who make Clippy — not ' +
      'published, not a review, and nowhere public. The only thing Clippy sends that ' +
      'came from you, and it carries just the thumb, your words, and the build number: ' +
      'no project names, no paths, no code, nothing that says who you are.',
    passive: true,
  },
];

module.exports = { ACTIONS };
