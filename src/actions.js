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
    title: "Answer Claude's question",
    appliesTo: 'Claude · Codex uses its native picker',
    hook: 'PreToolUse (AskUserQuestion)',
    setting: 'answerQuestions',
    when: 'Claude asks a multiple-choice question.',
    shows: "Each option as a button — multi-select where Claude allows it.",
    choices: [
      {
        label: 'Submit answer',
        effect: 'fed back as the tool’s input, so the terminal picker never appears',
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
    when: 'The agent finishes and is about to stop.',
    shows: 'A short review box before the session goes quiet.',
    choices: [
      { label: 'Looks good', effect: 'Claude stops', json: json('Stop', 'ok') },
      {
        label: 'Send feedback',
        effect: 'the agent keeps working with your note',
        json: json('Stop', 'feedback', 'also add a 429 test'),
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
];

module.exports = { ACTIONS };
