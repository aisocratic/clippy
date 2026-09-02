'use strict';

(function exposeMarkdown(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ClippyMarkdown = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const escapeHtml = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const safeHttpsUrl = (value) => {
    try {
      const url = new URL(String(value));
      return url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  };

  /**
   * Code spans and links are lifted out into `\u0000TOKEN<n>\u0000` placeholders
   * while emphasis is substituted around them, and escapeHtml runs in between —
   * so a NUL that arrived in the text would name a slot it never created. This
   * is agent-written text; it does not get to speak the substitution language.
   */
  const clean = (value) => String(value ?? '').replace(/\u0000/g, '');

  function renderInline(value) {
    const tokens = [];
    let text = clean(value).replace(/`([^`\n]+)`/g, (_match, contents) => {
      const slot = tokens.push(`<code>${escapeHtml(contents)}</code>`) - 1;
      return `\u0000TOKEN${slot}\u0000`;
    });

    // Protect generated anchors before emphasis substitutions. Otherwise an
    // underscore in a perfectly ordinary URL could be mistaken for italics
    // inside the href attribute.
    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
      const safe = safeHttpsUrl(href);
      if (!safe) return match;
      const slot = tokens.push(
        `<a href="${escapeHtml(safe)}" data-clippy-external="true">${renderInline(label)}</a>`
      ) - 1;
      return `\u0000TOKEN${slot}\u0000`;
    });
    text = escapeHtml(text);
    text = text
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');

    return text.replace(/\u0000TOKEN(\d+)\u0000/g, (_match, index) => tokens[Number(index)] || '');
  }

  const isBlockStart = (line) =>
    /^\s*$/.test(line) ||
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*[-+*]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line);

  /**
   * How deep blockquotes may nest before the rest is drawn flat.
   *
   * Every `>` on a line is one more recursive renderMarkdown, and nothing caps
   * what an agent writes: a few thousand of them overflowed the stack, and the
   * throw came out of whichever card was being drawn — leaving it half-built
   * and taking the rest of that event's render with it. Past this the body is
   * escaped and shown as it stands, which is all a reader wanted from it.
   */
  const MAX_QUOTE_DEPTH = 16;

  function renderMarkdown(value, depth = 0) {
    const lines = clean(value).replace(/\r\n?/g, '\n').split('\n');
    const html = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i++;
        continue;
      }

      const fence = line.match(/^```\s*([\w-]*)\s*$/);
      if (fence) {
        const body = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
        if (i < lines.length) i++;
        const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : '';
        html.push(`<pre><code${language}>${escapeHtml(body.join('\n'))}</code></pre>`);
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const level = heading[1].length;
        html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        i++;
        continue;
      }

      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        html.push('<hr>');
        i++;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quote = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quote.push(lines[i++].replace(/^>\s?/, ''));
        }
        const body = quote.join('\n');
        const inside =
          depth < MAX_QUOTE_DEPTH
            ? renderMarkdown(body, depth + 1)
            : `<p>${escapeHtml(body)}</p>`;
        html.push(`<blockquote>${inside}</blockquote>`);
        continue;
      }

      const list = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
      if (list) {
        const ordered = /^\d/.test(list[1]);
        const tag = ordered ? 'ol' : 'ul';
        const items = [];
        const pattern = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-+*]\s+(.+)$/;
        while (i < lines.length) {
          const item = lines[i].match(pattern);
          if (!item) break;
          items.push(`<li>${renderInline(item[1])}</li>`);
          i++;
        }
        html.push(`<${tag}>${items.join('')}</${tag}>`);
        continue;
      }

      const paragraph = [line.trim()];
      i++;
      while (i < lines.length && !isBlockStart(lines[i])) paragraph.push(lines[i++].trim());
      html.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    }

    return html.join('');
  }

  function setMarkdown(element, value) {
    if (element) element.innerHTML = renderMarkdown(value);
  }

  return { escapeHtml, renderInline, renderMarkdown, safeHttpsUrl, setMarkdown };
});
