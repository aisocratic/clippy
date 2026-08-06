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

test('fenced code stays literal', () => {
  const html = renderMarkdown('```js\nconst x = "<script>";\n```');
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});
