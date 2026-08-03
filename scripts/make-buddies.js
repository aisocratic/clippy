'use strict';

/**
 * Draws both buddies as pixel art and encodes them as looping GIFs:
 *
 *   cat-idle.gif / cat-excited.gif        the pixel cat
 *   clip-<hex>-idle|excited.gif           the pixel paperclip, one pair per
 *                                         identity colour so parallel sessions
 *                                         still look different
 *
 * Each pair is a calm animation and an excited one; the renderer swaps between
 * them exactly where the old SVG Clippy switched from bobbing to bouncing.
 *
 *   node scripts/make-buddies.js            # write the assets
 *   node scripts/make-buddies.js --preview  # print some frames as ASCII first
 *
 * The art is drawn with primitives rather than stored as an image so it stays
 * reviewable in a diff: shapes go down first, then a silhouette pass inks the
 * outline, which is what gives pixel art its readable edge.
 */

const fs = require('node:fs');
const path = require('node:path');
const { encodeGif } = require('../src/gif');
const { PALETTE: IDENTITY_COLOURS } = require('../src/identity');

const W = 32;
const H = 40; // headroom above and below, so the excited hop never clips the ears
const BASE_Y = 5;

// Palette slot 0 is the transparent one; the window behind the buddy shows through.
const PALETTE = [
  [0, 0, 0], // 0 transparent
  [42, 37, 50], // 1 outline
  [240, 165, 74], // 2 fur
  [212, 131, 42], // 3 fur, stripes
  [253, 246, 234], // 4 muzzle, chest, paws
  [240, 137, 155], // 5 nose, inner ear
  [62, 201, 138], // 6 eyes
];
const [T, INK, FUR, DARK, CREAM, PINK, EYE] = [0, 1, 2, 3, 4, 5, 6];
const ASCII = { 0: '.', 1: '#', 2: 'o', 3: 'd', 4: 'w', 5: 'p', 6: 'e', 7: 'x' };

const grid = () => new Uint8Array(W * H);
const put = (g, x, y, c) => {
  if (x >= 0 && x < W && y >= 0 && y < H) g[y * W + x] = c;
};
const at = (g, x, y) => (x >= 0 && x < W && y >= 0 && y < H ? g[y * W + x] : T);

function rect(g, x0, y0, x1, y1, c) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(g, x, y, c);
}

/** A rectangle with its corners bitten off — pixel art's version of a radius. */
function blob(g, x0, y0, x1, y1, c, r = 1) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = Math.min(x - x0, x1 - x);
      const dy = Math.min(y - y0, y1 - y);
      if (dx + dy < r) continue; // corner
      put(g, x, y, c);
    }
  }
}

/** An upward triangle: an ear. */
function ear(g, x, y, w, h, c) {
  for (let i = 0; i < h; i++) {
    const inset = Math.round((i / h) * (w / 2));
    for (let j = inset; j < w - inset; j++) put(g, x + j, y + h - 1 - i, c);
  }
}

/**
 * Ink every transparent pixel that touches the drawing: an outline for free.
 *
 * `exteriorOnly` first floods in from the canvas edge and inks only what the
 * flood reached, so holes *inside* the shape stay clear — which is what keeps
 * the gaps between a paperclip's wires open instead of filling them in.
 */
function outline(g, { exteriorOnly = false } = {}) {
  const src = g.slice();
  let outside = null;

  if (exteriorOnly) {
    outside = new Uint8Array(W * H);
    const stack = [];
    for (let x = 0; x < W; x++) stack.push([x, 0], [x, H - 1]);
    for (let y = 0; y < H; y++) stack.push([0, y], [W - 1, y]);
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (outside[i] || src[i] !== T) continue;
      outside[i] = 1;
      stack.push([x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]);
    }
  }

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (src[i] !== T || (outside && !outside[i])) continue;
      const touches =
        at(src, x - 1, y) > T || at(src, x + 1, y) > T || at(src, x, y - 1) > T || at(src, x, y + 1) > T;
      if (touches) put(g, x, y, INK);
    }
  }
}

// Where the tail goes in each pose: a lazy swish while idle, held high when
// something needs you. Each point is the top-left of a 2x2 chunk of tail.
const TAIL_POSES = [
  [[21, 30], [23, 30], [25, 29], [26, 27], [26, 25]],
  [[21, 30], [23, 31], [25, 30], [27, 28], [27, 26]],
  [[21, 30], [23, 30], [25, 31], [27, 30], [28, 28]],
  [[21, 29], [23, 28], [25, 27], [26, 25], [26, 23]], // up: excited
];

/**
 * One cat: a sitting tabby with the head a little oversized, the way every
 * cartoon cat is. Body first, head over it, face last, then the outline pass.
 *
 * @param {object} opts
 * @param {number} opts.tail    index into TAIL_POSES
 * @param {boolean} opts.blink  eyes shut for a frame
 * @param {number} opts.lift    pixels to hop up by
 * @param {boolean} opts.wide   excited: wide eyes, ears up
 * @param {number} opts.breathe 1 = head settles a pixel lower (breathing)
 * @param {boolean} opts.twitch flick one ear, the way cats do at rest
 */
function drawCat({
  tail = 0,
  blink = false,
  lift = 0,
  wide = false,
  breathe = 0,
  twitch = false,
} = {}) {
  const g = grid();
  const dy = BASE_Y - lift;
  const hy = dy + breathe; // the head rides on the breath, the body doesn't

  // Tail, before the body so the haunch covers its root.
  const pose = TAIL_POSES[tail % TAIL_POSES.length];
  for (const [x, y] of pose) rect(g, x, y + dy, x + 1, y + 1 + dy, FUR);
  const tip = pose.at(-1);
  rect(g, tip[0], tip[1] + dy, tip[0] + 1, tip[1] + 1 + dy, DARK); // dipped tip

  // A sitting cat is a wide base under a rounder torso — and this one is a
  // well-fed house cat, so the haunches spread and the belly comes forward.
  blob(g, 5, 22 + dy, 26, 32 + dy, FUR, 5);
  blob(g, 9, 14 + dy, 22, 26 + dy, FUR, 3);
  rect(g, 6, 25 + dy, 7, 29 + dy, DARK); // stripe over the near haunch
  rect(g, 24, 25 + dy, 25, 29 + dy, DARK);
  blob(g, 11, 17 + dy, 20, 30 + dy, CREAM, 3); // chest and belly

  // Front legs, with floor between them so they read as two legs.
  rect(g, 11, 24 + dy, 14, 32 + dy, CREAM);
  rect(g, 17, 24 + dy, 20, 32 + dy, CREAM);
  put(g, 12, 32 + dy, INK); // toe split
  put(g, 19, 32 + dy, INK);

  // Ears sit on top of a head that's smaller than the body it sits on.
  const earTop = (wide ? 0 : 1) + hy;
  const flick = twitch ? 1 : 0;
  ear(g, 8 - flick, earTop, 7, 6 + flick, FUR);
  ear(g, 17, earTop, 7, 6, FUR);
  ear(g, 10 - flick, earTop + 2, 3, 3, PINK);
  ear(g, 19, earTop + 2, 3, 3, PINK);
  blob(g, 8, 4 + hy, 23, 16 + hy, FUR, 3);

  // Tabby "M" between the ears.
  rect(g, 15, 5 + hy, 15, 7 + hy, DARK);
  rect(g, 16, 5 + hy, 16, 7 + hy, DARK);
  rect(g, 12, 6 + hy, 12, 7 + hy, DARK);
  rect(g, 19, 6 + hy, 19, 7 + hy, DARK);

  // Muzzle: just enough cream to sit the nose on.
  blob(g, 13, 12 + hy, 18, 15 + hy, CREAM, 1);

  // Eyes: big and round with a fat pupil and a bright glint — cute beats
  // realistic at this size, and a slit pupil just reads as a scowl.
  const eyeTop = 9 + hy;
  if (blink) {
    // A happy closed-eye arc rather than a flat line.
    rect(g, 10, eyeTop + 2, 13, eyeTop + 2, INK);
    rect(g, 18, eyeTop + 2, 21, eyeTop + 2, INK);
    put(g, 10, eyeTop + 1, INK);
    put(g, 13, eyeTop + 1, INK);
    put(g, 18, eyeTop + 1, INK);
    put(g, 21, eyeTop + 1, INK);
  } else {
    const h = wide ? 5 : 4;
    blob(g, 8, eyeTop, 13, eyeTop + h - 1, EYE, 1);
    blob(g, 18, eyeTop, 23, eyeTop + h - 1, EYE, 1);
    rect(g, 10, eyeTop + 1, 11, eyeTop + h - 1, INK); // pupil, with green around it
    rect(g, 20, eyeTop + 1, 21, eyeTop + h - 1, INK);
    put(g, 9, eyeTop, CREAM); // glint
    put(g, 19, eyeTop, CREAM);
  }

  // Nose, then the faintest "w" of a mouth — any more and he looks alarmed.
  rect(g, 15, 12 + hy, 16, 12 + hy, PINK);
  put(g, 15, 13 + hy, DARK);
  put(g, 16, 13 + hy, DARK);
  put(g, 14, 14 + hy, INK);
  put(g, 17, 14 + hy, INK);

  outline(g);

  // Whiskers go on after the outline pass — they're strokes, not silhouette,
  // and they start against the cheek so they don't float.
  for (const y of [13, 15]) {
    rect(g, 5, y + hy, 6, y + hy, INK);
    rect(g, W - 7, y + hy, W - 6, y + hy, INK);
  }
  return g;
}

/* ---------------- The paperclip, in pixels ---------------- */

// Same slots as the cat's palette so one ASCII legend covers both; the wire
// colours are filled in per identity when the GIF is encoded.
const [CT, CINK, WIRE, WIRE_DARK, WHITE, PUPIL] = [0, 1, 2, 3, 4, 5];

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const clipPalette = ({ color, dark }) => [
  [0, 0, 0], // transparent
  [42, 37, 50], // outline
  hex(color), // wire
  hex(dark), // wire, shaded
  [253, 250, 244], // eye white
  [34, 34, 34], // pupil
];

/**
 * A paperclip: two nested wire loops, the inner one open at the bottom, with
 * Clippy's eyes and eyebrows sitting on top of the wire the way they always did.
 *
 * @param {object} opts
 * @param {number} opts.bob    pixels the whole clip drifts down by
 * @param {number} opts.lift   pixels to bounce up by
 * @param {boolean} opts.blink eyes shut for a frame
 * @param {number} opts.look   -1, 0 or 1: which way the pupils drift
 * @param {boolean} opts.brows eyebrows up (excited)
 */
function drawClip({ bob = 0, lift = 0, blink = false, look = 0, brows = false } = {}) {
  const g = grid();
  const dy = BASE_Y + bob - lift;

  // A paperclip is one bent wire, so it's drawn as strokes with real gaps
  // between them — a filled ring just reads as a stone.
  //
  // One bent wire, drawn as rounded rings that get hollowed out — three pixels
  // of stroke, three of gap. The outline only inks the outside (see outline()),
  // so those gaps stay see-through the way a real clip's do.
  //
  // Outer bend: round the top, down both sides, round the bottom.
  blob(g, 4, 2 + dy, 27, 31 + dy, WIRE, 5);
  blob(g, 7, 5 + dy, 24, 28 + dy, CT, 4);

  // Inner bend: over the top, down both sides, and stopping short — that open
  // end is the giveaway that this is a clip and not a ring.
  blob(g, 10, 7 + dy, 21, 25 + dy, WIRE, 4);
  blob(g, 13, 10 + dy, 18, 22 + dy, CT, 3);
  rect(g, 12, 22 + dy, 19, 25 + dy, CT);

  // A shaded pixel down the right of each stroke stops the wire reading flat.
  for (let y = 2 + dy; y <= 31 + dy; y++) {
    for (const x of [6, 27, 12, 21, 24]) {
      if (at(g, x, y) === WIRE && at(g, x + 1, y) !== WIRE) put(g, x, y, WIRE_DARK);
    }
  }

  outline(g, { exteriorOnly: true });

  // Eyebrows, angled the way Clippy's always were — up when he's excited.
  const browY = (brows ? 7 : 9) + dy;
  rect(g, 6, browY + 1, 8, browY + 1, CINK);
  rect(g, 9, browY, 10, browY, CINK);
  rect(g, 23, browY + 1, 25, browY + 1, CINK);
  rect(g, 21, browY, 22, browY, CINK);

  // Eyes: white ovals sitting on the wire, pupils wandering about.
  const eyeTop = 12 + dy;
  if (blink) {
    rect(g, 6, eyeTop + 3, 11, eyeTop + 3, CINK);
    rect(g, 20, eyeTop + 3, 25, eyeTop + 3, CINK);
  } else {
    blob(g, 6, eyeTop, 11, eyeTop + 6, WHITE, 2);
    blob(g, 20, eyeTop, 25, eyeTop + 6, WHITE, 2);
    const px = look; // -1 left, 0 centre, 1 right
    rect(g, 8 + px, eyeTop + 2, 9 + px, eyeTop + 4, PUPIL);
    rect(g, 22 + px, eyeTop + 2, 23 + px, eyeTop + 4, PUPIL);
  }
  return g;
}

/* ---------------- The arcade cast ----------------
 *
 * Four more buddies, drawn the same way as the cat and the clip: primitives on
 * a 32x40 grid, silhouette pass last. They're *originals in the arcade idiom* —
 * a gi and a headband, a round bubble-blowing lizard, a wavy maze ghost, a
 * wind-up tin robot — not sprites lifted from any game, which is what lets the
 * repo keep shipping zero image assets and no third-party art.
 */

// Every character palette keeps slot 0 transparent and slot 1 ink, so the
// outline pass and the ASCII preview work the same for all of them.
const skin = [244, 198, 149];

const FIGHTER_PALETTE = [
  [0, 0, 0], // 0 transparent
  [42, 37, 50], // 1 outline
  skin, // 2 skin
  [58, 42, 32], // 3 hair
  [246, 243, 235], // 4 gi
  [214, 208, 193], // 5 gi, shaded
  [212, 62, 54], // 6 headband
  [140, 84, 44], // 7 belt
];
const [FT, FINK, SKIN, HAIR, GI, GI_DARK, BAND, BELT] = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * A karate buddy in a gi: feet planted, fists up, headband tails streaming.
 * The excited pose throws a straight right — the whole body turns into it.
 *
 * @param {object} opts
 * @param {number} opts.lift     pixels to hop up by
 * @param {boolean} opts.punch   right arm extended
 * @param {boolean} opts.blink   eyes shut for a frame
 * @param {number} opts.breathe  1 = shoulders settle a pixel lower
 * @param {number} opts.tails    which way the headband tails blow
 */
function drawFighter({ lift = 0, punch = false, blink = false, breathe = 0, tails = 0 } = {}) {
  const g = grid();
  const dy = BASE_Y - lift;
  const hy = dy + breathe; // head and shoulders ride the breath; the feet don't

  // Legs in a wide stance — a fighter is a triangle standing on two posts.
  rect(g, 9, 22 + dy, 13, 29 + dy, GI);
  rect(g, 18, 22 + dy, 22, 29 + dy, GI);
  rect(g, 8, 29 + dy, 13, 31 + dy, SKIN); // bare feet
  rect(g, 18, 29 + dy, 23, 31 + dy, SKIN);

  // Torso, with the gi's crossed lapels reading as a V of shadow.
  blob(g, 8, 13 + hy, 23, 23 + dy, GI, 3);
  for (let i = 0; i < 4; i++) {
    put(g, 13 + i, 14 + i + hy, GI_DARK);
    put(g, 18 - i, 14 + i + hy, GI_DARK);
  }
  rect(g, 8, 20 + dy, 23, 21 + dy, BELT); // belt
  rect(g, 15, 22 + dy, 16, 23 + dy, BELT); // knot tail

  // Arms. Sleeve first from the shoulder, then the fist on the end of it, so
  // they read as arms rather than two mittens floating beside him.
  if (punch) {
    rect(g, 21, 15 + hy, 26, 18 + hy, GI); // sleeve, thrown out
    blob(g, 24, 14 + hy, 29, 19 + hy, SKIN, 1); // fist (the outline needs the
    // last column, so nothing may be drawn in it)
    rect(g, 5, 15 + hy, 10, 18 + hy, GI);
    blob(g, 3, 14 + hy, 7, 19 + hy, SKIN, 1);
  } else {
    rect(g, 5, 15 + hy, 9, 19 + hy, GI); // sleeves, guard up
    rect(g, 22, 15 + hy, 26, 19 + hy, GI);
    blob(g, 3, 12 + hy, 8, 17 + hy, SKIN, 1); // fists, held high
    blob(g, 23, 12 + hy, 28, 17 + hy, SKIN, 1);
  }

  // Head, hair, and the band that makes him read as a fighter at 32 pixels.
  blob(g, 11, 2 + hy, 21, 12 + hy, SKIN, 2);
  blob(g, 10, 0 + hy, 22, 5 + hy, HAIR, 2);
  rect(g, 10, 5 + hy, 22, 6 + hy, BAND);
  const drift = tails % 2 === 0 ? 0 : 1;
  rect(g, 22, 6 + hy + drift, 26, 7 + hy + drift, BAND); // tails, blowing
  rect(g, 25, 7 + hy + drift, 29, 8 + hy + drift, BAND);

  if (blink) {
    rect(g, 13, 9 + hy, 14, 9 + hy, FINK);
    rect(g, 18, 9 + hy, 19, 9 + hy, FINK);
  } else {
    rect(g, 13, 8 + hy, 14, 9 + hy, FINK);
    rect(g, 18, 8 + hy, 19, 9 + hy, FINK);
  }
  // Jaw set when punching, otherwise a flat, focused line.
  if (punch) rect(g, 14, 11 + hy, 18, 12 + hy, FINK);
  else rect(g, 15, 11 + hy, 17, 11 + hy, FINK);

  outline(g);
  return g;
}

const DINO_PALETTE = [
  [0, 0, 0],
  [42, 37, 50],
  [92, 201, 79], // 2 scales
  [51, 160, 58], // 3 scales, shaded
  [250, 244, 206], // 4 belly, feet
  [253, 250, 244], // 5 eye white
  [34, 34, 34], // 6 pupil
  [159, 224, 255], // 7 bubble
];
const [DT, DINK, SCALE, SCALE_DARK, BELLY, EYEW, PUPIL2, BUBBLE] = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * A round little lizard that blows bubbles: one big egg-shaped body, a cream
 * belly, back spines, and a bubble that swells while it idles.
 *
 * @param {object} opts
 * @param {number} opts.lift    pixels to hop up by
 * @param {number} opts.bubble  0-3: how big the bubble has grown (0 = none)
 * @param {boolean} opts.blink  eyes shut for a frame
 * @param {number} opts.breathe 1 = the body settles a pixel
 * @param {boolean} opts.wide   excited: eyes wide open
 */
function drawDino({ lift = 0, bubble = 0, blink = false, breathe = 0, wide = false } = {}) {
  const g = grid();
  const dy = BASE_Y - lift + breathe;

  // Back spines first, so the body edge covers their roots.
  for (const [x, y] of [[22, 10], [24, 14], [25, 19]]) {
    ear(g, x, y + dy, 5, 4, SCALE_DARK);
  }

  blob(g, 5, 4 + dy, 24, 28 + dy, SCALE, 6); // the whole animal is one egg
  blob(g, 9, 16 + dy, 21, 28 + dy, BELLY, 4); // belly
  rect(g, 7, 28 + dy, 12, 31 + dy, BELLY); // feet
  rect(g, 17, 28 + dy, 22, 31 + dy, BELLY);
  put(g, 9, 31 + dy, DINK); // toe splits
  put(g, 19, 31 + dy, DINK);

  // Eyes: comically large, which is the whole look.
  const eyeTop = 8 + dy;
  const h = wide ? 7 : 6;
  if (blink) {
    rect(g, 8, eyeTop + 3, 12, eyeTop + 3, DINK);
    rect(g, 16, eyeTop + 3, 20, eyeTop + 3, DINK);
  } else {
    blob(g, 7, eyeTop, 13, eyeTop + h, EYEW, 2);
    blob(g, 15, eyeTop, 21, eyeTop + h, EYEW, 2);
    rect(g, 10, eyeTop + 2, 11, eyeTop + h - 1, PUPIL2);
    rect(g, 18, eyeTop + 2, 19, eyeTop + h - 1, PUPIL2);
    put(g, 9, eyeTop + 1, BUBBLE); // glint
    put(g, 17, eyeTop + 1, BUBBLE);
  }

  // A small round mouth, pursed — this is where the bubble comes from.
  blob(g, 12, 18 + dy, 17, 21 + dy, DINK, 1);
  blob(g, 13, 19 + dy, 16, 20 + dy, SCALE_DARK, 0);

  outline(g);

  // The bubble is drawn after the outline: it's glass, it has its own thin ring
  // and it drifts up and away as it grows.
  if (bubble > 0) {
    const r = 2 + bubble; // 3..5
    const cx = 9 - bubble; // drifts left and up as it swells, without leaving
    const cy = 20 - bubble * 3 + dy; // the canvas
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        const d = x * x + y * y;
        if (d > r * r) continue;
        put(g, cx + x, cy + y, d > (r - 1) * (r - 1) ? BUBBLE : DT);
      }
    }
    put(g, cx - r + 1, cy - r + 1, BUBBLE); // highlight
  }
  return g;
}

const GHOST_PALETTE = [
  [0, 0, 0],
  [42, 37, 50],
  [138, 111, 232], // 2 sheet
  [104, 78, 200], // 3 sheet, shaded
  [253, 250, 244], // 4 eye white
  [58, 64, 150], // 5 pupil
  [201, 190, 255], // 6 highlight
];
const [GT, GINK, SHEET, SHEET_DARK, GWHITE, GPUPIL, GLOW] = [0, 1, 2, 3, 4, 5, 6];

/**
 * A maze ghost: a dome with a wavy hem that ripples as it floats, and eyes
 * that look wherever it's drifting.
 *
 * @param {object} opts
 * @param {number} opts.wave   hem phase (the lobes swap places)
 * @param {number} opts.look   -1, 0 or 1: which way the pupils sit
 * @param {number} opts.drift  pixels the whole ghost floats up by
 * @param {boolean} opts.blink eyes shut for a frame
 * @param {boolean} opts.wide  excited: bigger eyes, brighter
 */
function drawGhost({ wave = 0, look = 0, drift = 0, blink = false, wide = false } = {}) {
  const g = grid();
  const dy = BASE_Y - drift;

  blob(g, 5, 1 + dy, 26, 20 + dy, SHEET, 7); // dome
  rect(g, 5, 12 + dy, 26, 25 + dy, SHEET); // straight sides under it
  blob(g, 7, 3 + dy, 12, 7 + dy, GLOW, 2); // sheen on the crown
  rect(g, 5, 23 + dy, 26, 25 + dy, SHEET_DARK); // shadow where the hem starts

  // The hem: four lobes, alternately hanging long and short. Drawn column by
  // column so the gaps between them are clean vertical notches rather than
  // whatever two overlapping blobs happen to leave behind.
  const LOBE = 5.5; // 22 pixels of hem over four lobes
  for (let x = 5; x <= 26; x++) {
    const i = Math.floor((x - 5) / LOBE);
    const long = (i + wave) % 2 === 0;
    // Round each lobe off: the columns at its edges stop a pixel short.
    const edge = (x - 5) % LOBE < 1 || (x - 5) % LOBE > LOBE - 1 ? 1 : 0;
    const bottom = (long ? 30 : 26) - edge;
    for (let y = 24; y <= bottom; y++) put(g, x, y + dy, SHEET);
  }

  const eyeTop = 9 + dy;
  const h = wide ? 8 : 7;
  if (blink) {
    rect(g, 8, eyeTop + 3, 13, eyeTop + 3, GINK);
    rect(g, 18, eyeTop + 3, 23, eyeTop + 3, GINK);
  } else {
    blob(g, 7, eyeTop, 13, eyeTop + h, GWHITE, 2);
    blob(g, 18, eyeTop, 24, eyeTop + h, GWHITE, 2);
    rect(g, 9 + look, eyeTop + 2, 11 + look, eyeTop + h - 2, GPUPIL);
    rect(g, 20 + look, eyeTop + 2, 22 + look, eyeTop + h - 2, GPUPIL);
  }

  outline(g);
  return g;
}

const ROBOT_PALETTE = [
  [0, 0, 0],
  [42, 37, 50],
  [166, 183, 199], // 2 tin
  [104, 128, 154], // 3 tin, shaded
  [95, 224, 255], // 4 eye light
  [255, 107, 94], // 5 antenna lamp
  [224, 178, 63], // 6 brass dial
];
const [RT, RINK, TIN, TIN_DARK, LENS, LAMP, BRASS] = [0, 1, 2, 3, 4, 5, 6];

/**
 * A wind-up tin robot: boxy head, brass dial, arms that shoot up when there's
 * news. The antenna lamp is the tell — it only lights when he's excited.
 *
 * @param {object} opts
 * @param {number} opts.lift    pixels to hop up by
 * @param {boolean} opts.lamp   antenna lamp lit
 * @param {boolean} opts.armsUp arms raised
 * @param {number} opts.look    -1, 0 or 1: which way the eye lights slide
 * @param {boolean} opts.blink  eye lights off for a frame
 */
function drawRobot({ lift = 0, lamp = false, armsUp = false, look = 0, blink = false } = {}) {
  const g = grid();
  const dy = BASE_Y - lift;

  // Antenna and its lamp.
  rect(g, 15, 1 + dy, 16, 4 + dy, TIN_DARK);
  blob(g, 13, -1 + dy, 18, 2 + dy, lamp ? LAMP : TIN_DARK, 1);

  blob(g, 8, 3 + dy, 23, 14 + dy, TIN, 2); // head
  rect(g, 8, 13 + dy, 23, 14 + dy, TIN_DARK); // jaw shadow
  rect(g, 14, 14 + dy, 17, 16 + dy, TIN_DARK); // neck

  // Eye lights, sliding left and right like a scanner.
  if (!blink) {
    rect(g, 11 + look, 6 + dy, 14 + look, 9 + dy, LENS);
    rect(g, 17 + look, 6 + dy, 20 + look, 9 + dy, LENS);
  }
  // Grille mouth.
  for (let x = 12; x <= 19; x += 2) rect(g, x, 11 + dy, x, 12 + dy, RINK);

  blob(g, 7, 16 + dy, 24, 28 + dy, TIN, 3); // body
  blob(g, 12, 19 + dy, 19, 25 + dy, BRASS, 2); // dial
  rect(g, 15, 20 + dy, 16, 22 + dy, RINK); // needle
  rect(g, 9, 26 + dy, 22, 27 + dy, TIN_DARK); // waist band

  // Arms: hanging, or thrown up.
  const shoulder = 17 + dy;
  if (armsUp) {
    rect(g, 3, shoulder - 6, 6, shoulder + 2, TIN_DARK);
    rect(g, 25, shoulder - 6, 28, shoulder + 2, TIN_DARK);
    blob(g, 2, shoulder - 9, 7, shoulder - 5, TIN, 1);
    blob(g, 24, shoulder - 9, 29, shoulder - 5, TIN, 1);
  } else {
    rect(g, 3, shoulder, 6, shoulder + 8, TIN_DARK);
    rect(g, 25, shoulder, 28, shoulder + 8, TIN_DARK);
    blob(g, 2, shoulder + 7, 7, shoulder + 11, TIN, 1);
    blob(g, 24, shoulder + 7, 29, shoulder + 11, TIN, 1);
  }

  // Feet.
  rect(g, 9, 28 + dy, 14, 31 + dy, TIN_DARK);
  rect(g, 17, 28 + dy, 22, 31 + dy, TIN_DARK);

  outline(g);
  return g;
}

const CLIP_IDLE = [
  { indices: drawClip({ bob: 0, look: 0 }), delayMs: 420 },
  { indices: drawClip({ bob: 1, look: 1 }), delayMs: 420 },
  { indices: drawClip({ bob: 1, blink: true }), delayMs: 120 },
  { indices: drawClip({ bob: 1, look: -1 }), delayMs: 420 },
  { indices: drawClip({ bob: 0, look: 0 }), delayMs: 420 },
];

const CLIP_EXCITED = [
  { indices: drawClip({ lift: 0, brows: true }), delayMs: 110 },
  { indices: drawClip({ lift: 3, brows: true, look: 1 }), delayMs: 110 },
  { indices: drawClip({ lift: 5, brows: true }), delayMs: 140 },
  { indices: drawClip({ lift: 2, brows: true, look: -1 }), delayMs: 110 },
];

function toAscii(g) {
  const rows = [];
  for (let y = 0; y < H; y++) {
    let row = '';
    for (let x = 0; x < W; x++) row += ASCII[g[y * W + x]];
    rows.push(row);
  }
  return rows.join('\n');
}

// Idle: breathing throughout, the tail swishing over it, with a blink and an
// ear flick dropped in so he never looks like a still image.
const IDLE = [
  { indices: drawCat({ tail: 0, breathe: 0 }), delayMs: 500 },
  { indices: drawCat({ tail: 1, breathe: 1 }), delayMs: 500 },
  { indices: drawCat({ tail: 2, breathe: 0, blink: true }), delayMs: 130 },
  { indices: drawCat({ tail: 2, breathe: 0 }), delayMs: 380 },
  { indices: drawCat({ tail: 1, breathe: 1 }), delayMs: 500 },
  { indices: drawCat({ tail: 0, breathe: 0, twitch: true }), delayMs: 200 },
];

// Excited: a proper hop — squash, up, hang, land — tail up and eyes wide.
const EXCITED = [
  { indices: drawCat({ tail: 3, lift: 0, wide: true, breathe: 1 }), delayMs: 110 },
  { indices: drawCat({ tail: 3, lift: 3, wide: true }), delayMs: 110 },
  { indices: drawCat({ tail: 3, lift: 5, wide: true }), delayMs: 140 },
  { indices: drawCat({ tail: 3, lift: 2, wide: true }), delayMs: 110 },
];

/* ---------------- Animations ---------------- */

// Idle animations breathe and fidget; excited ones are a four-frame hop, so
// every character switches moods with the same rhythm.
const FIGHTER_IDLE = [
  { indices: drawFighter({ breathe: 0, tails: 0 }), delayMs: 420 },
  { indices: drawFighter({ breathe: 1, tails: 1 }), delayMs: 420 },
  { indices: drawFighter({ breathe: 1, tails: 0, blink: true }), delayMs: 130 },
  { indices: drawFighter({ breathe: 0, tails: 1 }), delayMs: 420 },
];

const FIGHTER_EXCITED = [
  { indices: drawFighter({ lift: 0, tails: 1 }), delayMs: 110 },
  { indices: drawFighter({ lift: 3, punch: true, tails: 0 }), delayMs: 130 },
  { indices: drawFighter({ lift: 5, punch: true, tails: 1 }), delayMs: 140 },
  { indices: drawFighter({ lift: 1, tails: 0 }), delayMs: 110 },
];

const DINO_IDLE = [
  { indices: drawDino({ bubble: 0, breathe: 0 }), delayMs: 400 },
  { indices: drawDino({ bubble: 1, breathe: 1 }), delayMs: 380 },
  { indices: drawDino({ bubble: 2, breathe: 0 }), delayMs: 380 },
  { indices: drawDino({ bubble: 3, breathe: 1, blink: true }), delayMs: 200 },
  { indices: drawDino({ bubble: 0, breathe: 0 }), delayMs: 420 },
];

const DINO_EXCITED = [
  { indices: drawDino({ lift: 0, wide: true, bubble: 1 }), delayMs: 110 },
  { indices: drawDino({ lift: 3, wide: true, bubble: 2 }), delayMs: 110 },
  { indices: drawDino({ lift: 5, wide: true, bubble: 3 }), delayMs: 140 },
  { indices: drawDino({ lift: 2, wide: true, bubble: 0 }), delayMs: 110 },
];

const GHOST_IDLE = [
  { indices: drawGhost({ wave: 0, look: 0, drift: 0 }), delayMs: 380 },
  { indices: drawGhost({ wave: 1, look: 1, drift: 1 }), delayMs: 380 },
  { indices: drawGhost({ wave: 0, look: 1, blink: true, drift: 1 }), delayMs: 130 },
  { indices: drawGhost({ wave: 1, look: -1, drift: 0 }), delayMs: 380 },
];

const GHOST_EXCITED = [
  { indices: drawGhost({ wave: 0, drift: 0, wide: true }), delayMs: 110 },
  { indices: drawGhost({ wave: 1, drift: 3, wide: true, look: 1 }), delayMs: 110 },
  { indices: drawGhost({ wave: 0, drift: 5, wide: true }), delayMs: 140 },
  { indices: drawGhost({ wave: 1, drift: 2, wide: true, look: -1 }), delayMs: 110 },
];

const ROBOT_IDLE = [
  { indices: drawRobot({ look: 0 }), delayMs: 420 },
  { indices: drawRobot({ look: 1 }), delayMs: 420 },
  { indices: drawRobot({ look: 0, blink: true }), delayMs: 120 },
  { indices: drawRobot({ look: -1 }), delayMs: 420 },
];

const ROBOT_EXCITED = [
  { indices: drawRobot({ lift: 0, lamp: true, armsUp: true }), delayMs: 110 },
  { indices: drawRobot({ lift: 3, lamp: true, armsUp: true, look: 1 }), delayMs: 110 },
  { indices: drawRobot({ lift: 5, lamp: false, armsUp: true }), delayMs: 140 },
  { indices: drawRobot({ lift: 2, lamp: true, armsUp: true, look: -1 }), delayMs: 110 },
];

const gif = (palette, frames) =>
  encodeGif({ width: W, height: H, palette, frames, transparentIndex: 0 });

// One folder per character — `themes/<id>/idle.gif` and `excited.gif` — which
// is exactly what the renderer asks for (see buddyArt in clippy.js).
const THEMES = [
  { id: 'cat', palette: PALETTE, idle: IDLE, excited: EXCITED },
  { id: 'fighter', palette: FIGHTER_PALETTE, idle: FIGHTER_IDLE, excited: FIGHTER_EXCITED },
  { id: 'dino', palette: DINO_PALETTE, idle: DINO_IDLE, excited: DINO_EXCITED },
  { id: 'ghost', palette: GHOST_PALETTE, idle: GHOST_IDLE, excited: GHOST_EXCITED },
  { id: 'robot', palette: ROBOT_PALETTE, idle: ROBOT_IDLE, excited: ROBOT_EXCITED },
];

function build() {
  const assets = {};
  for (const theme of THEMES) {
    assets[`themes/${theme.id}/idle.gif`] = gif(theme.palette, theme.idle);
    assets[`themes/${theme.id}/excited.gif`] = gif(theme.palette, theme.excited);
  }
  // The paperclip is the one character built per identity colour: a GIF can't
  // be recoloured by CSS the way the old SVG could, so the palette is baked in.
  for (const identity of IDENTITY_COLOURS) {
    const slug = identity.color.replace('#', '');
    assets[`themes/clip/${slug}-idle.gif`] = gif(clipPalette(identity), CLIP_IDLE);
    assets[`themes/clip/${slug}-excited.gif`] = gif(clipPalette(identity), CLIP_EXCITED);
  }
  return assets;
}

function main() {
  const dir = path.join(__dirname, '..', 'src', 'renderer', 'assets');
  // `npm start` runs this with --if-missing: a fresh clone gets its buddies
  // without anyone having to know they're generated.
  if (process.argv.includes('--if-missing') && fs.existsSync(path.join(dir, 'themes'))) return;

  if (process.argv.includes('--preview')) {
    console.log(`clip, idle\n${toAscii(CLIP_IDLE[0].indices)}\n`);
    for (const theme of THEMES) {
      console.log(`${theme.id}, idle\n${toAscii(theme.idle[0].indices)}\n`);
      console.log(`${theme.id}, excited\n${toAscii(theme.excited[2].indices)}\n`);
    }
  }
  // Clear out what *this script* generated, so a renamed character doesn't
  // leave its old GIFs behind forever — but never touch a sprite-sheet theme
  // someone dropped in next to them.
  for (const theme of [...THEMES.map((t) => t.id), 'clip']) {
    fs.rmSync(path.join(dir, 'themes', theme), { recursive: true, force: true });
  }
  for (const stale of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (stale.endsWith('.gif')) fs.rmSync(path.join(dir, stale)); // pre-themes layout
  }
  for (const [name, bytes] of Object.entries(build())) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    console.log(`wrote ${path.relative(process.cwd(), file)} (${bytes.length} bytes)`);
  }
}

if (require.main === module) main();

module.exports = {
  drawCat,
  drawClip,
  drawFighter,
  drawDino,
  drawGhost,
  drawRobot,
  toAscii,
  build,
  THEMES,
  PALETTE,
  clipPalette,
  W,
  H,
};
