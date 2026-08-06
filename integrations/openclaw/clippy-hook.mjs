/**
 * Clippy handler for OpenClaw (openclaw.ai) — watch-mode only.
 *
 * OpenClaw loads this from ~/.openclaw/openclaw.json (hooks.internal.handlers,
 * one entry each for the 'message' and 'command' event families — see
 * `clippy-hooks.js install --agent openclaw`). It translates gateway events
 * into the local hook POSTs Clippy already understands, so an OpenClaw session
 * gets a buddy with an activity line and attention nudges.
 *
 * Deliberately dependency-free: this module runs inside OpenClaw's runtime and
 * imports nothing from OpenClaw internals — global fetch only. Every request is
 * fire-and-forget with a 1s timeout: Clippy not running must NEVER affect
 * OpenClaw, so all errors are swallowed.
 */

const CLIPPY = `http://127.0.0.1:${process.env.CLIPPY_PORT || 43117}`;

/** POST a hook event to Clippy without ever waiting on (or failing on) it. */
function post(hook, body) {
  try {
    fetch(`${CLIPPY}/hook/${hook}?source=openclaw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // Clippy holds some hook responses open for interactive agents; we only
      // observe, so give up quickly and never read the body.
      signal: AbortSignal.timeout(1000),
    }).catch(() => {});
  } catch {
    // fetch can throw synchronously (bad env) — OpenClaw must never notice.
  }
}

export default async function clippyHook(event) {
  try {
    const context = event?.context || {};
    const ids = {
      session_id: `openclaw:${event?.sessionKey || context.channelId || 'main'}`,
      agent: 'openclaw',
    };
    // Clippy names the buddy after the cwd's basename; without one it falls
    // back to the session id, so only send cwd when we actually know it.
    if (context.workspaceDir) ids.cwd = context.workspaceDir;

    const name = `${event?.type}:${event?.action}`;
    if (name === 'message:received') {
      // Inbound user message -> buddy goes to work.
      post('UserPromptSubmit', { ...ids, prompt: context.content?.slice(0, 400) });
    } else if (name === 'message:sent') {
      // Agent replied -> done, your turn. Fire-and-forget: Clippy's Stop hook
      // is interactive for Claude, but for OpenClaw we only observe.
      post('Stop', { ...ids });
    } else if (name === 'command:stop') {
      post('SessionEnd', { ...ids });
    }
    // gateway:shutdown intentionally sends nothing per-session — Clippy sweeps
    // stale sessions on its own.
  } catch {
    // Never let a Clippy hiccup surface as an OpenClaw handler error.
  }
}
