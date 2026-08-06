#!/usr/bin/env bash
#
# run-codex-ticket.sh — delegate ONE Kanban card to the Codex agent.
#
# Usage:
#   .claude/skills/agent-todo/codex/run-codex-ticket.sh <card-uuid>
#
# What it does (all orchestration runs from the MAIN tree; only the codex
# implementation runs in an isolated worktree):
#   1. Fetches the card from the todos table via todo-cli.
#   2. Creates a git worktree + branch  todo/<short>-<kebab-title>  off main.
#   3. Links node_modules and copies .env.local into the worktree.
#   4. Registers a Codex run (agent-cli run-start kind=codex) for the manager UI.
#   5. Runs `codex exec` in the worktree with CODEX_TODO.md + the card details.
#   6. Finishes the run with the PR url (parsed from codex's last message).
#
# The orchestrator (agent-todo) reads the printed PR_URL / FAILED line and does
# the board writes (status -> review, pr attach, comment). This script does NOT
# move the card on the board.
#
# Optional env:
#   CODEX_MODEL          - model override passed to `codex exec -m`
#   WF_ID / WAVE_RUN_ID  - link the codex run under an orchestrator/wave run
#   CODEX_DRY_RUN=1      - set up the worktree + print the prompt, skip codex
#
set -euo pipefail

CARD_ID="${1:?usage: run-codex-ticket.sh <card-uuid>}"

REPO="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
SKILL_DIR="$REPO/.claude/skills/agent-todo"
RUNBOOK="$SKILL_DIR/codex/CODEX_TODO.md"
TSX=(npx tsx --env-file="$REPO/.env.local" --tsconfig "$REPO/tsconfig.json")
TODO_CLI=(env LOG_LEVEL=warn "${TSX[@]}" "$SKILL_DIR/scripts/todo-cli.ts")
AGENT_CLI=(env LOG_LEVEL=warn "${TSX[@]}" "$SKILL_DIR/scripts/agent-cli.ts")

strip_json() { sed -n '/^[[{]/,$p'; }  # drop npm warning preamble on stdout

echo "==> Fetching card $CARD_ID"
CARD_JSON="$("${TODO_CLI[@]}" get "$CARD_ID" 2>/dev/null | strip_json)"
if [ -z "$CARD_JSON" ]; then
  echo "ERROR: could not fetch card $CARD_ID (use the full UUID)." >&2
  exit 1
fi

read_field() { printf '%s' "$CARD_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin).get('$1') or '')"; }

TITLE="$(read_field title)"
HR="$(read_field needs_human_review)"
ASSIGNEE="$(read_field assignee)"

# Safety gates — never auto-implement frozen or human-owned cards.
if [ "$HR" = "True" ] || [ "$HR" = "true" ]; then
  echo "REFUSING: card is needs_human_review=true (frozen). A human must unlock it." >&2
  exit 2
fi
case "$(printf '%s' "$ASSIGNEE" | tr '[:upper:]' '[:lower:]')" in
  ""|"claude"|"agent-todo"|"codex") : ;;
  *) echo "REFUSING: card is assigned to '$ASSIGNEE' (a human's card)." >&2; exit 2 ;;
esac

SHORT="${CARD_ID:0:8}"
KEBAB="$(printf '%s' "$TITLE" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-40)"
BRANCH="todo/${SHORT}-${KEBAB}"
WT_PARENT="$(cd "$REPO/.." && pwd)/agent-todo-worktrees"
mkdir -p "$WT_PARENT"
WT_DIR="$WT_PARENT/$SHORT"

echo "==> Card: $TITLE"
echo "==> Branch: $BRANCH"
echo "==> Worktree: $WT_DIR"

# Fresh worktree off the latest main.
git -C "$REPO" fetch origin main --quiet || true
if [ -d "$WT_DIR" ] || git -C "$REPO" worktree list --porcelain | grep -qF "$WT_DIR"; then
  echo "==> Worktree already exists, reusing $WT_DIR"
else
  if git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git -C "$REPO" worktree add "$WT_DIR" "$BRANCH"
  else
    git -C "$REPO" worktree add -b "$BRANCH" "$WT_DIR" origin/main
  fi
fi

# The worktree lacks deps/env that build & tests need.
ln -sfn "$REPO/node_modules" "$WT_DIR/node_modules"
[ -f "$REPO/.env.local" ] && cp "$REPO/.env.local" "$WT_DIR/.env.local" || true

# Codex auto-loads AGENTS.md (not CLAUDE.md). If the repo hasn't committed one,
# drop a thin AGENTS.md in the worktree that pulls in CLAUDE.md so the project
# conventions are in Codex's context automatically (untracked; ignore on commit).
if [ ! -e "$WT_DIR/AGENTS.md" ] && [ -f "$WT_DIR/CLAUDE.md" ]; then
  {
    echo "# AGENTS.md"
    echo
    echo "Project conventions for coding agents live in **CLAUDE.md** (repo root)."
    echo "Read and follow it before making changes. For admin UI work also read"
    echo "\`docs/UI_GUIDELINES.md\`. Key rules: never run a web server"
    echo "(\`pnpm dev\`/\`build\`/\`start\`); verify with \`pnpm lint\` and \`pnpm test\`."
  } > "$WT_DIR/AGENTS.md"
fi

# Build the prompt: runbook + the concrete card.
DESC="$(read_field description)"
PROMPT_FILE="$(mktemp -t codex-ticket-XXXX.md)"
{
  cat "$RUNBOOK"
  echo
  echo "---"
  echo
  echo "## YOUR CARD"
  echo
  echo "- **card-id:** $CARD_ID"
  echo "- **branch (already checked out):** $BRANCH"
  echo "- **title:** $TITLE"
  echo
  echo "### Description / acceptance criteria"
  echo
  printf '%s\n' "$DESC"
} > "$PROMPT_FILE"

if [ "${CODEX_DRY_RUN:-}" = "1" ]; then
  echo "==> DRY RUN — prompt written to $PROMPT_FILE"
  echo "==> Worktree ready at $WT_DIR (branch $BRANCH). Skipping codex."
  exit 0
fi

# Register the Codex run for the manager UI run tree.
RUN_ARGS=(run-start "$CARD_ID" agent="codex" kind=codex harness=codex)
[ -n "${CODEX_MODEL:-}" ] && RUN_ARGS+=(model="$CODEX_MODEL")
[ -n "${WF_ID:-}" ] && RUN_ARGS+=(workflow_run_id="$WF_ID")
[ -n "${WAVE_RUN_ID:-}" ] && RUN_ARGS+=(parent_run_id="$WAVE_RUN_ID")
RUN_ID="$("${AGENT_CLI[@]}" "${RUN_ARGS[@]}" 2>/dev/null | strip_json | python3 -c 'import sys,json;print(json.load(sys.stdin).get("run_id",""))' || true)"
echo "==> Codex run_id: ${RUN_ID:-<none>}"

LAST_MSG="$(mktemp -t codex-last-XXXX.txt)"
CODEX_ARGS=(exec --cd "$WT_DIR" --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -o "$LAST_MSG")
[ -n "${CODEX_MODEL:-}" ] && CODEX_ARGS+=(-m "$CODEX_MODEL")

echo "==> Launching codex exec ..."
set +e
codex "${CODEX_ARGS[@]}" "$(cat "$PROMPT_FILE")"
CODEX_RC=$?
set -e

LAST="$(cat "$LAST_MSG" 2>/dev/null || true)"
PR_URL="$(printf '%s\n' "$LAST" | grep -oE 'PR_URL:[[:space:]]*\S+' | head -1 | sed -E 's/PR_URL:[[:space:]]*//')"
if [ -z "$PR_URL" ]; then
  PR_URL="$(printf '%s\n' "$LAST" | grep -oE 'https://github.com/[^ ]+/pull/[0-9]+' | head -1)"
fi

echo "================ CODEX RESULT ($CARD_ID) ================"
echo "exit_code: $CODEX_RC"
echo "PR_URL: ${PR_URL:-<none>}"
echo "--- codex final message ---"
printf '%s\n' "$LAST"
echo "========================================================"

if [ -n "$RUN_ID" ]; then
  if [ -n "$PR_URL" ]; then
    "${AGENT_CLI[@]}" run-finish "$RUN_ID" done "Codex implemented '$TITLE' — $PR_URL" >/dev/null 2>&1 || true
  else
    "${AGENT_CLI[@]}" run-finish "$RUN_ID" failed "Codex run ended rc=$CODEX_RC with no PR for '$TITLE'" >/dev/null 2>&1 || true
  fi
fi

[ -n "$PR_URL" ] || exit 3
