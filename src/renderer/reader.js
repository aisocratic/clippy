'use strict';

/**
 * The reading window.
 *
 * Deliberately focused: it renders one prompt and response. When it was opened
 * from a finished-turn review, the explicit footer can reply or sign off; all
 * other messages remain read-only.
 */

const { setMarkdown } = window.ClippyMarkdown;
let interactive = false;
let buddyTimer = null;

function renderBuddy(buddy) {
  clearInterval(buddyTimer);
  buddyTimer = null;
  const rail = document.getElementById('buddy-rail');
  const image = document.getElementById('reader-buddy-image');
  const sheet = document.getElementById('reader-buddy-sheet');
  const vector = document.getElementById('reader-buddy-vector');
  image.classList.add('hidden');
  sheet.classList.add('hidden');
  vector.classList.add('hidden');
  vector.replaceChildren();

  const showing = buddy && ['image', 'sheet', 'vector'].includes(buddy.kind);
  rail.classList.toggle('hidden', !showing);
  document.getElementById('reader-buddy-name').textContent = showing ? buddy.label || 'Buddy' : '';
  if (!showing) return;

  if (buddy.kind === 'image' && buddy.src) {
    image.src = buddy.src;
    image.classList.remove('hidden');
    return;
  }
  if (buddy.kind === 'vector' && buddy.vector) {
    const art = window.ClippyVectors.create(buddy.vector, 'excited', buddy.color || '#9aa3ad');
    if (art) {
      vector.replaceChildren(art);
      vector.classList.remove('hidden');
    }
    return;
  }
  const spec = buddy.sheet;
  const pose = spec && (spec.poses?.excited || spec.poses?.idle);
  if (!spec || !pose) return;
  const scale = 36 / spec.frameWidth;
  const width = spec.frameWidth * scale;
  const height = spec.frameHeight * scale;
  sheet.style.width = `${width}px`;
  sheet.style.height = `${height}px`;
  sheet.style.backgroundImage = `url("${pose.file}")`;
  sheet.style.backgroundSize = `${width * spec.columns}px ${height * spec.rows}px`;
  sheet.style.backgroundPosition = `0 -${pose.row * height}px`;
  sheet.classList.remove('hidden');
  const frames = Math.max(1, Number(pose.frames) || 1);
  let frame = 0;
  buddyTimer = setInterval(() => {
    frame = (frame + 1) % frames;
    sheet.style.backgroundPosition = `-${frame * width}px -${pose.row * height}px`;
  }, 1000 / (Number(spec.fps) || 6));
}

window.readerAPI.onText(
  ({
    title = '',
    where = '',
    prompt = '',
    text = '',
    canOpenSource = false,
    sourceName = 'source',
    review = false,
    buddy = null,
  }) => {
  document.getElementById('who').textContent = where;
  document.getElementById('what').textContent = title;
  document.title = title || 'Clippy';
  const promptSection = document.getElementById('prompt-section');
  const hasPrompt = Boolean(prompt.trim());
  promptSection.classList.toggle('hidden', !hasPrompt);
  document.getElementById('response-label').classList.toggle('hidden', !hasPrompt);
  if (hasPrompt) setMarkdown(document.getElementById('prompt'), prompt);
  setMarkdown(document.getElementById('body'), text);
  const openSource = document.getElementById('open-source');
  openSource.classList.toggle('hidden', !canOpenSource);
  openSource.title = `Open ${sourceName}`;
  openSource.setAttribute('aria-label', `Open ${sourceName}`);
  interactive = Boolean(review);
  document.getElementById('minimize-reader').classList.toggle('hidden', !interactive);
  document.getElementById('review-actions').classList.toggle('hidden', !interactive);
  const reply = document.getElementById('reply-input');
  reply.value = '';
  document.getElementById('send-reply').disabled = true;
  renderBuddy(buddy);
  }
);

document.getElementById('open-source').addEventListener('click', () => window.readerAPI.openSource());
document.getElementById('minimize-reader').addEventListener('click', () => window.readerAPI.minimize());

const replyInput = document.getElementById('reply-input');
replyInput.addEventListener('input', () => {
  document.getElementById('send-reply').disabled = !replyInput.value.trim();
});
replyInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && replyInput.value.trim()) {
    window.readerAPI.decide('feedback', replyInput.value.trim());
  }
});
document.getElementById('send-reply').addEventListener('click', () => {
  const message = replyInput.value.trim();
  if (message) window.readerAPI.decide('feedback', message);
});
document.getElementById('reader-good').addEventListener('click', () => window.readerAPI.decide('ok'));

// Escape closes it, the way it closes anything else Clippy puts on screen.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (interactive) window.readerAPI.minimize();
  else window.close();
});

window.readerAPI.ready();
