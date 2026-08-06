/**
 * agent-cli — report agent activity (runs) for the multi-agent PM platform from
 * the agent-todo skill. The critical write path that fills the manager UI's run
 * tree (/admin/todo agents view, `runs?view=tree`).
 *
 * Mirrors todo-cli.ts: it talks to the database with the service-role key (the
 * HTTP API at /api/admin/agents/* requires an admin session cookie), runs
 * headlessly, and prints clean JSON. Run it from the PROJECT ROOT so the `@/`
 * path alias and .env.local resolve:
 *
 *   LOG_LEVEL=warn npx tsx --env-file=.env.local --tsconfig ./tsconfig.json \
 *     .claude/skills/agent-todo/scripts/agent-cli.ts <command> [args]
 *
 * A "run" is one execution attempt of an agent against a card. Runs form a tree
 * via `parent_run_id` (orchestrator → wave workflow → per-task agents) and are
 * grouped by `workflow_run_id` so the manager can render the whole forest.
 *
 * Commands:
 *   run-start <todo_id> [k=v...]   Register a new run and start it (queued →
 *                                  running). Resolves (upserting if needed) the
 *                                  agent by `agent`/`kind`/`model`, reuses or
 *                                  creates the card's active assignment, then
 *                                  records the run with its hierarchy/runtime
 *                                  metadata. Prints the new run id (and the
 *                                  resolved agent/assignment) as JSON.
 *                                  Fields:
 *                                    agent          agent name (default agent-todo)
 *                                    kind           claude-code|codex|local-llm|other
 *                                    model          tier or concrete slug
 *                                    harness        one of RUN_HARNESSES
 *                                    parent_run_id  the run that spawned this one
 *                                    workflow_run_id  groups one Workflow invocation
 *                                    workflow_name  human label for that invocation
 *                                    session_id     harness session id
 *                                    host           machine name (default: os.hostname())
 *                                    transcript_path  on-disk transcript/log
 *                                    prompt         the prompt the run executes
 *                                    assigned_by    who assigned the card (free text)
 *   run-heartbeat <run_id> [note]  Stamp heartbeat_at (revives a stale run to
 *                                  running). An optional phase/progress note is
 *                                  recorded on the run's result_summary.
 *   run-finish <run_id> done|failed <summary>
 *                                  Terminal transition with an outcome summary
 *                                  (include the PR url in the summary).
 *   run-ask <run_id> <question>    Pause the run on a human-feedback question
 *                                  (state → needs-feedback).
 *   run-answer <run_id> <answer>   Answer the pending question and resume
 *                                  (state → running).
 *   run-get <run_id>               One run as JSON.
 *   run-messages <run_id>          Pending user instructions for the run as
 *                                  JSON (and marks them delivered). Agents call
 *                                  this between tasks to pick up steering input.
 *   run-msg-ack <run_id> <ids...>  Ack delivered instructions (agent acted on
 *                                  them). Pass one or more message ids.
 *   run-post <run_id> <body>       Post a note back to the user
 *                                  (direction=agent_to_user).
 *   run-tree [k=v...]              The run forest as JSON ({ tree }). Filters:
 *                                  todo_id, agent_id, workflow_run_id,
 *                                  parent_run_id, state, model, harness.
 *
 * Memory — durable, reusable knowledge in three scopes (scope=agent|user|project):
 *   memory-list scope=<s> [owner=<id-or-name>]
 *                                  List memories for a scope as JSON. agent/user
 *                                  need an owner (agent name|id, or user id|email);
 *                                  project reads the repo files (owner ignored).
 *   memory-get scope=<s> slug=<slug> [owner=<id-or-name>]
 *                                  One memory as JSON (or null).
 *   memory-set scope=<s> slug=<slug> [owner=<id-or-name>]
 *              [description=<one-line>] [content=<body>]
 *                                  Upsert a fact (one per slug). agent/user write
 *                                  the DB; project writes .claude/memory/<slug>.md
 *                                  and regenerates the index.
 *   memory-delete scope=<s> slug=<slug> [owner=<id-or-name>]
 *                                  Remove a fact.
 *
 * The orchestrator injects relevant memories at run-start (the agent's own + the
 * user's + the project index) and agents write durable learnings at run-finish.
 */

import os from 'node:os';
import {
  createRunMessage,
  getRunMessages,
  getPendingInstructions,
  markMessagesDelivered,
  markMessagesAcked,
} from '@/lib/db/run-messages';
import {
  getAgents,
  createAgent,
  getActiveAssignmentForTodo,
  createAssignment,
  createRun,
  transitionRun,
  heartbeatRun,
  askRunFeedback,
  answerRunFeedback,
  getRunById,
  getRunForest,
  AGENT_KINDS,
  RUN_HARNESSES,
  type Agent,
  type AgentKind,
  type RunHarness,
  type RunFilter,
  type RunState,
} from '@/lib/db/agent-platform';
import {
  listMemories,
  getMemory,
  setMemory,
  deleteMemory,
  type DbMemoryScope,
} from '@/lib/db/agent-memory';
import {
  listProjectMemories,
  getProjectMemory,
  setProjectMemory,
  deleteProjectMemory,
} from '@/lib/agents/project-memory';
import { getUserByEmail } from '@/lib/db/members';
import { isValidModelValue } from '@/lib/agents/model-policy';
import { shipRunTail } from '@/lib/agents/run-log-tail';

function die(msg: string): never {
  console.error(`agent-cli: ${msg}`);
  process.exit(1);
}

/** The two terminal run outcomes accepted by `run-finish`. */
const FINISH_STATES = ['done', 'failed'] as const;
type FinishState = (typeof FINISH_STATES)[number];

/** Parse `k=v k=v ...` pairs into a plain map, dying on a malformed token. */
function parsePairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq < 0) die(`bad field "${p}" (expected key=value)`);
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

/**
 * Resolve an agent by name, creating it if it does not exist yet. The orchestrator
 * and each child register under a stable name so the platform's agent registry
 * stays small and the run tree attributes work to a real agent row.
 */
async function resolveAgent(
  name: string,
  kind: AgentKind,
  model: string | null,
): Promise<Agent> {
  const existing = await getAgents();
  const match = existing.find((a) => a.name === name);
  if (match) return match;
  return createAgent({
    name,
    kind,
    // Stash the model on the agent's config so the registry shows the backend.
    config: model ? { model } : {},
    description: 'Registered by agent-cli (agent-todo run reporter).',
  });
}

async function cmdRunStart(todoId: string, pairs: string[]) {
  const f = parsePairs(pairs);

  const agentName = f.agent || 'agent-todo';
  const kind = (f.kind || 'claude-code') as AgentKind;
  if (!(AGENT_KINDS as readonly string[]).includes(kind)) {
    die(`invalid kind "${kind}" (one of: ${AGENT_KINDS.join(', ')})`);
  }

  const model = f.model || null;
  if (model && !isValidModelValue(model)) die(`invalid model "${model}"`);

  let harness: RunHarness | null = null;
  if (f.harness) {
    if (!(RUN_HARNESSES as readonly string[]).includes(f.harness)) {
      die(`invalid harness "${f.harness}" (one of: ${RUN_HARNESSES.join(', ')})`);
    }
    harness = f.harness as RunHarness;
  }

  const agent = await resolveAgent(agentName, kind, model);

  // Reuse the card's active assignment if this same agent already owns it,
  // otherwise (re)assign the card to this agent. createRun derives todo_id /
  // agent_id from the assignment.
  let assignment = await getActiveAssignmentForTodo(todoId);
  if (!assignment || assignment.agent_id !== agent.id) {
    assignment = await createAssignment({
      todo_id: todoId,
      agent_id: agent.id,
      assigned_by: f.assigned_by || 'agent-todo',
    });
  }

  const run = await createRun({
    assignment_id: assignment.id,
    parent_run_id: f.parent_run_id || null,
    workflow_run_id: f.workflow_run_id || null,
    workflow_name: f.workflow_name || null,
    model,
    harness,
    session_id: f.session_id || null,
    host: f.host || os.hostname(),
    transcript_path: f.transcript_path || null,
    prompt: f.prompt || null,
  });

  // A registered run is actively executing — start it immediately so the board
  // shows it live rather than parked in `queued`.
  const started = await transitionRun(run.id, { state: 'running' });

  console.log(
    JSON.stringify(
      {
        run_id: started.id,
        agent_id: agent.id,
        agent_name: agent.name,
        assignment_id: assignment.id,
        todo_id: started.todo_id,
        parent_run_id: started.parent_run_id,
        workflow_run_id: started.workflow_run_id,
        state: started.state,
      },
      null,
      2,
    ),
  );
}

async function cmdRunHeartbeat(runId: string, note: string | undefined) {
  // Optional phase/progress note ("implement" / "verify" / "improve" …): the
  // db-layer records it on result_summary so the board's live card shows the
  // current phase without forcing a lifecycle transition.
  const run = await heartbeatRun(runId, note ?? null);
  console.log(
    JSON.stringify(
      { run_id: run.id, state: run.state, heartbeat_at: run.heartbeat_at, note: note ?? null },
      null,
      2,
    ),
  );
}

async function cmdRunFinish(runId: string, outcome: string, summary: string) {
  if (!(FINISH_STATES as readonly string[]).includes(outcome)) {
    die(`invalid outcome "${outcome}" (one of: ${FINISH_STATES.join(', ')})`);
  }
  const run = await transitionRun(runId, {
    state: outcome as FinishState,
    result_summary: summary,
  });
  console.log(
    JSON.stringify(
      { run_id: run.id, state: run.state, result_summary: run.result_summary, finished_at: run.finished_at },
      null,
      2,
    ),
  );
}

async function cmdRunAsk(runId: string, question: string) {
  const run = await askRunFeedback(runId, question);
  console.log(
    JSON.stringify(
      { run_id: run.id, state: run.state, feedback_question: run.feedback_question },
      null,
      2,
    ),
  );
}

async function cmdRunAnswer(runId: string, answer: string) {
  const run = await answerRunFeedback(runId, answer);
  console.log(
    JSON.stringify(
      { run_id: run.id, state: run.state, feedback_answer: run.feedback_answer },
      null,
      2,
    ),
  );
}

async function cmdRunMessages(runId: string) {
  // Fetch-and-mark-delivered in one step: the caller is the harness/agent, so
  // returning a pending instruction IS its delivery.
  const pending = await getPendingInstructions(runId);
  await markMessagesDelivered(pending.map((m) => m.id));
  console.log(JSON.stringify({ run_id: runId, instructions: pending }, null, 2));
}

async function cmdRunMsgAck(runId: string, ids: string[]) {
  if (ids.length === 0) die('usage: run-msg-ack <run_id> <message_id...>');
  // Only ack messages that belong to this run (guard against pasted ids).
  const thread = await getRunMessages(runId);
  const known = new Set(thread.map((m) => m.id));
  const valid = ids.filter((id) => known.has(id));
  await markMessagesAcked(valid);
  console.log(JSON.stringify({ run_id: runId, acked: valid }, null, 2));
}

async function cmdRunPost(runId: string, body: string) {
  const message = await createRunMessage({
    run_id: runId,
    direction: 'agent_to_user',
    body,
    created_by: 'agent-todo',
  });
  console.log(JSON.stringify({ run_id: runId, message_id: message.id }, null, 2));
}

async function cmdRunGet(runId: string) {
  const run = await getRunById(runId);
  if (!run) die(`run ${runId} not found`);
  console.log(JSON.stringify(run, null, 2));
}

async function cmdRunTree(pairs: string[]) {
  const f = parsePairs(pairs);
  const filter: RunFilter = {};
  if (f.todo_id) filter.todo_id = f.todo_id;
  if (f.agent_id) filter.agent_id = f.agent_id;
  if (f.workflow_run_id) filter.workflow_run_id = f.workflow_run_id;
  if (f.parent_run_id) filter.parent_run_id = f.parent_run_id;
  if (f.state) filter.state = f.state.split(',').map((s) => s.trim()).filter(Boolean) as RunState[];
  if (f.harness) {
    filter.harness = f.harness.split(',').map((s) => s.trim()).filter(Boolean) as RunHarness[];
  }
  if (f.model) filter.model = f.model.split(',').map((s) => s.trim()).filter(Boolean);
  const tree = await getRunForest(filter);
  console.log(JSON.stringify({ tree }, null, 2));
}

// =============================================
// Memory — durable, reusable knowledge (agent | user | project)
// =============================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a DB-scope owner id from a free-text `owner=`. For `agent` scope an
 * owner is an agent name or id (the run reporter resolves agents by name, so a
 * name is the common case); for `user` scope it is a user id or email.
 */
async function resolveOwnerId(scope: DbMemoryScope, owner: string): Promise<string> {
  if (UUID_RE.test(owner)) return owner;
  if (scope === 'agent') {
    const match = (await getAgents()).find((a) => a.name === owner);
    if (!match) die(`no agent named "${owner}" (pass an agent name or id)`);
    return match.id;
  }
  // user scope: treat a non-uuid as an email.
  const user = await getUserByEmail(owner);
  if (!user) die(`no user with email "${owner}" (pass a user id or email)`);
  return user.id;
}

/** Validate the scope flag, dying on anything outside agent|user|project. */
function parseScope(raw: string | undefined): 'agent' | 'user' | 'project' {
  if (raw === 'agent' || raw === 'user' || raw === 'project') return raw;
  die(`scope must be one of: agent, user, project (got "${raw ?? ''}")`);
}

async function cmdMemoryList(pairs: string[]) {
  const f = parsePairs(pairs);
  const scope = parseScope(f.scope);
  if (scope === 'project') {
    const memories = await listProjectMemories(process.cwd());
    console.log(JSON.stringify({ scope, memories }, null, 2));
    return;
  }
  const owner = f.owner || die('owner=<agent name|id, or user id|email> is required');
  const ownerId = await resolveOwnerId(scope, owner);
  const memories = await listMemories(scope, ownerId);
  console.log(JSON.stringify({ scope, owner_id: ownerId, memories }, null, 2));
}

async function cmdMemoryGet(pairs: string[]) {
  const f = parsePairs(pairs);
  const scope = parseScope(f.scope);
  const slug = f.slug || die('slug=<slug> is required');
  if (scope === 'project') {
    const memory = await getProjectMemory(process.cwd(), slug);
    console.log(JSON.stringify({ scope, memory }, null, 2));
    return;
  }
  const owner = f.owner || die('owner=<agent name|id, or user id|email> is required');
  const ownerId = await resolveOwnerId(scope, owner);
  const memory = await getMemory(scope, ownerId, slug);
  console.log(JSON.stringify({ scope, owner_id: ownerId, memory }, null, 2));
}

async function cmdMemorySet(pairs: string[]) {
  const f = parsePairs(pairs);
  const scope = parseScope(f.scope);
  const slug = f.slug || die('slug=<slug> is required');
  const description = f.description ?? '';
  const content = f.content ?? '';
  if (scope === 'project') {
    const memory = await setProjectMemory(process.cwd(), slug, description, content);
    console.log(JSON.stringify({ scope, memory }, null, 2));
    return;
  }
  const owner = f.owner || die('owner=<agent name|id, or user id|email> is required');
  const ownerId = await resolveOwnerId(scope, owner);
  const memory = await setMemory(scope, ownerId, { slug, description, content });
  console.log(JSON.stringify({ scope, owner_id: ownerId, memory }, null, 2));
}

async function cmdMemoryDelete(pairs: string[]) {
  const f = parsePairs(pairs);
  const scope = parseScope(f.scope);
  const slug = f.slug || die('slug=<slug> is required');
  if (scope === 'project') {
    await deleteProjectMemory(process.cwd(), slug);
    console.log(JSON.stringify({ scope, slug, deleted: true }, null, 2));
    return;
  }
  const owner = f.owner || die('owner=<agent name|id, or user id|email> is required');
  const ownerId = await resolveOwnerId(scope, owner);
  await deleteMemory(scope, ownerId, slug);
  console.log(JSON.stringify({ scope, owner_id: ownerId, slug, deleted: true }, null, 2));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'run-start':
      return cmdRunStart(rest[0] ?? die('usage: run-start <todo_id> [k=v ...]'), rest.slice(1));
    case 'run-heartbeat':
      return cmdRunHeartbeat(rest[0] ?? die('usage: run-heartbeat <run_id> [note]'), rest[1]);
    case 'run-finish':
      return cmdRunFinish(
        rest[0] ?? die('usage: run-finish <run_id> done|failed <summary>'),
        rest[1] ?? die('missing outcome (done|failed)'),
        rest[2] ?? die('missing summary'),
      );
    case 'run-ask':
      return cmdRunAsk(
        rest[0] ?? die('usage: run-ask <run_id> <question>'),
        rest[1] ?? die('missing question'),
      );
    case 'run-answer':
      return cmdRunAnswer(
        rest[0] ?? die('usage: run-answer <run_id> <answer>'),
        rest[1] ?? die('missing answer'),
      );
    case 'run-get':
      return cmdRunGet(rest[0] ?? die('usage: run-get <run_id>'));
    case 'run-messages':
      return cmdRunMessages(rest[0] ?? die('usage: run-messages <run_id>'));
    case 'run-msg-ack':
      return cmdRunMsgAck(
        rest[0] ?? die('usage: run-msg-ack <run_id> <message_id...>'),
        rest.slice(1),
      );
    case 'run-post':
      return cmdRunPost(
        rest[0] ?? die('usage: run-post <run_id> <body>'),
        rest[1] ?? die('missing body'),
      );
    case 'run-tree':
      return cmdRunTree(rest);
    case 'run-tail':
      return shipRunTail(rest[0] ?? die('usage: … | agent-cli run-tail <run_id>'), process.stdin)
        .then(({ rows }) => console.error(`run-tail: shipped ${rows} row(s)`));
    case 'memory-list':
      return cmdMemoryList(rest);
    case 'memory-get':
      return cmdMemoryGet(rest);
    case 'memory-set':
      return cmdMemorySet(rest);
    case 'memory-delete':
      return cmdMemoryDelete(rest);
    default:
      die(
        `unknown command "${cmd ?? ''}" ` +
          `(run-start|run-heartbeat|run-finish|run-ask|run-answer|run-get|` +
          `run-messages|run-msg-ack|run-post|run-tree|run-tail|` +
          `memory-list|memory-get|memory-set|memory-delete)`,
      );
  }
}

/** Best-effort string for any thrown value (Supabase errors are plain objects). */
function errToString(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object') {
    const o = e as Record<string, unknown>;
    if (typeof o.message === 'string') {
      return o.details ? `${o.message} (${o.details})` : o.message;
    }
    return JSON.stringify(e);
  }
  return String(e);
}

main().catch((e) => die(errToString(e)));
