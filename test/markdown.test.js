'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { renderMarkdown, safeHttpsUrl } = require('../src/renderer/markdown');

test('renders the Markdown used in agent summaries', () => {
  const html = renderMarkdown([
    '## Shipped',
    '',
    '- **safe** rendering',
    '- `larger` cards',
    '',
    '> Ready for review.',
  ].join('\n'));

  assert.match(html, /<h2>Shipped<\/h2>/);
  assert.match(html, /<ul><li><strong>safe<\/strong> rendering<\/li>/);
  assert.match(html, /<code>larger<\/code>/);
  assert.match(html, /<blockquote><p>Ready for review\.<\/p><\/blockquote>/);
});

test('escapes HTML and refuses executable or non-https links', () => {
  const html = renderMarkdown([
    '<img src=x onerror=alert(1)>',
    '[bad](javascript:alert(1))',
    '[local](file:///etc/passwd)',
    '[good](https://example.com/a_b_c/docs?q=1)',
  ].join('\n'));

  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /href="file:/);
  assert.match(html, /href="https:\/\/example\.com\/a_b_c\/docs\?q=1"/);
  assert.doesNotMatch(html, /href="[^"]*<em>/);
  assert.equal(safeHttpsUrl('http://example.com'), '');
});

test('pathological input renders instead of throwing', () => {
  // Every `>` is one more level of blockquote, and nothing caps what an agent
  // writes: twelve thousand of them used to overflow the stack, and the throw
  // came out of whichever card was mid-render. The rest of these are the runs
  // that would give a backtracking renderer trouble.
  const nested = renderMarkdown(`${'>'.repeat(50000)} deep`);
  assert.match(nested, /<blockquote>/);
  assert.match(nested, /&gt;/, 'the quoting past the cap is shown, escaped, not run');

  for (const pathological of [
    '*'.repeat(20000),
    '_'.repeat(20000),
    '`'.repeat(20000),
    `${'['.repeat(5000)}](https://example.com)`,
    `-${' '.repeat(50000)}`,
    '**a'.repeat(10000),
  ]) {
    const started = Date.now();
    renderMarkdown(pathological);
    assert.ok(Date.now() - started < 1000, `slow on ${pathological.slice(0, 8)}…`);
  }
});

test('agent text cannot speak the placeholder language', () => {
  // Code spans and links are lifted out as NUL-wrapped placeholders while
  // emphasis is substituted around them. A NUL in the source would name a slot
  // it never created, so it never gets that far.
  const nul = String.fromCharCode(0);
  const html = renderMarkdown(`\`safe\` and ${nul}TOKEN0${nul}`);
  assert.match(html, /<code>safe<\/code>/);
  assert.equal(html.includes(nul), false);
  assert.equal((html.match(/<code>/g) || []).length, 1, 'the placeholder was not honoured twice');
});

test('fenced code stays literal', () => {
  const html = renderMarkdown('```js\nconst x = "<script>";\n```');
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
