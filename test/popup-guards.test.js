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

test('a compact buddy can grow past its fallback size instead of clipping its own controls', () => {
  const main = read('src', 'main.js');
  const fn = main.slice(main.indexOf('function placeBuddy('));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /Math\.max\(compactH, buddy\.compactHeight \|\| compactH\)/);
  assert.match(body, /workArea\.height - WIN_GAP \* 2/);
});

test('the main buddy has an independent size picker and a name-only plate', () => {
  const main = read('src', 'main.js');
  const settings = read('src', 'renderer', 'settings.js');
  const renderer = read('src', 'renderer', 'clippy.js');
  const styles = read('src', 'renderer', 'clippy.css');

  assert.match(main, /soloSize: ''/);
  assert.match(main, /soloSize: \(\) => \['', \.\.\.Object\.keys\(SIZES\)\]/);
  assert.match(settings, /set\('soloSize', sizePick\.value\)/);
  assert.match(renderer, /whoSub\.textContent = solo \? ''/);
  assert.match(styles, /body\.solo #who-sub\s*\{\s*display: none/s);
});

test('all settings select boxes share one custom control treatment', () => {
  const styles = read('src', 'renderer', 'settings.css');
  assert.match(styles, /select\s*\{[\s\S]*appearance: none/);
  assert.match(styles, /select:focus-visible\s*\{[\s\S]*outline: 2px solid var\(--accent\)/);
});

test('an expired card remains recoverable from the menu bar, without reviving stale buttons', () => {
  const main = read('src', 'main.js');
  const renderer = read('src', 'renderer', 'clippy.js');

  // The hook must not be held forever, but losing the card must not lose the
  // route back to the terminal prompt it handed off to.
  assert.match(main, /const attentionInbox = new Map\(\)/);
  assert.match(main, /function moveAttentionToTerminal\(id\)/);
  const permission = main.slice(main.indexOf('async function handlePermissionRequest('));
  const question = main.slice(main.indexOf('async function handleQuestion('));
  assert.match(permission.slice(0, 2600), /rememberAttention\(/);
  assert.match(question.slice(0, 2600), /rememberAttention\(/);
  assert.match(permission.slice(0, 4200), /moveAttentionToTerminal\(id\)/);
  assert.match(question.slice(0, 4200), /moveAttentionToTerminal\(id\)/);

  // The recovery action opens the terminal rather than offering an approval
  // whose original hook promise has already expired.
  const menu = main.slice(main.indexOf('function trayMenu('), main.indexOf('function recentLabel('));
  assert.match(menu, /item\.state === 'terminal'\) openSessionWindow\(item\.sessionId, \{ point: true \}\)/);
  assert.match(main, /Clippy is on —/);
  assert.match(renderer, /case 'open-usage':\s*\{\s*showUsage\(\)/s);
});

test('signing off one review leaves the next queued card on screen', () => {
  const main = read('src', 'main.js');
  const renderer = read('src', 'renderer', 'clippy.js');
  const review = main.slice(main.indexOf('async function resolveReview('));

  // A review is not in the broker, so the explicit cross-window check is what
  // keeps a second review (or an approval) visible after the selected card is
  // dismissed. This matters in both one-buddy and one-per-session modes.
  assert.match(main, /function buddyStillHasCards\(sessionId\)/);
  assert.match(main, /pendingReviews\.values\(\).*buddyOf\(sid\) === buddy/s);
  assert.match(main, /broker\.list\(\).*buddyOf\(entry\.meta\.sessionId\) === buddy/s);
  assert.match(review.slice(0, 1300), /if \(!buddyStillHasCards\(sessionId\)\) hideBuddy\(sessionId\)/);

  // The renderer independently drops only the selected id, then remains at
  // the same queue position where paging had placed the user.
  const decide = renderer.slice(renderer.indexOf('function decide('));
  assert.match(decide.slice(0, 900), /requests\.delete\(activeRequestId\)/);
  assert.match(decide.slice(0, 900), /showNextRequest\(rest\[Math\.min\(at, rest\.length - 1\)\]/);
});

test('the large card keeps its project and title clear of its close button', () => {
  const styles = read('src', 'renderer', 'clippy.css');
  const where = styles.slice(styles.indexOf('#card-where {'));
  assert.match(where.slice(0, 500), /margin: 5px 0/);

  // A long project name or headline must not run under the top-right (x).
  const cornerClearance = styles.slice(styles.indexOf('#pet-head,'), styles.indexOf('/* The corner stack'));
  assert.match(cornerClearance, /#card-where,/);
  assert.match(cornerClearance, /#card-title,/);
});

test('the reader heading is centred clear of the macOS window controls', () => {
  const styles = read('src', 'renderer', 'reader.css');
  const header = styles.slice(styles.indexOf('#head {'), styles.indexOf('#who {'));

  // The native traffic lights occupy the upper-left title-bar area. Keeping
  // equal side clearance means a long reader title still has a real centre.
  assert.match(header, /display:\s*grid/);
  assert.match(header, /justify-items:\s*center/);
  assert.match(header, /padding:\s*10px 88px 9px/);
  assert.match(header, /text-align:\s*center/);
});

test('a review moves into the reader and can safely return or resolve there', () => {
  const main = read('src', 'main.js');
  const preload = read('src', 'preload-reader.js');
  const reader = read('src', 'renderer', 'reader.js');
  const html = read('src', 'renderer', 'reader.html');

  assert.match(main, /if \(payload\.review\) buddyOf\(readerSessionId\)\?\.win\.hide\(\)/);
  assert.match(main, /ipcMain\.on\('clippy-reader-minimize'/);
  assert.match(main, /showBuddy\(readerSessionId\)/);
  assert.match(main, /ipcMain\.on\('clippy-reader-decide'/);
  assert.match(main, /await resolveReview\(id, action, message\)/);
  assert.match(main, /kind: 'request-closed'/);
  assert.match(preload, /minimize: \(\) => ipcRenderer\.send\('clippy-reader-minimize'\)/);
  assert.match(preload, /decide: \(action, message = ''\)/);
  assert.match(html, /id="reply-input"/);
  assert.match(html, /id="reader-good">Looks good/);
  assert.match(reader, /window\.readerAPI\.decide\('feedback'/);
  assert.match(reader, /window\.readerAPI\.decide\('ok'\)/);
});

test('the under-Clippy activity preview opens complete entries in a reader window', () => {
  const renderer = read('src', 'renderer', 'clippy.js');
  const styles = read('src', 'renderer', 'clippy.css');
  const preload = read('src', 'preload.js');
  const main = read('src', 'main.js');

  assert.match(renderer, /const DEEDS_PREVIEW = 2/);
  assert.match(renderer, /deeds\.slice\(0, DEEDS_PREVIEW\)/);
  assert.match(renderer, /more\.textContent = '\.\.\.'/);
  assert.match(renderer, /function openDeed\(deed\)/);
  assert.match(renderer, /function openAllDeeds\(\)/);
  assert.match(renderer, /window\.clippyAPI\.openActivityReader\(/);
  assert.match(preload, /openActivityReader: \(title, text\)/);
  assert.match(main, /ipcMain\.on\('clippy-open-activity-reader'/);
  assert.match(main, /openReader\(\{[\s\S]*?title,[\s\S]*?where: buddy\.name,[\s\S]*?text,[\s\S]*?sessionId,/);
  assert.match(styles, /\.deed-what\s*\{[\s\S]*font-size: 9px/);
  assert.match(styles, /\.deed-meta\s*\{[\s\S]*font-size: 8px/);
  assert.match(styles, /\.deed:focus-visible/);
});

test('a packaged DMG build checks for a verified update without downloading it silently', () => {
  const main = read('src', 'main.js');
  const updater = read('src', 'auto-update.js');
  assert.match(main, /function checkForAutomaticUpdate\(\)/);
  assert.match(main, /setInterval\(\(\) => checkForAutomaticUpdate/);
  assert.match(main, /openSettingsWindow\('updates'\)/);
  assert.match(updater, /release\?\.dmg \|\| !release\?\.checksum/);
  assert.match(updater, /downloaded update failed its checksum/);
  assert.match(updater, /wrong app identity/);
});

test('each popup stack reflects its own queue and never draws more than three cards', () => {
  const renderer = read('src', 'renderer', 'clippy.js');
  const stack = renderer.slice(renderer.indexOf('function showStack()'));

  // Card and bubble queues are distinct: a passive nudge cannot make an
  // approval card look like it has extra sheets behind it.
  assert.match(stack.slice(0, 1200), /setDepth\(cardEl, requests\.size\)/);
  assert.match(stack.slice(0, 1200), /setDepth\(bubbleEl, \[\.\.\.pending\.values\(\)\]/);
  // The front card plus two backing sheets is the hard visual cap.
  assert.match(stack.slice(0, 1200), /Math\.min\(3, Math\.max\(1, count\)\)/);
  assert.match(stack.slice(0, 1200), /shown >= 2/);
  assert.match(stack.slice(0, 1200), /shown >= 3/);
});
