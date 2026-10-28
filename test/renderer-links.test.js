'use strict';

/**
 * Every window that renders text an agent wrote has to deal with the links in
 * it, and there are only two ways that ends well: the link opens in a browser,
 * or it does nothing. What must never happen is the window itself following it
 * — a Clippy renderer carries a preload that can approve a permission request
 * or type a prompt into a terminal, and that bridge is re-attached wherever the
 * document lands. Main refuses the navigation (lockDownNavigation), so this is
 * about the half in front of it: the anchors are https-only, and each window
 * hands them somewhere that leads out.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

test('only an https link is ever written into rendered markdown', () => {
  const markdown = read('src', 'renderer', 'markdown.js');
  // The one place an <a> is built, and the guard it is built behind.
  assert.match(markdown, /const safe = safeHttpsUrl\(href\);\s*\n\s*if \(!safe\) return match;/);
  assert.match(markdown, /url\.protocol === 'https:'/);
  assert.equal(
    (markdown.match(/<a href=/g) || []).length,
    1,
    'a second way to write an anchor is a second thing to keep https-only'
  );
});

test('both reading windows send those links out rather than following them', () => {
  for (const [file, escape] of [
    ['clippy.js', /window\.clippyAPI\.openExternal\(link\.href\)/],
    // The reader's bridge has no openExternal, so it uses the other door main
    // leaves open: setWindowOpenHandler passes https to the browser and denies
    // the window. Without this the links in the one window built for reading a
    // long answer simply did nothing.
    ['reader.js', /window\.open\(link\.href, '_blank', 'noopener'\)/],
  ]) {
    const source = read('src', 'renderer', file);
    assert.match(source, /a\[data-clippy-external\]/, `${file} should catch the rendered anchors`);
    assert.match(source, /event\.preventDefault\(\)/, `${file} must not let the click navigate`);
    assert.match(source, escape, `${file} should hand the link out`);
  }
});
