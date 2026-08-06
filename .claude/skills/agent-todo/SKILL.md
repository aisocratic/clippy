---
name: agent-todo
description: Read open epics and tasks from the admin Kanban board (/admin/todo) and autonomously implement them. Builds a dependency-ordered plan, runs independent tasks in parallel via isolated agents and workflows, takes each task through to a PR, and either merges (if the card's automerge is on) or leaves it in review for the user. Use when the user says "run the todo board", "work the todos", "agent-todo", "pick up the open tasks", or wants the Kanban backlog executed.
---

# agent-todo

Execute the open work on the admin Kanban board end-to-end: read the cards, plan
around dependencies, implement each task on its own branch, open a PR, and
merge-or-wait per the card's `automerge` flag.

When reading a task, you also need to have read the parent `epic` or any dependencies it has, so you have the full context and can implement it.
Prepare a plan and execute it with a fresh context. So if you work on 10 cards, each card can run independently in parallel, with a clear context window.

## Cross-repo install (clippy) — READ THIS FIRST

This skill is installed here from the **website** repo. The board, its CLI
scripts, the `@/lib` code they import, and the DB credentials all live in the
website checkout — NOT in this repo:

```bash
WEBSITE=/Users/federicoulfo/projects/aisocratic/website
```

Rules that override the rest of this document:

1. **Every** `todo-cli.ts` / `agent-cli.ts` invocation below must run with the
   website repo as cwd:

   ```bash
   cd "$WEBSITE" && LOG_LEVEL=warn npx tsx --env-file=.env.local --tsconfig ./tsconfig.json \
     .claude/skills/agent-todo/scripts/todo-cli.ts <command> [args]
   ```

   Wherever the doc says "run from the project root" / "run from the main tree"
   / `--env-file=${args.repo}/.env.local` for these CLIs, substitute the
   **website** checkout (`$WEBSITE`), never this repo.

2. **Implementation happens in THIS repo (clippy).** Branches, commits, and PRs
   target this repo; `REPO=$(git rev-parse --show-toplevel)` here resolves to
   clippy, and that is what you pass to workflows as `args.repo` for the
   *implementation* side. Only board reads/writes and run reporting go through
   `$WEBSITE`.

3. **The board is shared with the website project — scope yourself.** The
   `todos` table has no repo column. Only work leaf tasks that are descendants
   of the top-level epic titled **"Clippy"** (create it with
   `create Clippy type=epic created_by=agent-todo` if it does not exist, and
   file all clippy cards under it). Never pick up, edit, or merge cards outside
   that epic from this repo.

4. `scripts/upload-pr-screenshots.ts` is website-specific — skip the PR
   screenshot upload step unless this repo has its own equivalent.

## Data model (the `todos` table)

Cards (`lib/db/todos.ts`). One card = one row.

- **type**: `epic` › `task` (hierarchy via `parent_id`). Epics are containers;
  **only leaf tasks are units of work**. An epic with no open children is not
  implementable as-is — it must first be broken down into task cards (the
  `board` plan reports these under `needsBreakdown`).
- **status** (Kanban columns): `backlog` → `todo` → `doing` → `review` → `done`,
  plus `wont-do` / `archive`. "Open" = backlog/todo/doing/review. Note: the `doing`
  column is surfaced in the UI as **"In Progress"** — it is the working column. A
  card you pick up moves to `doing` while being worked, then `review` once its PR
  is open.
- **dependencies**: ids of other cards that must land first (cross-links, drawn as
  edges on the board).
- **priority**: 1 low · 2 med · 3 high.
- **pr_url**: the PR opened for this card. **automerge**: if true, merge the PR
  once green; if false, stop at review and wait for the user.
- **needs_human_review**: a hard gate (distinct from `automerge`, which only governs
  the *merge* step). If true, a human must vet this card before any work happens on
  it — see **The `needs_human_review` gate** below. New cards default to `false`.
- **goal_percentage** / **loop_limit**: the card's quality loop. When
  `goal_percentage > 0`, the finished work is scored 0–100 for completion and
  accuracy against the card (an independent verification pass at the end of the
  task); if the score is below `goal_percentage`, the task is re-run — improving
  the SAME branch/PR — until it reaches the goal or `loop_limit` total attempts
  are used. Defaults: `goal_percentage: 0` (no scoring) and `loop_limit: 1`
  (single attempt, no retry loop). See **The verification loop** below.
- **review_status** / **review_feedback**: the human verdict on a card that was in
  Review. The reviewer writes feedback and picks **Approve** or **Request changes**
  in the board UI. **Approve on a card with an open PR keeps it in `review`**,
  pinned at the top of the Review column as "Merging" — the agent merges the PR
  and moves it to `done` (the plan's `readyToMerge` bucket). Approve without a PR
  or Request changes sends the card back to `todo` (the agent queue) — see
  **Acting on review verdicts** below. Moving a card into `review` clears
  `review_status` (a fresh verdict is needed); the feedback text is kept for
  context.
- **assignee**: free-text name of who owns the card. Empty, `claude`, or
  `agent-todo` means the agent may work it. **Any other value is a human's card —
  never pick it up**: don't implement it, don't break it down, don't move it. The
  `board` plan lists these under `humanAssigned`; they still block their
  dependents until the human lands them.
- **created_by**: free-text author of the card. Set it (e.g. `agent-todo`) on every
  card the agent creates, so humans can tell agent-made cards from theirs.
- **Comments** (`todo_comments` table; `comment_count` on each card): a per-card
  chronological log written by humans and agents. **Use it as the card's working
  memory** — see **Card comments as the work log** below.

## Acting on review verdicts

When a `todo` card carries a verdict, it is **not** fresh work — it's the human's
answer on work you already submitted:

- **`review_status: 'approved'`** (and a `pr_url`): the human authorized the merge —
  even if `automerge` is false. Merge the PR immediately (squash — see the merge
  step in §4; no CI-watch wait), then move the card to `done`. No re-implementation. The `board` plan surfaces these under
  `readyToMerge` regardless of which open column the card sits in — **process
  `readyToMerge` first on every run**, before scheduling any new work, so an
  approved card is never mistaken for a fresh task. (The board UI pins these to
  the top of the Review column with a "Merging" badge.)
- **`review_status: 'changes_requested'`**: rework the card guided by
  `review_feedback`. Work on the SAME branch/PR (push additional commits — do not
  open a second PR), then move the card back to `review` (which clears the verdict
  for the next round).

## The `needs_human_review` gate

When a card has `needs_human_review: true`, treat it as **work-frozen**:

1. **Do not implement it.** Do not write code, open a PR, spawn a worktree agent, or
   do anything for that card beyond *editing the card itself* (its title, description,
   priority, dependencies, status) and *creating new cards*. Leave the actual work for
   a human to unlock (they clear the flag or move/merge it themselves).
2. **You may still break it down.** A frozen card may legitimately be a grooming/epic
   card whose job is to spawn sub-cards. Creating new cards is allowed.
3. **Inheritance — flagged is sticky.** Every card you create *from* (under, or as a
   breakdown of) a `needs_human_review` card must itself be created with
   `needs_human_review: true`. The freeze propagates down the tree so a human stays in
   the loop on the whole subtree, not just the parent.

So: a frozen card can only ever (a) be edited, or (b) produce more frozen cards. It is
never auto-implemented. Surface frozen cards to the user instead of running them.

## The verification loop (`goal_percentage` / `loop_limit`)

When a card has `goal_percentage > 0`, finishing the implementation is not the end
of the task — the work must *score* at or above the goal:

1. **Verify.** After an implementation attempt completes (PR opened/updated), run an
   independent verification agent that scores the work **0–100** against the card's
   title, description, and acceptance criteria. The score weighs **completion** (is
   every part of the card actually done?) and **accuracy** (is it correct — lint,
   tests, edge cases, conventions, does it really do what the card asks?). The
   verifier must be skeptical: it reads the diff, runs the checks, and deducts for
   anything missing, broken, or only superficially done.
2. **Loop or stop.** If `score >= goal_percentage`, the attempt passes — proceed to
   review/merge as usual. If `score < goal_percentage` and attempts used `<
   loop_limit`, re-run the task: a fresh agent continues on the **same branch/PR**
   (push additional commits, never a second PR), guided by the verifier's findings
   of what is missing or wrong. Then verify again.
3. **Budget exhausted.** After `loop_limit` total attempts, stop looping regardless
   of score. Proceed with the best result, and surface the final score to the user —
   a card that never reached its goal is a signal for human attention, so mention it
   explicitly in the run summary.
4. **Always log.** Leave a card comment per attempt: `attempt N/loop_limit — score
   X% (goal Y%): <one-line verifier summary>`. The thread shows the quality
   trajectory across attempts.

`goal_percentage: 0` (the default) means no verification scoring — the task runs
once and the normal lint/test verification in the implementation prompt is enough.
`loop_limit` caps **total attempts** (1 = the initial attempt only); it only
matters when `goal_percentage > 0`.

## Card comments as the work log

Every card has a comment thread (`todo_comments`) shared by humans and agents — it
is the card's persistent working context. Use `comments <id>` / `comment <id>
<author> <body>` (author: `agent-todo`).

- **Read before working.** When picking up a card, read its comments — they may
  carry decisions, constraints, or context from the user or a previous run.
- **Write at every meaningful step.** Leave a comment when you: start work (branch
  name), open a PR (url + one-line summary + how it was verified), fail (the
  reason), merge, act on a review verdict (what was addressed), or break a card
  down (list the created card ids). Keep entries short — one to three lines.
- Comments never replace status moves or `pr_url` — they accompany them.

## How the agent reads/writes the board

The HTTP API (`/api/admin/todos`) requires an admin session cookie, so it is not
usable headlessly. Use the bundled CLI instead — it talks to the database with the
service-role key. **Always run it from the project root** with these flags (the
`@/` alias, `.env.local`, and `LOG_LEVEL=warn`-clean JSON all depend on them):

```bash
cd "$WEBSITE" && LOG_LEVEL=warn npx tsx --env-file=.env.local --tsconfig ./tsconfig.json \
  .claude/skills/agent-todo/scripts/todo-cli.ts <command> [args]
```

Commands:

| Command | Effect |
|---|---|
| `board` | Open cards + edges + a dependency-ordered `plan` (waves / inProgress / blocked / needsBreakdown) as JSON |
| `get <id>` | One card as JSON |
| `status <id> <status>` | Move a card to a column |
| `pr <id> <url>` | Attach a PR url to a card |
| `set <id> k=v [k=v...]` | Patch fields (`status`, `pr_url`, `automerge`, `needs_human_review`, `goal_percentage`, `loop_limit`, `priority`, `assignee`, `title`, `description`, `effort`, `model`, `subtasks_effort`, `subtasks_model`) |
| `create <title> [k=v...]` | Create a card. Fields: `description`, `type` (task\|epic), `priority`, `status`, `parent_id`, `dependencies` (comma-separated ids), `automerge`, `needs_human_review`, `goal_percentage`, `loop_limit`, `created_by`, `assignee`, `effort`, `model`, `subtasks_effort`, `subtasks_model` |
| `comments <id>` | All comments on a card, chronological, as JSON |
| `comment <id> <author> <body>` | Append a comment / log entry to a card |

> When creating cards, always set `created_by=agent-todo`. **When the parent/source
> card has `needs_human_review: true`, pass `needs_human_review=true` on every card
> you create** (see the gate above).

### Linking a card for the user

A single card opens directly in the board UI at:

```
https://aisocratic.org/admin/todo/cards?card=<card-id>
```

Use the **full** card id (the UUID, not the 8-char prefix). **Whenever you surface a
specific card to the user** — a frozen `needs_human_review` card awaiting their unlock,
a card you filed for them, a PR left in review, a blocked/needs-scope epic, or anything
you ask them to look at — give this deep link so they can open it in one click, rather
than just naming the card or pointing at the board root.

`board`'s `plan` is the source of truth for scheduling (wave/inProgress entries
include `needs_human_review`, `review_status`, `review_feedback`, and the
execution-policy fields `effort`, `model`, `subtasks_effort`, `subtasks_model`,
so you can filter frozen cards, route verdicts, and resolve which model/effort
to run each card with — straight from the plan):
- `waves` — arrays of actionable leaf tasks (backlog/todo). **All tasks in one wave
  are independent and run in parallel; waves run in order** because a later wave's
  tasks depend on earlier ones.
- `inProgress` — leaf tasks already in doing ("In Progress") / review; skip unless the user asks.
- `blocked` — actionable tasks stuck behind a non-leaf, a dependency cycle, or an
  epic that hasn't been broken down yet; report them, don't run them.
- `needsBreakdown` — open epics with no open children. Not implementable as-is:
  decompose each into task cards (`create` with `parent_id=<epic id>`), guided by
  the epic's description and comments. Until broken down, the epic blocks anything
  that depends on it.
- `humanAssigned` — queued cards assigned to a person (assignee set and not
  `claude`/`agent-todo`). **Never work these** — report them and leave them to
  their owner; their dependents stay blocked until the human finishes.
- `readyToMerge` — open cards with a `pr_url` and `review_status: 'approved'`
  (in whatever column the verdict left them). Merge each PR immediately (squash —
  see §4; no CI-watch wait), move the card to `done`, and leave a comment — never
  re-implement. Handle this bucket before anything else.


## Reporting runs (the run reporter)

Every agent in the loop reports its activity as a **run** so the manager UI
(/admin/todo agents view, `GET /api/admin/agents/runs?view=tree`) can render the
live run tree: **orchestrator → wave workflow → per-task agents**. Without this
the manager UI stays empty — instrumenting it is not optional.

Runs are reported with a second bundled CLI, `agent-cli.ts`, which (like
`todo-cli`) talks to the database with the service-role key and prints clean
JSON. **Run it from the project root** with the same flags:

```bash
cd "$WEBSITE" && LOG_LEVEL=warn npx tsx --env-file=.env.local --tsconfig ./tsconfig.json \
  .claude/skills/agent-todo/scripts/agent-cli.ts <command> [args]
```

| Command | Effect |
|---|---|
| `run-start <todo_id> [k=v...]` | Register a run for a card **and start it** (queued -> running). Resolves/creates the agent by `agent`/`kind`/`model`, reuses or creates the card's active assignment, persists hierarchy/runtime metadata, prints the new `run_id`. Fields: `agent` (name, default `agent-todo`), `kind` (`claude-code`\|`codex`\|`local-llm`\|`other`), `model` (tier or slug), `harness` (`claude-code`\|`claude-code-headless`\|`workflow-agent`\|`subagent`\|`codex`\|`cron`\|`other`), `parent_run_id`, `workflow_run_id`, `workflow_name`, `session_id`, `host` (default `os.hostname()`), `transcript_path`, `prompt` (the prompt the run executes — set it so the manager UI can show what the agent was asked), `assigned_by` |
| `run-heartbeat <run_id> [note]` | Stamp `heartbeat_at` (revives a stale run). Optional phase/progress `note` (`implement`\|`verify`\|`improve`) is recorded on the run |
| `run-finish <run_id> done\|failed <summary>` | Terminal transition with an outcome summary — **put the PR url in the summary** |
| `run-ask <run_id> <question>` | Pause the run on a human-feedback question (-> needs-feedback) |
| `run-answer <run_id> <answer>` | Answer the pending question and resume (-> running) |
| `run-get <run_id>` | One run as JSON |
| `run-messages <run_id>` | Pending user instructions for the run (and marks them delivered). **Check this between tasks / phases** — the manager UI lets the user steer a live run by posting instructions here |
| `run-msg-ack <run_id> <ids...>` | Ack instructions you acted on |
| `run-post <run_id> <body>` | Post a note back to the user (shows in the run drawer's message thread) |
| `run-tree [k=v...]` | The run forest as JSON (`{ tree }`); filters: `todo_id`, `agent_id`, `workflow_run_id`, `parent_run_id`, `state`, `model`, `harness` |
| `memory-list scope=<s> [owner=<id-or-name>]` | List memories for a scope as JSON. `scope`: `agent`\|`user`\|`project`. agent/user need an `owner` (agent name\|id, or user id\|email); project reads the repo files |
| `memory-get scope=<s> slug=<slug> [owner=<id-or-name>]` | One memory as JSON (or null) |
| `memory-set scope=<s> slug=<slug> [owner=<id-or-name>] [description=<one-line>] [content=<body>]` | Upsert a fact (one per slug). agent/user write the DB; project writes `.claude/memory/<slug>.md` and regenerates the index |
| `memory-delete scope=<s> slug=<slug> [owner=<id-or-name>]` | Remove a fact |

**How the tree is built (do this on every run):**

1. **Orchestrator run.** At preflight (step 0), register *yourself* — the
   agent-todo orchestrator — with `run-start` against the first card you pick up,
   `agent=agent-todo-orchestrator harness=claude-code`, and a fresh
   `workflow_run_id` you mint for this whole invocation (e.g.
   `agent-todo-$(date +%s)`). Capture the printed `run_id` as `ORCH_RUN_ID` and
   reuse the same `workflow_run_id` (call it `WF_ID`) for every run below — it is
   what groups the forest.
2. **Wave-workflow run.** Before dispatching each wave's Workflow, register a run
   for the wave with `parent_run_id=$ORCH_RUN_ID workflow_run_id=$WF_ID
   harness=workflow-agent agent=agent-todo-wave`. Capture it as `WAVE_RUN_ID`.
3. **Per-task agent runs.** Pass `WAVE_RUN_ID` and `WF_ID` *into* the Workflow's
   `args` so each task agent calls `run-start <its todo_id>
   parent_run_id=$WAVE_RUN_ID workflow_run_id=$WF_ID harness=workflow-agent
   agent=task:<short> model=<resolved model>` at the top of its prompt, captures
   its own `run_id`, **heartbeats on each phase transition**
   (`run-heartbeat <run_id> implement` -> `... verify` -> `... improve`), and
   finishes with `run-finish <run_id> done|failed "<summary incl. PR url>"`.

Because the per-task agents run in worktrees **without `.env.local`/`node_modules`**,
their `run-*` calls must run from the main tree (`${args.repo}` — symlink/copy
creds in per the wave setup, or shell out with
`--env-file=${args.repo}/.env.local`). If a worktree agent cannot report its own
run, the orchestrator records the child run on its behalf from the main tree
using the structured result it returns. **All run reporting, like all `todo-cli`
DB writes, can always be done from the main tree.**

## Memory (knowledge that survives a run)

Agents accumulate and reuse knowledge across runs in **three scopes**, each a
slug + one-line `description` (the recall key) + `content` body:

- **agent** — an agent's *personal* cross-run history: approaches that worked,
  mistakes to avoid, per-agent conventions. DB-backed, keyed to the agent.
- **user** — the human's preferences/profile: review patterns, copy-voice,
  automerge habits, standing instructions. DB-backed, shared by **all** agents.
- **project** — anything project-specific. Repo markdown under `.claude/memory/`
  (+ a generated `index.md`), versioned with git so changes ride PRs and get
  reviewed like code. CLAUDE.md stays the curated instruction set; project
  memory is the append-friendly layer beside it.

Read/write memory with the same `agent-cli.ts` (`memory-list`/`-get`/`-set`/
`-delete`, `scope=agent|user|project`) — see the command table above.

**Inject relevant memories at run-start (do this every invocation):** right
after opening the orchestrator run, pull the context the loop should carry —
the user's standing preferences (shared by every agent), this orchestrator
agent's own learnings, and the project-memory index:

```bash
agent-cli memory-list scope=user  owner=<your user id or email>
agent-cli memory-list scope=agent owner=agent-todo-orchestrator
agent-cli memory-list scope=project   # scan descriptions, memory-get relevant slugs
```

Fold the returned descriptions/bodies into your planning and into each task
agent's prompt (the agent's own memories + the user's + any relevant project
facts). Per-task agents can likewise `memory-list scope=agent owner=task:<short>`
for their own slice before working.

**Write durable learnings at run-finish:** when a run ends, persist anything
worth reusing — keep it one fact per slug, overwriting in place:

- A reusable, agent-specific lesson (a convention, a recurring fix) →
  `memory-set scope=agent owner=<agent name> slug=<slug> description="…" content="…"`.
- A standing user preference you were told or inferred →
  `memory-set scope=user owner=<user id/email> slug=<slug> description="…" content="…"`.
- A durable project fact (a gotcha, a decision) → `memory-set scope=project
  slug=<slug> …`, then **commit the new/changed `.claude/memory/*.md` on the
  card's branch** so it rides the PR and is reviewed like code.

A learning saved by one run is then visible in the manager UI's Memory tab and
re-injected on the next run; a user preference saved once is injected for every
agent.

## Execution policy (model + effort)

Each card carries four optional fields that say how it — and its subtasks —
should run. **`lib/agents/model-policy.ts` is the single source of truth**; never
hardcode model slugs or precedence here.

- `effort` — `low` | `mid` | `high` | null: reasoning/verification budget for
  THIS card. Reflect it in the agent prompt (more effort ⇒ verify more / loop
  harder).
- `model` — a tier (`low`|`mid`|`high`) or a concrete slug (`fable-5`,
  `opus-4.8`, `sonnet-4.6`, `haiku-4.5`), or null. The tier→model map lives in
  the resolver.
- `subtasks_effort` / `subtasks_model` — the policy for this card's CHILDREN:
  null = unconstrained (you pick), a tier/slug, or a **relative policy**: `same`
  (inherit the parent's effective value) or `same_lower` (inherit but cap —
  children may use the parent's tier or anything cheaper; the don't-overspend
  option).

**When fanning out a card, resolve its model/effort with the resolver and pass
the resolved model to the Workflow `agent()` `opts.model`.** Import
`resolveExecution(card, parent)` from `@/lib/agents/model-policy`; precedence is
explicit-field-on-card → parent's `subtasks_*` policy → null (caller default).
Look up the card's parent in `board`'s `nodes` (by `parent_id`) and pass it as
the second arg so relative policies and `same_lower` clamping resolve correctly.
A null `model` means "no constraint" — omit `opts.model` and let the harness
default stand.

## Procedure

### 0. Preflight
- Confirm `gh auth status` is logged in and `.env.local` exists.
- Note the current branch and that the tree is clean enough to branch from; do all
  work on branches off `main` (or the repo default). **Never run a web server**
  (`pnpm dev`/`build`/`start`) — per project rules the user runs those.
- Capture the repo root: `REPO=$(git rev-parse --show-toplevel)`. The Workflow agents
  run in isolated worktrees that **do not** contain `.env.local` or `node_modules`,
  so every DB write (status/pr) happens here in the main tree, and worktree agents
  must symlink/copy those in (see step 2).
- **Mint a workflow id and open the orchestrator run.** Set `WF_ID=agent-todo-$(date +%s)`
  and, once you pick the first card, register yourself with `agent-cli run-start
  <todo_id> agent=agent-todo-orchestrator harness=claude-code workflow_run_id=$WF_ID
  workflow_name="agent-todo run"`; capture the printed `run_id` as `ORCH_RUN_ID`.
  Reuse `$WF_ID` for every run this invocation spawns, and finish the orchestrator
  run (`run-finish $ORCH_RUN_ID done|failed <summary>`) when the loop ends. See
  **Reporting runs** above for the full tree wiring.

### 1. Read & present the plan
Run `board`. Summarize for the user: the waves (with task titles), what's
in-progress, what's blocked, what's in `needsBreakdown`, what's in `humanAssigned`
(a person's cards — list them but never schedule them), which tasks have
`automerge: true`, which have a quality loop (`goal_percentage > 0`, with their
`loop_limit`), and which have `needs_human_review: true` (these are frozen —
see the gate above; list them but do not schedule them for implementation). If a
wave is large or any card looks destructive/ambiguous, confirm scope before
starting; otherwise proceed (the project's CLAUDE.md biases toward action).

### 1b. Break down childless epics
For each epic in `needsBreakdown` (skipping any the user excluded): read its
description and comments, decompose it into focused task cards via `create`
(`parent_id=<epic id>`, `created_by=agent-todo`, `needs_human_review=true` if the
epic is frozen), wire `dependencies` between the new tasks where ordering matters,
and leave a comment on the epic listing the created card ids. Then re-run `board` —
the new tasks join the waves.

### 2. Execute each wave with a Workflow
**First, drop any `needs_human_review: true` cards from the wave** — they are frozen
and must not be implemented (see the gate above). Leave them where they are and report
them to the user; if one is a grooming card you may instead break it down into new
cards (each created with `needs_human_review: true`). Only the unfrozen cards proceed.

For each wave in order, move its (unfrozen) cards to `doing` (the "In Progress"
column), then run **one Workflow** that
fans out a worktree-isolated agent per task. Worktree isolation lets the agents edit
files in parallel without colliding. The agents do code + git + PR only; they return
structured results, and **this main loop does all `todo-cli` DB writes** afterward.

Before dispatching a card, read its comments (`comments <id>`) and fold anything
relevant into the agent's prompt alongside the description and parent-epic context.

First move the wave's cards to `doing` / "In Progress" and log the pickup (from the
main tree):

```bash
cd "$WEBSITE" && LOG_LEVEL=warn npx tsx --env-file=.env.local --tsconfig ./tsconfig.json \
  .claude/skills/agent-todo/scripts/todo-cli.ts status <id> doing
todo-cli comment <id> agent-todo "Started work on branch <branch>"
```

Open a **wave run** under the orchestrator and pass its id + `$WF_ID` into the
Workflow so each task agent can register a child run:

```bash
WAVE_RUN_ID=$(cd "$WEBSITE" && LOG_LEVEL=warn npx tsx --env-file=.env.local --tsconfig ./tsconfig.json \
  .claude/skills/agent-todo/scripts/agent-cli.ts run-start <any-card-in-wave> \
  agent=agent-todo-wave harness=workflow-agent parent_run_id=$ORCH_RUN_ID \
  workflow_run_id=$WF_ID | python3 -c 'import sys,json;print(json.load(sys.stdin)["run_id"])')
```

Pass `WAVE_RUN_ID`, `WF_ID`, and `REPO` into the Workflow `args` so each task
agent opens its own run with `agent-cli run-start <its todo_id>
parent_run_id=$WAVE_RUN_ID workflow_run_id=$WF_ID harness=workflow-agent
model=<resolved model>` (from the main tree via `--env-file=${args.repo}/.env.local`),
heartbeats on each phase (`run-heartbeat <run_id> implement|verify|improve`), and
calls `run-finish <run_id> done|failed "<summary incl. PR url>"` before returning.
When that wave's tasks all reach a terminal state, `run-finish $WAVE_RUN_ID`.

Then call the **Workflow** tool. Pass the wave (and `REPO`) as `args` and adapt this
script — it is the canonical shape, tune prompts/labels to the actual tasks:

```js
export const meta = {
  name: 'agent-todo-wave',
  description: 'Implement one wave of independent todo tasks in parallel worktrees, each to a PR, looping on a verification score until each card hits its goal_percentage',
  phases: [{ title: 'Implement' }, { title: 'Verify' }],
}

// args = { repo: '/abs/path/to/website',
//          tasks: [{ id, title, description, branch, goalPercentage, loopLimit,
//                    model, effort }] }
//   model/effort are the RESOLVED values from resolveExecution(card, parent)
//   in @/lib/agents/model-policy (run in the main tree before dispatch): model
//   is a concrete slug or null (null ⇒ omit opts.model), effort is low|mid|high
//   or null. Reflect effort in the prompt; pass model to agent() opts.model.
const RESULT = {
  type: 'object',
  required: ['id', 'status'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['done', 'failed'] },
    prUrl: { type: 'string' },
    branch: { type: 'string' },
    summary: { type: 'string' },
    notes: { type: 'string' },
  },
}

const VERDICT = {
  type: 'object',
  required: ['score', 'findings'],
  properties: {
    score: { type: 'number' },   // 0-100: completion + accuracy vs the card
    findings: { type: 'string' }, // what is missing/wrong — feeds the next attempt
  },
}

const setup = (t) => [
  `Setup (run first — the worktree lacks deps/env, which the build & tests need):`,
  `  ln -sfn "${args.repo}/node_modules" node_modules`,
  `  [ -f "${args.repo}/.env.local" ] && cp "${args.repo}/.env.local" .env.local || true`,
].join('\n')

// Effort phrasing the agent prompt reflects (more effort ⇒ verify harder).
const effortLine = (t) =>
  t.effort
    ? `\nEffort: ${t.effort} — ${
        t.effort === 'high'
          ? 'work with high care; verify thoroughly and self-review before opening the PR.'
          : t.effort === 'low'
            ? 'keep it lean and fast; do the minimum to satisfy the card.'
            : 'balance speed and rigor.'
      }`
    : ''

const implementPrompt = (t) => [
  `You are implementing one task from the admin Kanban board. You are in a fresh git worktree off the default branch.`,
  ``,
  `TASK ${t.id}: ${t.title}`,
  t.description ? `\nDetails:\n${t.description}` : '',
  effortLine(t),
  ``,
  setup(t),
  `  git checkout -b ${t.branch}`,
  ``,
  `Then:`,
  `  1. Implement the task. Follow CLAUDE.md and docs/UI_GUIDELINES.md. Keep the change focused on this card only.`,
  `  2. Verify: run \`pnpm lint\` and \`pnpm test\` (vitest). Fix what you broke. If a check cannot run, say so in notes.`,
  `  3. Commit (end the message with: Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>).`,
  `  4. Push: \`git push -u origin ${t.branch}\`.`,
  `  5. If the change is user-visible UI, capture 1-3 demo screenshots of the new feature (Playwright screenshot or the verify flow), upload them with \`npx tsx "${args.repo}/scripts/upload-pr-screenshots.ts" <branch-or-pr-slug> <files...>\` run from the main tree (worktrees lack R2 creds), and put the printed markdown in the PR body under a "## Screenshots" heading. The release sync shows these on the board's Releases column.`,
  `  6. Open a PR into the default branch with \`gh pr create\`. Title = the task. Body: what changed, how verified, screenshots (if UI), "Closes board card ${t.id}", and end with: 🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  ``,
  `Return the PR url (prUrl), the branch, a one-line summary, and status 'done'. If you truly cannot complete it, return status 'failed' with the reason in notes — do NOT open a PR for incomplete work.`,
].join('\n')

const verifyPrompt = (t, r) => [
  `You are a skeptical verifier scoring finished work against a Kanban card. You are in a fresh git worktree off the default branch.`,
  ``,
  `CARD ${t.id}: ${t.title}`,
  t.description ? `\nAcceptance criteria / details:\n${t.description}` : '',
  ``,
  setup(t),
  `  git fetch origin ${r.branch} && git checkout ${r.branch}`,
  ``,
  `Review the full diff vs the default branch (\`git diff origin/main...HEAD\`), run \`pnpm lint\` and \`pnpm test\`, and score the work 0-100:`,
  `  - completion: is EVERY part of the card actually done (not just the easy parts)?`,
  `  - accuracy: is it correct — checks green, edge cases handled, conventions followed, does it really do what the card asks?`,
  `Deduct for anything missing, broken, or only superficially done. Do NOT fix anything — only assess.`,
  `Return { score, findings } — findings is a concrete list of what is missing or wrong (it drives the next improvement attempt; write "nothing" if clean).`,
].join('\n')

const improvePrompt = (t, r, verdict, attempt) => [
  `You are improving an existing implementation of a Kanban card that scored ${verdict.score}% against a goal of ${t.goalPercentage}% (attempt ${attempt}/${t.loopLimit}). You are in a fresh git worktree.`,
  ``,
  `CARD ${t.id}: ${t.title}`,
  t.description ? `\nDetails:\n${t.description}` : '',
  ``,
  `Verifier findings to address:\n${verdict.findings}`,
  ``,
  setup(t),
  `  git fetch origin ${r.branch} && git checkout ${r.branch}`,
  ``,
  `Address the findings on this SAME branch (push additional commits — do NOT open a second PR; the PR is ${r.prUrl ?? 'already open'}). Re-run \`pnpm lint\` and \`pnpm test\`, commit (Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>), and push.`,
  `Return status 'done' with the same prUrl/branch and a one-line summary of what was improved, or 'failed' with the reason in notes.`,
].join('\n')

// Resolved model → agent() opts. Null model = no constraint: omit opts.model
// so the harness default stands. (Effort is reflected in the prompt, not opts.)
const modelOpt = (t) => (t.model ? { model: t.model } : {})

// One task = implement, then (if the card sets a goal) verify-and-improve until
// the score reaches goalPercentage or loopLimit total attempts are used.
const runTask = async (t) => {
  const short = t.id.slice(0, 8)
  let result = await agent(implementPrompt(t), {
    label: `task:${short}`, phase: 'Implement', schema: RESULT, isolation: 'worktree', ...modelOpt(t),
  })
  if (!result || result.status !== 'done' || !(t.goalPercentage > 0)) return result

  const attempts = [] // { attempt, score, findings } per verification round
  for (let attempt = 1; attempt <= (t.loopLimit ?? 1); attempt++) {
    const verdict = await agent(verifyPrompt(t, result), {
      label: `verify:${short}#${attempt}`, phase: 'Verify', schema: VERDICT, isolation: 'worktree', ...modelOpt(t),
    })
    if (!verdict) break // verifier died — keep the work, don't loop blind
    attempts.push({ attempt, score: verdict.score, findings: verdict.findings })
    log(`task ${short}: attempt ${attempt}/${t.loopLimit} scored ${verdict.score}% (goal ${t.goalPercentage}%)`)
    if (verdict.score >= t.goalPercentage || attempt >= (t.loopLimit ?? 1)) break
    const improved = await agent(improvePrompt(t, result, verdict, attempt + 1), {
      label: `task:${short}#${attempt + 1}`, phase: 'Implement', schema: RESULT, isolation: 'worktree', ...modelOpt(t),
    })
    if (improved && improved.status === 'done') result = improved
    else break // improvement attempt failed — keep the best result we have
  }
  return { ...result, attempts, goalPercentage: t.goalPercentage }
}

const results = await parallel(args.tasks.map((t) => () => runTask(t)))
return results.filter(Boolean)
```

Build each task's `branch` as `todo/<first-8-of-id>-<kebab-title>` and pass
`description`, `goalPercentage` (the card's `goal_percentage`), and `loopLimit`
(the card's `loop_limit`) from the card. **Also pass the resolved `model` and
`effort`:** in the main tree, for each card call `resolveExecution(card, parent)`
from `@/lib/agents/model-policy` (parent = the card from `board`'s `nodes` whose
`id === card.parent_id`, or null) and pass the result's `model` (concrete slug
or null) and `effort` into the task — this is where a parent epic's
`subtasks_model` / `subtasks_effort` policy (including `same_lower` clamping)
takes effect. Read the Workflow result when the `<task-notification>` arrives.

### 3. Process results (back in the main tree)
For each returned task result:
- **status `done` with a `prUrl`** → attach it, log it, and move the card to review:
  ```bash
  todo-cli pr <id> <prUrl>
  todo-cli comment <id> agent-todo "PR opened: <prUrl> — <summary>; verified via <checks>"
  todo-cli status <id> review
  ```
- **status `failed`** → move the card back to `todo`, leave a comment with the
  failure reason (from `notes`), and report it to the user. Don't fabricate a PR.
- **verification loop ran** (the result carries `attempts`) → log the trajectory,
  one comment per attempt:
  ```bash
  todo-cli comment <id> agent-todo "attempt <n>/<loop_limit> — score <score>% (goal <goal>%): <findings one-liner>"
  ```
  If the final score is still below `goal_percentage` (the loop budget ran out),
  say so in that comment and flag the card explicitly in the run summary — it
  shipped at its best score, not its goal, and deserves human eyes.

### 4. Merge or wait (per card) — THE MERGE GATE
One gate, two paths. The daemon applies `evaluateMergeGate()`
(`lib/agents/merge-gate.ts`) immediately before `gh pr merge`; you apply the same
clauses by hand. There are no per-PR CI checks to lean on (`docs/CI-CD.md`), so
these clauses ARE the gate. Merge **iff all** of:

1. `automerge: true` **AND** `needs_human_review: false` — an AND, not an or. And
   never set or clear either flag (nor `goal_percentage` / `loop_limit`) to make a
   merge possible: they are the human's, and an agent granting itself merge
   authority is the one failure this gate exists to prevent.
2. The final attempt's verification verdict is a **pass** (`approve`) with no
   blocking finding — a secret in the diff, a migration claimed as applied, a test
   deleted or disabled to make a check pass, work well beyond the card, or code that
   writes the board's authority flags / merges its own PR.
3. `score >= goal_percentage` when the card sets one, else `>= 80`
   (`runner_settings.review_merge_floor`). `goal_percentage: 0` means "use the
   operator's floor", **not** "no bar".
4. `pnpm typecheck`, eslint and vitest were all **run and green** on the branch's
   final head. A check you did not run counts as FAILED — never infer green.
5. The card carries **no sticky `block`**:
   `curl -s "$SITE/api/admin/agents/todos/<id>/reviews"` → a non-empty
   `blockingReviewIds` means DO NOT MERGE. Only a human clears a block
   (`POST /api/admin/agents/reviews/<review-id>/clear-block`, recorded as a
   `review-block-cleared: <review-id>` card comment). No endpoint reachable? Read
   the card comments instead: an `agent-reviewer` comment containing `verdict block`
   with no later `review-block-cleared:` line naming that review IS a block. Say so
   in your summary; never merge around it, and never clear it yourself.

- **merge** (every clause above holds) → merge immediately, then mark the card done:
  ```bash
  gh pr merge <prUrl> --squash --delete-branch
  todo-cli status <id> done
  todo-cli comment <id> agent-todo "Merged <prUrl> — verdict approve at <score>% (floor <floor>%), typecheck/lint/test green"
  ```
  **Do not poll `gh pr checks --watch` or use `--auto`.** This repo runs no per-PR
  checks — lint/type-check/unit/build run only at *release* time, and even there CI
  is advisory (`docs/CI-CD.md`). Your own typecheck + eslint + vitest run on this
  exact head IS the check suite, and it is already in hand: waiting on GitHub
  Actions re-pays for a signal you already hold (historically the single biggest
  source of agent-PR-to-merge latency). If `gh pr merge` reports a *real* blocker
  (merge conflict, or a check GitHub genuinely requires), resolve the conflict or
  leave the card for the user — don't sit in a `--watch` loop.
- **wait** (any clause fails) → leave the card in `review` with its PR attached,
  name the failing clause in the card comment and in your summary, and let the user
  decide. A human's board approval (Approve in the UI) waives clauses 2–4 — a person
  looked — and, being an attended decision, clauses 1 too; it does **not** clear a
  sticky `block`. When they Approve it, the card shows as "Merging" at the top of
  Review and lands in `readyToMerge` for the next run.

And be honest in the summary: this is a **quality** gate, not a security boundary
(same box, same credentials, and a rubber-stamping reviewer merges). What makes it
worth having: the verdict and the raw check output are persisted for audit, a
`block` is sticky until a human clears it, and a merge to `main` does not deploy —
prod ships only from an explicit release.

### 5. Next wave
Once a wave's tasks reach review/done (their dependents are now unblocked), re-run
`board` and repeat from step 2 for the next wave until `waves` is empty. Finish with a
summary: per card — branch, PR url, merged vs. awaiting-review, the verification score
vs. goal (when the card set one, including cards that exhausted `loop_limit` below
goal), and anything blocked or failed.

## Notes & guardrails
- **One PR per task card.** Keep each change scoped to its card so reviews and merges
  stay independent.
- **DB writes only from the main tree.** Worktrees lack `.env.local`; the CLI won't
  authenticate there.
- **Parallelism = within a wave.** Never run a later wave before its prerequisite wave
  is in review/done, or dependents will build on missing work.
- **Don't touch `inProgress` cards** unless asked — someone (or a prior run) owns them.
- **Don't touch `humanAssigned` cards.** A card assigned to a person belongs to them;
  the agent only works cards that are unassigned or assigned to `claude`/`agent-todo`.
- **Leave a comment trail.** Every state change you make (pickup, PR, failure, merge,
  rework, breakdown) gets a short `comment` as `agent-todo`, and you read a card's
  comments before working it. The thread is the shared memory between humans and runs.
- **Respect `needs_human_review`.** Never implement a frozen card. It may only be
  edited or broken down into more frozen cards (`needs_human_review: true` is inherited
  by every card created from it). A human unlocks it.
- If `gh` or the DB CLI fails twice, stop and surface the error rather than retrying
  blindly.
