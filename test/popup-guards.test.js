'use strict';

/**
 * Two properties that are invisible in review and expensive in the wild.
 *
 * Both were real bugs, both were found by driving the app rather than by
 * reading it, and both come back the moment someone adds a `send` or a new
 * panel without knowing why these exist. Source assertions are a blunt tool,
 * but they fail on the line that reintroduces the bug, which is the point.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('nothing speaks to a buddy window behind the outbox', () => {
  // A window accepts webContents.send from the moment it exists and throws it
  // away until the page has run its ipcRenderer.on — and Clippy creates a
  // window and describes a card to it in the same tick. That is how the first
  // approval of every session used to vanish while the agent sat holding its
  // hook open. src/outbox.js queues instead; going around it brings the bug
  // back for whichever message went direct.
  const main = read('src', 'main.js');
  const direct = main
    .split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\.win\.webContents\.send\(/.test(line));

  assert.deepEqual(
    direct,
    [],
    `talk to buddies with post()/send(), not webContents.send:\n${direct
      .map(([n, l]) => `  main.js:${n}: ${l.trim()}`)
      .join('\n')}`
  );
});

test('every panel that pops up refuses clicks for a moment', () => {
  // Clippy appears over whatever you were doing, often directly under the
  // pointer, and the button nearest the corner it appears in is the one that
  // says yes. A real, trusted mousedown landing on Allow within a frame of the
  // card appearing is not a hypothetical — it is what testing caught, and it
  // approves a command nobody read.
  const renderer = read('src', 'renderer', 'clippy.js');
  const styles = read('src', 'renderer', 'clippy.css');

  assert.match(renderer, /const ARM_MS = \d+/, 'the arming delay should be a named constant');

  // Each of the three panels that carry an action has to arm as it is shown.
  for (const panel of ['cardEl', 'qcardEl', 'bubbleEl']) {
    assert.match(
      renderer,
      new RegExp(`armPanel\\(${panel}\\)`),
      `${panel} appears without arming — a click already in flight would land on it`
    );
  }

  // …and the class has to actually stop clicks, or arming is decoration.
  assert.match(styles, /\.arming[^{]*\{[^}]*pointer-events:\s*none/s);
  for (const actions of ['#card-actions', '#qcard-actions', '#bubble-actions']) {
    assert.ok(
      new RegExp(`\\.arming\\s+${actions}`).test(styles),
      `${actions} is not covered by the arming rule`
    );
  }
});

test('a held card is handed back when you are already in that window', () => {
  // The three places a session can interrupt you all have to ask first, or the
  // quiet-when-focused promise holds in one of them and not the others.
  const main = read('src', 'main.js');
  for (const handler of ['handlePermissionRequest', 'handleQuestion', 'handleStop']) {
    const body = main.slice(main.indexOf(`async function ${handler}(`));
    assert.match(
      body.slice(0, 2000),
      /await lookingAtIt\(/,
      `${handler} should check whether the user is already looking at that window`
    );
  }
});

test('a question answered in Clippy is not then relayed back as "still waiting"', () => {
  // Codex draws its own picker for request_user_input and leaves it on screen
  // when a PreToolUse hook resolves the call for it. The agent has the answer
  // and carries on, but the CLI still looks as though it is asking and
  // notifies us that it is waiting — which Clippy relayed as "still waiting
  // for your reply", pointing the user at a question it had just answered.
  const main = read('src', 'main.js');
  assert.match(main, /const justAnswered = new Map\(\)/);
  assert.match(main, /justAnswered\.set\(reaction\.sessionId/);
  // …and the suppression has to sit on the passive path, which is where a
  // Notification becomes a bubble and an OS notification.
  const passive = main.slice(main.indexOf('function emitPassive('));
  assert.match(passive.slice(0, 1600), /nudgeIsStale\(reaction\.sessionId\)/);
  // It must expire. A session genuinely left waiting has to be able to say so.
  assert.match(main, /ANSWERED_QUIET_MS/);
  assert.match(main, /Date\.now\(\) - at < ANSWERED_QUIET_MS/);
});

test('only a pane Clippy owns has its stale picker dismissed', () => {
  // Escape into a terminal we do not own would be a keystroke aimed at
  // whatever happens to be focused. A tmux pane Clippy started is the one
  // place it can press a key without touching anyone's focus.
  const main = read('src', 'main.js');
  const fn = main.slice(main.indexOf('function dismissCodexPicker('));
  assert.match(fn.slice(0, 700), /agent !== 'codex'/);
  assert.match(fn.slice(0, 700), /tmuxRecordFor\(sessionId\)/);
  assert.match(fn.slice(0, 700), /'Escape'/);
});

test('every panel has room for what is drawn outside it', () => {
  // A window only a few pixels wider than its panel clips the offset shadow
  // and the stacked sheets — which is what happened to the plan card when the
  // ordinary window grew for the sheets and the plan one did not.
  const buddy = read('src', 'renderer', 'clippy.js');
  const styles = read('src', 'renderer', 'clippy.css');
  const main = read('src', 'main.js');

  const px = (re, text) => Number(re.exec(text)[1]);
  const margin = px(/const WIN_MARGIN = (\d+)/, buddy);
  const panel = px(/--panel-w:\s*(\d+)px/, styles);
  const plan = px(/--plan-w:\s*(\d+)px/, styles);
  const winW = px(/^const WIN_W = (\d+);/m, main);
  const planWin = px(/const PLAN_WIN_W = (\d+) \+ WIN_MARGIN/, buddy);

  assert.equal(winW - panel, margin, 'the ordinary window is its panel plus the margin');
  assert.equal(planWin, plan, 'the plan window is its panel plus the same margin');

  // …and the margin has to actually cover the widest thing drawn out there:
  // two stacked sheets, at their offset plus their own outline.
  const sheet = Math.max(...[...styles.matchAll(/-(\d+)px -\1px 0 0 var\(--ink\)/g)].map((m) => Number(m[1])));
  assert.ok(sheet > 0, 'the stacked sheets should be findable in the styles');
  assert.ok(margin / 2 >= sheet + 2, `each side needs ${sheet + 2}px for the sheets, has ${margin / 2}`);
});

test('a panel is never pushed off the screen to keep the buddy on it', () => {
  // The buddy is 96px wide; the window around him is up to 542. Clamping on
  // *him* — which is what let him be carried up to the menu bar — allowed the
  // window to sit 223px off the left edge with most of the card outside the
  // display. The window's own bounds have to win wherever the window fits.
  const main = read('src', 'main.js');
  const fn = main.slice(main.indexOf('function keepBuddyOnScreen('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  // The window's own range is tried first, and the buddy's is the fallback for
  // an axis where the window cannot fit at all.
  assert.match(body, /const lo = start;/);
  assert.match(body, /const hi = start \+ span - size;/);
  assert.match(body, /if \(lo <= hi\) return clamp\(pos, lo, hi\);/);
  assert.match(body, /centre - half/, 'the buddy-based range should remain as the fallback');
});
