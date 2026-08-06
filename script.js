'use strict';

// One pose vocabulary drives both the code-drawn cast and installed sprite packs.
const POSES = ['idle', 'think', 'excited', 'stress', 'walk', 'point', 'sleep', 'cheer', 'wave'];
const PACK_COPY = {
  azure: 'cool-headed and ready to ship',
  crumb: 'small, round, and on the case',
  fox: 'a bright-eyed terminal scout',
  foxbow: 'adventure-ready with extra flair',
  miso: 'cozy support for long-running tasks',
};
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const animatedSprites = [];

function setBuiltInPose(card, pose) {
  const who = card.dataset.buddy;
  card.dataset.pose = pose;
  card.querySelector('img').src = `img/buddies/${who}-${pose}.gif`;
  card.querySelector('.pose-label').textContent = pose;
}

for (const card of document.querySelectorAll('.cast-card[data-buddy]')) {
  card.addEventListener('click', () => {
    const current = Math.max(0, POSES.indexOf(card.dataset.pose || 'idle'));
    setBuiltInPose(card, POSES[(current + 1) % POSES.length]);
  });
}

// The install one-liner, one click away.
for (const button of document.querySelectorAll('.copy')) {
  button.addEventListener('click', async () => {
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'copied ✓';
    } catch {
      button.textContent = 'select & copy';
    }
    window.setTimeout(() => { button.textContent = original; }, 1600);
  });
}

function makePackSprite(pack, width, initialPose = 'idle') {
  const scale = width / pack.frameWidth;
  const frameWidth = pack.frameWidth * scale;
  const frameHeight = pack.frameHeight * scale;
  const sprite = document.createElement('div');
  sprite.className = 'pack-sprite';
  sprite.setAttribute('aria-hidden', 'true');
  sprite.style.width = `${frameWidth}px`;
  sprite.style.height = `${frameHeight}px`;
  sprite.style.backgroundSize = `${frameWidth * pack.columns}px ${frameHeight * pack.rows}px`;

  const state = { pack, sprite, frameWidth, frameHeight, pose: initialPose, frame: 0, nextFrame: 0 };
  animatedSprites.push(state);
  setPackPose(state, initialPose);
  return state;
}

function setPackPose(state, requestedPose) {
  const poseName = state.pack.poses[requestedPose] ? requestedPose : Object.keys(state.pack.poses)[0];
  const pose = state.pack.poses[poseName];
  state.pose = poseName;
  state.frame = 0;
  state.nextFrame = 0;
  state.sprite.style.backgroundImage = `url("${pose.file}")`;
  state.sprite.style.backgroundPosition = `0 -${pose.row * state.frameHeight}px`;
  return poseName;
}

function makePackCard(pack) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'cast-card pack-card panel';
  card.setAttribute('aria-label', `Preview ${pack.label}'s next pose`);
  const state = makePackSprite(pack, 92);

  const caption = document.createElement('span');
  caption.className = 'cast-caption';
  const name = document.createElement('b');
  name.textContent = pack.label;
  const poseLabel = document.createElement('span');
  poseLabel.className = 'pose-label';
  poseLabel.textContent = state.pose;
  caption.append(name, poseLabel);

  const description = document.createElement('small');
  description.textContent = PACK_COPY[pack.id] || 'a new friend for the working tree';
  card.append(state.sprite, caption, description);
  card._spriteState = state;

  card.addEventListener('click', () => {
    const available = POSES.filter((pose) => pack.poses[pose]);
    const current = Math.max(0, available.indexOf(state.pose));
    poseLabel.textContent = setPackPose(state, available[(current + 1) % available.length]);
  });
  return card;
}

const packs = window.PACKS || [];
const packsRow = document.getElementById('packs-row');
for (const pack of packs) packsRow?.append(makePackCard(pack));

if (packsRow && !packs.length) {
  const empty = document.createElement('p');
  empty.className = 'packs-empty panel';
  empty.textContent = 'Drop a sprite pack into src/renderer/assets/themes and run npm run website.';
  packsRow.append(empty);
}

// Invite a few installed buddies into the product preview and closing party.
function addGuests(targetId, guestPacks, width) {
  const target = document.getElementById(targetId);
  if (!target) return;
  for (const pack of guestPacks) target.append(makePackSprite(pack, width, 'cheer').sprite);
}
addGuests('hero-guests', packs.slice(0, 3), 58);
addGuests('cta-guests', packs.slice(3, 5), 58);

// One animation loop serves every sprite instead of creating a timer per card.
function animateSprites(now) {
  for (const state of animatedSprites) {
    const pose = state.pack.poses[state.pose];
    const interval = 1000 / state.pack.fps;
    if (!state.nextFrame || now >= state.nextFrame) {
      state.sprite.style.backgroundPosition = `-${state.frame * state.frameWidth}px -${pose.row * state.frameHeight}px`;
      state.frame = (state.frame + 1) % pose.frames;
      state.nextFrame = now + interval;
    }
  }
  window.requestAnimationFrame(animateSprites);
}
if (!reduceMotion) window.requestAnimationFrame(animateSprites);

for (const option of document.querySelectorAll('.pose-option')) {
  option.addEventListener('click', () => {
    const requested = option.dataset.pose;
    document.querySelectorAll('.pose-option').forEach((item) => {
      item.classList.toggle('active', item === option);
      item.setAttribute('aria-pressed', item === option ? 'true' : 'false');
    });
    document.querySelectorAll('.cast-card[data-buddy]').forEach((card) => setBuiltInPose(card, requested));
    document.querySelectorAll('.pack-card').forEach((card) => {
      card.querySelector('.pose-label').textContent = setPackPose(card._spriteState, requested);
    });
  });
}
