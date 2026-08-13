'use strict';

/**
 * The reading window.
 *
 * Deliberately thin: it receives some text and renders it. Everything that can
 * answer an agent lives on the buddy, so a window you leave open on a second
 * display can never resolve anything by accident.
 */

const { setMarkdown } = window.ClippyMarkdown;

window.readerAPI.onText(({ title = '', where = '', text = '' }) => {
  document.getElementById('who').textContent = where;
  document.getElementById('what').textContent = title;
  document.title = title || 'Clippy';
  setMarkdown(document.getElementById('body'), text);
});

// Escape closes it, the way it closes anything else Clippy puts on screen.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
});

window.readerAPI.ready();
