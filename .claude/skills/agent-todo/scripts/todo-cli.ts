/**
 * todo-cli — read and mutate the admin Kanban board (the `todos` table) from
 * the agent-todo skill. Uses the service-role DB client directly so it works
 * headlessly (the HTTP API at /api/admin/todos requires an admin session cookie).
 *
 * Run from the PROJECT ROOT so the @/ path alias and .env.local resolve:
 *
 *   npx tsx --env-file=.env.local --tsconfig ./tsconfig.json \
 *     .claude/skills/agent-todo/scripts/todo-cli.ts <command> [args]
 *
 * Commands:
 *   board                 Open cards as JSON: { nodes, edges, plan } where
 *                         `plan` is a dependency-ordered list of leaf tasks
 *                         grouped into parallelizable waves (plus inProgress,
 *                         blocked, needsBreakdown — childless epics that must
 *                         be decomposed into task cards, not implemented —
 *                         humanAssigned — cards assigned to a person,
 *                         which the agent must never pick up — and
 *                         readyToMerge — cards with an open PR and an
 *                         approved verdict: merge the PR, don't re-implement).
 *   get <id>              One card as JSON.
 *   status <id> <status>  Move a card to a column (backlog|todo|doing|review|
 *                         done|wont-do|archive). `doing` is the "In Progress" column.
 *   pr <id> <url>         Attach a PR url to a card.
 *   set <id> k=v [k=v...] Patch fields (status, pr_url, automerge, assignee,
 *                         priority, title, description, needs_human_review,
 *                         goal_percentage, loop_limit, effort, model,
 *                         subtasks_effort, subtasks_model).
 *                         Booleans accept true/false. Execution-policy fields:
 *                         effort = low|mid|high; model = a tier or concrete slug;
 *                         subtasks_* additionally accept same|same_lower; an
 *                         empty value clears the field. See lib/agents/model-policy.
 *   create <title> [k=v...]
 *                         Create a card. Fields: description, type (task|epic),
 *                         priority, status, parent_id, dependencies (comma-
 *                         separated ids), automerge, needs_human_review,
 *                         goal_percentage, loop_limit, created_by, assignee,
 *                         effort, model, subtasks_effort, subtasks_model.
 *   comments <id>         All comments on a card (chronological), as JSON.
 *   comment <id> <author> <body>
 *                         Append a comment / log entry to a card.
 */

import {
  getTodoGraph,
  getTodoById,
  updateTodo,
  createTodo,
  getTodoComments,
  createTodoComment,
  TODO_STATUSES,
  TODO_TYPES,
  type Todo,
  type TodoStatus,
  type TodoType,
  type UpdateTodoInput,
  type CreateTodoInput,
} from '@/lib/db/todos';
import {
  isEffortLevel,
  isValidModelValue,
  isValidSubtasksEffortValue,
  isValidSubtasksModelValue,
} from '@/lib/agents/model-policy';
import { buildPlan } from '@/lib/agents/dispatch';

function die(msg: string): never {
  console.error(`todo-cli: ${msg}`);
  process.exit(1);
}

/**
 * Validate an execution-policy text field (effort/model/subtasks_*). Empty
 * clears the field (null); a non-empty value must pass `validate`, else die.
 */
function policyField(key: string, val: string, validate: (v: string) => boolean): string | null {
  if (val === '') return null;
  if (!validate(val)) die(`invalid ${key} "${val}"`);
  return val;
}

/** Parse an integer field, dying with a clear message when out of range. */
function intInRange(key: string, val: string, min: number, max: number): number {
  const n = Number(val);
  if (!Number.isInteger(n) || n < min || n > max) {
    die(`invalid ${key} "${val}" (integer ${min}-${max})`);
  }
  return n;
}

// The wave scheduler (`buildPlan`) lives in lib/agents/dispatch.ts, shared
// with the runner daemon so both consumers apply identical eligibility rules.

async function cmdBoard() {
  const { nodes, edges } = await getTodoGraph({ open: true });
  const { waves, blocked, inProgress, needsBreakdown, humanAssigned, readyToMerge } =
    buildPlan(nodes);
  const slim = (t: Todo) => ({
    id: t.id,
    title: t.title,
    type: t.type,
    priority: t.priority,
    status: t.status,
    parent_id: t.parent_id,
    dependencies: t.dependencies,
    assignee: t.assignee,
    automerge: t.automerge,
    pr_url: t.pr_url,
    needs_human_review: t.needs_human_review,
    goal_percentage: t.goal_percentage,
    loop_limit: t.loop_limit,
    effort: t.effort,
    model: t.model,
    subtasks_effort: t.subtasks_effort,
    subtasks_model: t.subtasks_model,
    review_status: t.review_status,
    review_feedback: t.review_feedback,
  });
  console.log(
    JSON.stringify(
      {
        nodes,
        edges,
        plan: {
          waves: waves.map((w) => w.map(slim)),
          inProgress: inProgress.map(slim),
          blocked: blocked.map((t) => ({ id: t.id, title: t.title })),
          needsBreakdown: needsBreakdown.map(slim),
          humanAssigned: humanAssigned.map(slim),
          readyToMerge: readyToMerge.map(slim),
        },
      },
      null,
      2,
    ),
  );
}

async function cmdGet(id: string) {
  const todo = await getTodoById(id);
  if (!todo) die(`card ${id} not found`);
  console.log(JSON.stringify(todo, null, 2));
}

async function cmdStatus(id: string, status: string) {
  if (!(TODO_STATUSES as readonly string[]).includes(status)) {
    die(`invalid status "${status}" (one of: ${TODO_STATUSES.join(', ')})`);
  }
  const todo = await updateTodo(id, { status: status as TodoStatus });
  console.log(JSON.stringify({ id: todo.id, status: todo.status }, null, 2));
}

async function cmdPr(id: string, url: string) {
  const todo = await updateTodo(id, { pr_url: url });
  console.log(JSON.stringify({ id: todo.id, pr_url: todo.pr_url }, null, 2));
}

async function cmdSet(id: string, pairs: string[]) {
  const patch: UpdateTodoInput = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq < 0) die(`bad field "${p}" (expected key=value)`);
    const key = p.slice(0, eq);
    const val = p.slice(eq + 1);
    switch (key) {
      case 'status':
        if (!(TODO_STATUSES as readonly string[]).includes(val)) die(`invalid status "${val}"`);
        patch.status = val as TodoStatus;
        break;
      case 'pr_url':
        patch.pr_url = val || null;
        break;
      case 'automerge':
        patch.automerge = val === 'true' || val === '1';
        break;
      case 'assignee':
        patch.assignee = val || null;
        break;
      case 'priority':
        patch.priority = Number(val) as 1 | 2 | 3;
        break;
      case 'title':
        patch.title = val;
        break;
      case 'description':
        patch.description = val || null;
        break;
      case 'needs_human_review':
        patch.needs_human_review = val === 'true' || val === '1';
        break;
      case 'goal_percentage':
        patch.goal_percentage = intInRange(key, val, 0, 100);
        break;
      case 'loop_limit':
        patch.loop_limit = intInRange(key, val, 1, 100);
        break;
      case 'effort':
        patch.effort = policyField(key, val, isEffortLevel);
        break;
      case 'model':
        patch.model = policyField(key, val, isValidModelValue);
        break;
      case 'subtasks_effort':
        patch.subtasks_effort = policyField(key, val, isValidSubtasksEffortValue);
        break;
      case 'subtasks_model':
        patch.subtasks_model = policyField(key, val, isValidSubtasksModelValue);
        break;
      default:
        die(`unsupported field "${key}"`);
    }
  }
  const todo = await updateTodo(id, patch);
  console.log(JSON.stringify(todo, null, 2));
}

async function cmdCreate(title: string, pairs: string[]) {
  const input: CreateTodoInput = { title };
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq < 0) die(`bad field "${p}" (expected key=value)`);
    const key = p.slice(0, eq);
    const val = p.slice(eq + 1);
    switch (key) {
      case 'description':
        input.description = val || null;
        break;
      case 'type':
        if (!(TODO_TYPES as readonly string[]).includes(val)) {
          die(`invalid type "${val}" (one of: ${TODO_TYPES.join(', ')})`);
        }
        input.type = val as TodoType;
        break;
      case 'priority':
        input.priority = Number(val) as 1 | 2 | 3;
        break;
      case 'status':
        if (!(TODO_STATUSES as readonly string[]).includes(val)) die(`invalid status "${val}"`);
        input.status = val as TodoStatus;
        break;
      case 'parent_id':
        input.parent_id = val || null;
        break;
      case 'dependencies':
        input.dependencies = val ? val.split(',').map((s) => s.trim()).filter(Boolean) : [];
        break;
      case 'automerge':
        input.automerge = val === 'true' || val === '1';
        break;
      case 'needs_human_review':
        input.needs_human_review = val === 'true' || val === '1';
        break;
      case 'goal_percentage':
        input.goal_percentage = intInRange(key, val, 0, 100);
        break;
      case 'loop_limit':
        input.loop_limit = intInRange(key, val, 1, 100);
        break;
      case 'created_by':
        input.created_by = val || null;
        break;
      case 'assignee':
        input.assignee = val || null;
        break;
      case 'effort':
        input.effort = policyField(key, val, isEffortLevel);
        break;
      case 'model':
        input.model = policyField(key, val, isValidModelValue);
        break;
      case 'subtasks_effort':
        input.subtasks_effort = policyField(key, val, isValidSubtasksEffortValue);
        break;
      case 'subtasks_model':
        input.subtasks_model = policyField(key, val, isValidSubtasksModelValue);
        break;
      default:
        die(`unsupported field "${key}"`);
    }
  }
  const todo = await createTodo(input);
  console.log(JSON.stringify(todo, null, 2));
}

async function cmdComments(id: string) {
  const comments = await getTodoComments(id);
  console.log(JSON.stringify(comments, null, 2));
}

async function cmdComment(id: string, author: string, body: string) {
  const comment = await createTodoComment({ todo_id: id, author, body });
  console.log(JSON.stringify(comment, null, 2));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'board':
      return cmdBoard();
    case 'get':
      return cmdGet(rest[0] ?? die('usage: get <id>'));
    case 'status':
      return cmdStatus(rest[0] ?? die('usage: status <id> <status>'), rest[1] ?? die('missing status'));
    case 'pr':
      return cmdPr(rest[0] ?? die('usage: pr <id> <url>'), rest[1] ?? die('missing url'));
    case 'set':
      return cmdSet(rest[0] ?? die('usage: set <id> k=v ...'), rest.slice(1));
    case 'create':
      return cmdCreate(rest[0] ?? die('usage: create <title> [k=v ...]'), rest.slice(1));
    case 'comments':
      return cmdComments(rest[0] ?? die('usage: comments <id>'));
    case 'comment':
      return cmdComment(
        rest[0] ?? die('usage: comment <id> <author> <body>'),
        rest[1] ?? die('missing author'),
        rest[2] ?? die('missing body'),
      );
    default:
      die(`unknown command "${cmd ?? ''}" (board|get|status|pr|set|create|comments|comment)`);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
