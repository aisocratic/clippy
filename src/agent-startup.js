'use strict';

// Both CLIs ask this before accepting input in a folder they have not seen.
const TRUST_PROMPT =
  /trust the files in this folder|yes, i trust this folder|trust the contents of this directory|yes, continue/i;
// Codex may separately ask about hooks. A chat session does not need them:
// Clippy reads the transcript directly, so the safe automatic choice is the
// explicit "continue without trusting" option.
const HOOK_REVIEW_PROMPT = /hooks need review[\s\S]*continue without trusting/i;
const CLAUDE_SURVEY_PROMPT = /how is claude doing this session\?[\s\S]*0:\s*dismiss/i;
// The empty composers. tmux capture-pane strips colour escapes but preserves
// Claude's non-breaking space; Codex draws placeholder text after its glyph.
const AGENT_INPUT_PROMPT = /(?:^|\n)❯[ \u00a0]*(?:\n|$)|(?:^|\n)› (?!\d+\.)/;

function paneStartupState(output) {
  const pane = String(output || '');
  if (TRUST_PROMPT.test(pane)) return 'trust';
  if (HOOK_REVIEW_PROMPT.test(pane)) return 'hooks';
  if (CLAUDE_SURVEY_PROMPT.test(pane)) return 'survey';
  if (AGENT_INPUT_PROMPT.test(pane)) return 'ready';
  return 'starting';
}

/**
 * Wait until Claude can receive a prompt. The caller supplies confirmation
 * only for a workspace Clippy created and owns; project folders remain the
 * user's security decision.
 */
async function prepareAgentWorkspace({
  capture,
  confirmTrust,
  continueWithoutHooks,
  dismissSurvey,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 50,
  intervalMs = 100,
} = {}) {
  let confirmed = false;
  let skippedHooks = false;
  let dismissedSurvey = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let output = '';
    try {
      output = await capture();
    } catch {
      // The pane may not be drawable during its first few milliseconds.
    }
    const state = paneStartupState(output);
    if (state === 'ready') return { ready: true, confirmed };
    if (state === 'trust' && !confirmed) {
      await confirmTrust();
      confirmed = true;
    }
    if (state === 'hooks' && !skippedHooks) {
      await continueWithoutHooks();
      skippedHooks = true;
    }
    if (state === 'survey' && !dismissedSurvey) {
      await dismissSurvey();
      dismissedSurvey = true;
    }
    if (attempt + 1 < attempts) await delay(intervalMs);
  }
  return { ready: false, confirmed };
}

module.exports = {
  TRUST_PROMPT,
  HOOK_REVIEW_PROMPT,
  CLAUDE_SURVEY_PROMPT,
  AGENT_INPUT_PROMPT,
  paneStartupState,
  prepareAgentWorkspace,
};
