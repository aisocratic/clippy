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

/**
 * Lean a drawing over: rows near the top slide sideways, the base stays put.
 * Cheaper than redrawing a whole pose, and it's what sells a walk cycle.
 */
function lean(g, px) {
  if (!px) return g;
  const out = grid();
  for (let y = 0; y < H; y++) {
    const shift = Math.round(px * (1 - y / H));
    for (let x = 0; x < W; x++) {
      if (g[y * W + x]) put(out, x + shift, y, g[y * W + x]);
    }
  }
  return out;
}

/** A bead of sweat: the one pixel-art shorthand everyone reads instantly. */
function drop(g, x, y, fill, ink) {
  blob(g, x, y, x + 2, y + 3, fill, 1);
  put(g, x + 1, y - 1, ink);
  put(g, x - 1, y + 1, ink);
  put(g, x + 3, y + 1, ink);
  put(g, x, y + 4, ink);
  put(g, x + 2, y + 4, ink);
  put(g, x + 1, y + 4, ink);
}

/**
 * Sleep marks, drifting up and to the right. `n` grows them frame by frame, and
 * a narrow buddy can hand over its own three positions rather than wear them
 * across its own face.
 */
const ZZZ_MARKS = [
  [23, 8, 3],
  [26, 4, 4],
  [21, 2, 3],
];
function zzz(g, n, colour, marks = ZZZ_MARKS) {
  for (let i = 0; i < Math.min(n, marks.length); i++) {
    const [x, y, size] = marks[i];
    rect(g, x, y, x + size - 1, y, colour); // top bar
    rect(g, x, y + size - 1, x + size - 1, y + size - 1, colour); // bottom bar
    for (let j = 0; j < size; j++) put(g, x + size - 1 - j, y + j, colour); // diagonal
  }
}

/**
 * Draw something that floats beside the buddy — a sleep mark, a thought — into
 * its own layer, ink round its edge, and stamp the result down. A flat dark
 * mark disappears against a dark desktop and a flat light one against a light
 * desktop; only a light shape with a dark edge survives both.
 */
function floating(g, draw) {
  const layer = grid();
  draw(layer);
  outline(layer);
  for (let i = 0; i < layer.length; i++) if (layer[i]) g[i] = layer[i];
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
 * @param {number} opts.paw     0 = down, 1..2 = a front paw raised, higher each step
 * @param {boolean} opts.happy  eyes closed and curved up
 * @param {number} opts.sleeping how many sleep marks are floating (0 = awake)
 * @param {number} opts.tilt    lean the whole cat sideways
 * @param {boolean} opts.worried small pupils, ears flat — something is wrong
 * @param {number} opts.sweat   a drop beside the head, further down each step
 * @param {number} opts.headTilt lean just the head, for a quizzical look
 */
function drawCat({
  tail = 0,
  blink = false,
  lift = 0,
  wide = false,
  breathe = 0,
  twitch = false,
  paw = 0,
  happy = false,
  sleeping = 0,
  tilt = 0,
  worried = false,
  sweat = 0,
  headTilt = 0,
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
  put(g, 12, 32 + dy, INK); // toe split
  if (paw) {
    // One paw up: pointing at something, or waving for attention.
    const up = 6 + paw * 3;
    rect(g, 17, 24 + dy - up, 20, 30 + dy - up, CREAM);
    blob(g, 16, 21 + dy - up, 21, 26 + dy - up, CREAM, 1); // the paw itself
    put(g, 18, 22 + dy - up, PINK); // toe beans
    put(g, 19, 22 + dy - up, PINK);
  } else {
    rect(g, 17, 24 + dy, 20, 32 + dy, CREAM);
    put(g, 19, 32 + dy, INK);
  }

  // Ears sit on top of a head that's smaller than the body it sits on — and go
  // flat against it when the cat is unhappy.
  const earTop = (wide ? 0 : 1) + hy;
  const flick = twitch ? 1 : 0;
  if (worried) {
    blob(g, 6, earTop + 3, 12, earTop + 6, FUR, 1);
    blob(g, 19, earTop + 3, 25, earTop + 6, FUR, 1);
  } else {
    ear(g, 8 - flick, earTop, 7, 6 + flick, FUR);
    ear(g, 17, earTop, 7, 6, FUR);
    ear(g, 10 - flick, earTop + 2, 3, 3, PINK);
    ear(g, 19, earTop + 2, 3, 3, PINK);
  }
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
  if (happy) {
    // Eyes closed and curved *up* — content, not asleep.
    for (const x0 of [9, 17]) {
      rect(g, x0 + 1, eyeTop + 1, x0 + 4, eyeTop + 1, INK);
      put(g, x0, eyeTop + 2, INK);
      put(g, x0 + 5, eyeTop + 2, INK);
    }
  } else if (blink) {
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

  if (sleeping) zzz(g, sleeping, INK);
  if (sweat) drop(g, 25, 6 + sweat * 3 + hy, CREAM, INK);
  return tilt || headTilt ? lean(g, tilt || headTilt) : g;
}

/**
 * The same cat from the side, mid-stride: this is the one pose a sitting sprite
 * can't fake, and it's what plays while the buddy walks across a window.
 *
 * @param {number} opts.step  0-3 through the walk cycle
 * @param {number} opts.bob   1 = the body rises on the passing stride
 * @param {boolean} opts.blink
 */
function drawCatWalk({ step = 0, bob = 0, blink = false } = {}) {
  const g = grid();
  const dy = -bob; // the body rises on the passing stride; the feet don't

  // Legs first, so the body covers their tops. Four of them, two pairs out of
  // phase: front legs lead, back legs answer. Narrow and spaced, or they read
  // as one block.
  const reach = [
    [-2, 2],
    [0, 0],
    [2, -2],
    [0, 0],
  ][step % 4];
  const LEGS = [
    [7, 0],
    [11, 1],
    [18, 1],
    [22, 0],
  ];
  for (const [x, phase] of LEGS) {
    const swing = reach[phase];
    rect(g, x, 26 + dy, x + 1, 31, FUR); // thigh, hanging from the body
    rect(g, x + swing, 31, x + 1 + swing, 34, FUR); // shin, swinging
    rect(g, x + swing - 1, 34, x + 2 + swing, 35, CREAM); // paw
  }

  blob(g, 5, 15 + dy, 25, 28 + dy, FUR, 4); // barrel body
  blob(g, 8, 22 + dy, 22, 28 + dy, CREAM, 2); // belly
  rect(g, 11, 16 + dy, 12, 18 + dy, DARK); // two tabby stripes over the back
  rect(g, 16, 15 + dy, 17, 18 + dy, DARK);

  // Tail up and curling — a walking cat carries it high.
  for (const [x, y] of [[24, 20], [26, 17], [27, 13], [26, 10]]) {
    rect(g, x, y + dy, x + 1, y + 2 + dy, FUR);
  }
  rect(g, 26, 9 + dy, 27, 10 + dy, DARK); // dipped tip

  // Head at the front, in profile: one ear, one eye, a nose at the tip.
  blob(g, 3, 13 + dy, 14, 24 + dy, FUR, 3);
  ear(g, 5, 8 + dy, 6, 6, FUR);
  ear(g, 6, 10 + dy, 3, 3, PINK);
  blob(g, 2, 18 + dy, 8, 23 + dy, CREAM, 1); // muzzle
  put(g, 2, 20 + dy, PINK); // nose

  if (blink) rect(g, 6, 17 + dy, 9, 17 + dy, INK);
  else {
    blob(g, 5, 15 + dy, 10, 19 + dy, EYE, 1);
    rect(g, 7, 16 + dy, 8, 18 + dy, INK);
  }

  outline(g);
  rect(g, 10, 20 + dy, 12, 20 + dy, INK); // a whisker, over the outline
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
 * The wire, exactly as the very first commit's SVG drew it, still in its
 * original 120x170 viewBox: up over the top, down the right, round the bottom,
 * back up the left, and then the inner hook — which stops short, because that
 * open end is the whole difference between a paperclip and a ring.
 *
 * Four numbers is a straight run, eight is a cubic (two control points and an
 * end point); the start point is repeated so each segment stands alone.
 */
const CLIP_WIRE = [
  [38, 64, 38, 40, 46, 26, 60, 26],
  [60, 26, 74, 26, 82, 40, 82, 64],
  [82, 64, 82, 122],
  [82, 122, 82, 142, 73, 154, 60, 154],
  [60, 154, 47, 154, 38, 142, 38, 122],
  [38, 122, 38, 84],
  [38, 84, 38, 70, 44, 62, 53, 62],
  [53, 62, 62, 62, 68, 70, 68, 84],
  [68, 84, 68, 118],
];

/**
 * How that viewBox becomes sprite pixels. The scale can't be uniform: the clip
 * is 137 units tall and only 53 wide, so a wire thick enough to survive at this
 * size would leave a shape barely broader than its own stroke. So each axis
 * gets its own — 44 units across become 13 pixels of centreline, 128 units down
 * become 28 rows — and the clip lands sixteen pixels wide by thirty tall once the
 * stroke has hung its own thickness off each end, still comfortably narrower
 * than it is high.
 *
 * Across it isn't even one scale. A straight squeeze leaves the hook and the
 * outer right leg a single pixel apart, and a one-pixel gap is no gap at all
 * once the outline pass has been past it; so the right-hand stretch of the
 * viewBox is compressed rather less than the left, which buys that gap its
 * second pixel. The three numbers below are also picked so all three legs you
 * can see — outer left, hook, outer right — sit on whole pixels, which is what
 * keeps each of them exactly three pixels thick instead of two or four.
 */
const WIRE_R = 1.35; // half the wire's thickness, which makes it three across
const fitX = (x) => (x <= 68 ? 9 + (x - 38) * (8 / 30) : 17 + (x - 68) * (5 / 14));
const fitY = (y) => 1.35 + (y - 26) * (28.3 / 128);

/** Chop a segment into points close enough together that the brush leaves no
 *  holes — 60 to a bend is far more than a thirty-row clip could ever need. */
function flatten(seg, steps = 60) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (seg.length === 4) {
      pts.push([seg[0] + (seg[2] - seg[0]) * t, seg[1] + (seg[3] - seg[1]) * t]);
      continue;
    }
    const u = 1 - t;
    pts.push([
      u * u * u * seg[0] + 3 * u * u * t * seg[2] + 3 * u * t * t * seg[4] + t * t * t * seg[6],
      u * u * u * seg[1] + 3 * u * u * t * seg[3] + 3 * u * t * t * seg[5] + t * t * t * seg[7],
    ]);
  }
  return pts;
}

// The wire in sprite coordinates, worked out once: the silhouette never changes,
// only where on the canvas it lands.
const CLIP_POINTS = CLIP_WIRE.flatMap((seg) =>
  flatten(seg).map(([x, y]) => [fitX(x), fitY(y)])
);

/**
 * A wire arm, halfway up its swing and at the top of it. The SVG never had one;
 * but a thing with no hands has to wave with something, and a bend of its own
 * wire is all there is going. Written straight in sprite coordinates, since
 * there's no original to be faithful to — same eight-number cubics all the same.
 */
const WAVE_ARM = [
  [22.5, 19, 27, 17, 27, 14, 26.5, 13],
  [22.5, 19, 27, 16, 27, 11, 26.5, 9],
].map((arm) => flatten(arm, 40));

/**
 * Stamp a small disc along a run of points. This is how you stroke a path in
 * pixel art: the disc is what gives the wire round ends and the same thickness
 * whichever way it is bending, which a stack of rectangles never manages.
 */
function stamp(g, pts, colour, r, dy = 0) {
  for (const [px, py] of pts) {
    const cy = py + dy;
    for (let y = Math.round(cy - r); y <= Math.round(cy + r); y++) {
      for (let x = Math.round(px - r); x <= Math.round(px + r); x++) {
        if ((x - px) ** 2 + (y - cy) ** 2 <= r * r) put(g, x, y, colour);
      }
    }
  }
}

// Where the clip's own floating marks go: it is a narrow buddy and the shared
// positions would sit across its face.
const CLIP_ZZZ = [
  [26, 12, 3],
  [27, 7, 3],
  [26, 2, 3],
];
const CLIP_DOTS = [
  [27, 15, 1],
  [28, 11, 1],
  [26, 6, 2],
];

/** A rising trail of dots — the shorthand for a thought still being had. */
function busy(g, n, colour) {
  for (let i = 0; i < Math.min(n, CLIP_DOTS.length); i++) {
    const [x, y, size] = CLIP_DOTS[i];
    rect(g, x, y, x + size - 1, y + size - 1, colour);
  }
}

/**
 * Clippy, drawn the way the first commit drew him: one continuous wire, tall
 * and narrow, round over the top, the inner hook left hanging open — with the
 * big eyes and arched brows sitting *over* the wire, right where the SVG put
 * them.
 *
 * @param {object} opts
 * @param {number} opts.bob      pixels the whole clip drifts down by
 * @param {number} opts.lift     pixels to bounce up by
 * @param {boolean} opts.blink   eyes shut for a frame
 * @param {number} opts.look     -2..2: which way the pupils drift
 * @param {number} opts.lookDown -1..2: eyes up and away, or down at the prompt
 * @param {boolean} opts.brows   eyebrows up (excited)
 * @param {boolean} opts.happy   eyes shut and smiling
 * @param {number} opts.tilt     lean the whole clip sideways
 * @param {number} opts.sleeping how many sleep marks are floating (0 = awake)
 * @param {boolean} opts.worried brows pinched in — this is going badly
 * @param {number} opts.sweat    a bead beside him, further down each step
 * @param {number} opts.thinking how many thought dots are rising (0 = none)
 * @param {number} opts.wave     0 = no arm, 1-2 = a wire arm mid-greeting
 */
function drawClip({
  bob = 0,
  lift = 0,
  blink = false,
  look = 0,
  lookDown = 0,
  brows = false,
  happy = false,
  tilt = 0,
  sleeping = 0,
  worried = false,
  sweat = 0,
  thinking = 0,
  wave = 0,
} = {}) {
  const g = grid();
  const dy = BASE_Y + bob - lift;

  // The wire is stroked, not carved: the holes between the legs are simply
  // where the brush never went, so they stay see-through and the clip reads as
  // bent wire rather than a slab with slots cut in it.
  if (wave) stamp(g, WAVE_ARM[wave - 1], WIRE, WIRE_R - 0.2, dy);
  stamp(g, CLIP_POINTS, WIRE, WIRE_R, dy);

  // A shaded pixel down the right of each stroke stops the wire reading flat.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (at(g, x, y) === WIRE && at(g, x + 1, y) !== WIRE) put(g, x, y, WIRE_DARK);
    }
  }

  outline(g, { exteriorOnly: true });

  // Eyebrows: arched in the middle the way the SVG's two little curves were —
  // lifted a row when he's excited, and pinched *inward* when it's going badly.
  const browY = (brows ? 1 : 2) + dy;
  for (const [outer, inner] of [[8, 13], [23, 18]]) {
    const step = Math.sign(inner - outer);
    const span = Math.abs(inner - outer);
    for (let i = 0; i <= span; i++) {
      const x = outer + i * step;
      // Two pixels thick, because a one-pixel brow lying across the top bend
      // just reads as the wire having got lumpy. At rest the ends drop away and
      // the middle rides high — the little curve the SVG drew. Worried, the
      // whole brow slopes down toward the nose instead.
      if (worried ? i <= 2 : i > 0 && i < span) put(g, x, browY, CINK);
      if (!worried || i >= 1) put(g, x, browY + 1, CINK);
    }
  }

  // Eyes: white ovals with a dark rim, sitting over the wire and — as in the
  // SVG, where they very nearly touched — leaving hardly any daylight between.
  const eyeTop = 4 + dy;
  for (const x0 of [8, 17]) {
    if (blink || happy) {
      // Both shut eyes keep a white core: a bare dark curve would vanish, since
      // what's behind the middle of a paperclip is the desktop.
      const lid = eyeTop + 4;
      if (happy) {
        // Delighted: the top half of the eye, with the lid straight across the
        // bottom of it. Nothing is looking out, and it is plainly not asleep.
        blob(g, x0, lid - 2, x0 + 6, lid + 1, CINK, 2);
        blob(g, x0 + 1, lid - 1, x0 + 5, lid, WHITE, 1);
        rect(g, x0, lid + 1, x0 + 6, lid + 1, CINK);
      } else {
        // The CSS blinked by squashing the whole eye — white, dark rim and all
        // — to scaleY(0.08); this is that sliver.
        blob(g, x0, lid - 1, x0 + 6, lid + 1, CINK, 1);
        rect(g, x0 + 1, lid, x0 + 5, lid, WHITE);
      }
      continue;
    }
    blob(g, x0, eyeTop, x0 + 6, eyeTop + 7, CINK, 2);
    blob(g, x0 + 1, eyeTop + 1, x0 + 5, eyeTop + 6, WHITE, 1);
    rect(g, x0 + 2 + look, eyeTop + 2 + lookDown, x0 + 3 + look, eyeTop + 4 + lookDown, PUPIL);
  }

  if (sleeping) floating(g, (l) => zzz(l, sleeping, WHITE, CLIP_ZZZ));
  if (thinking) floating(g, (l) => busy(l, thinking, WHITE));
  if (sweat) drop(g, 26, 8 + sweat * 3 + dy, WHITE, CINK);
  return tilt ? lean(g, tilt) : g;
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

/* ---------------- Animations ----------------
 *
 * Every character speaks the same six-word vocabulary, so the app can ask for a
 * pose by name and get one from whoever is on duty — a drawn buddy or a sprite
 * pack (see POSES in src/characters.js).
 *
 *   idle     quiet, nothing to do
 *   excited  this session wants you
 *   walk     on the move — played while walking to a prompt
 *   point    standing at the prompt, pointing at the line
 *   sleep    nothing has happened in a while
 *   cheer    a turn finished cleanly
 */

const CLIP_POSES = {
  // The old CSS bobbed him over 3.2 seconds and blinked him with a transition;
  // these delays add up to roughly that, so he still reads as breathing rather
  // than flickering.
  idle: [
    { indices: drawClip({ bob: 0, look: 0 }), delayMs: 620 },
    { indices: drawClip({ bob: 1, look: 1 }), delayMs: 620 },
    { indices: drawClip({ bob: 1, blink: true }), delayMs: 130 },
    { indices: drawClip({ bob: 1, look: -1 }), delayMs: 620 },
    { indices: drawClip({ bob: 0, look: 0 }), delayMs: 620 },
  ],
  // The original bounce: up hard, rotated one way and then the other, brows
  // lifted — the whole thing inside about half a second.
  excited: [
    { indices: drawClip({ lift: 0, brows: true, tilt: -2 }), delayMs: 110 },
    { indices: drawClip({ lift: 3, brows: true, tilt: -1, look: 1 }), delayMs: 110 },
    { indices: drawClip({ lift: 4, brows: true, tilt: 1 }), delayMs: 140 },
    { indices: drawClip({ lift: 2, brows: true, tilt: 2, look: -1 }), delayMs: 110 },
  ],
  // A clip has no legs, so it walks the way a clip would: rocking over its own
  // base, and watching where it's going.
  walk: [
    { indices: drawClip({ bob: 0, tilt: -2, look: -1 }), delayMs: 150 },
    { indices: drawClip({ lift: 2, tilt: -1, look: -1 }), delayMs: 150 },
    { indices: drawClip({ bob: 0, tilt: 2, look: -1 }), delayMs: 150 },
    { indices: drawClip({ lift: 2, tilt: 1, look: -1 }), delayMs: 150 },
  ],
  // Leaning right over the line it wants you to type on, eyes down at it.
  point: [
    { indices: drawClip({ tilt: -3, lookDown: 2, look: -1, brows: true }), delayMs: 260 },
    { indices: drawClip({ tilt: -4, lookDown: 2, look: -1, brows: true, lift: 1 }), delayMs: 260 },
  ],
  sleep: [
    { indices: drawClip({ bob: 0, blink: true, sleeping: 1 }), delayMs: 620 },
    { indices: drawClip({ bob: 1, blink: true, sleeping: 2 }), delayMs: 620 },
    { indices: drawClip({ bob: 1, blink: true, sleeping: 3 }), delayMs: 620 },
  ],
  cheer: [
    { indices: drawClip({ lift: 0, happy: true, brows: true }), delayMs: 130 },
    { indices: drawClip({ lift: 3, happy: true, brows: true, tilt: -2 }), delayMs: 130 },
    { indices: drawClip({ lift: 4, happy: true, brows: true }), delayMs: 160 },
    { indices: drawClip({ lift: 3, happy: true, brows: true, tilt: 2 }), delayMs: 130 },
  ],
  // Working: eyes up and away, a slow sway, and a trail of dots going up —
  // concentration, rather than anything wanting your attention.
  think: [
    { indices: drawClip({ bob: 0, look: 1, lookDown: -1, thinking: 1 }), delayMs: 420 },
    { indices: drawClip({ bob: 1, look: 1, lookDown: -1, thinking: 2, tilt: 1 }), delayMs: 420 },
    { indices: drawClip({ bob: 1, look: -1, lookDown: -1, thinking: 3 }), delayMs: 420 },
    { indices: drawClip({ bob: 0, look: -1, lookDown: -1, tilt: -1 }), delayMs: 420 },
  ],
  // A fast, small shake with the brows pinched in and a bead of sweat: the
  // difference between "look at me" and "this is going badly".
  stress: [
    { indices: drawClip({ worried: true, tilt: -1, sweat: 1 }), delayMs: 90 },
    { indices: drawClip({ worried: true, tilt: 1, sweat: 1, lookDown: 1 }), delayMs: 90 },
    { indices: drawClip({ worried: true, tilt: -1, sweat: 2 }), delayMs: 90 },
    { indices: drawClip({ worried: true, tilt: 1, sweat: 2, lookDown: 1 }), delayMs: 90 },
    { indices: drawClip({ worried: true, tilt: 0, sweat: 3 }), delayMs: 120 },
  ],
  // Hello: the wire arm swings, and he watches you while he does it.
  wave: [
    { indices: drawClip({ wave: 1, brows: true, look: 1 }), delayMs: 170 },
    { indices: drawClip({ wave: 2, brows: true, look: 1, tilt: -1 }), delayMs: 170 },
    { indices: drawClip({ wave: 1, brows: true, look: 1, lift: 1 }), delayMs: 170 },
    { indices: drawClip({ wave: 2, brows: true, look: 1, tilt: 1 }), delayMs: 170 },
  ],
};

const CAT_POSES = {
  // Breathing throughout, the tail swishing over it, with a blink and an ear
  // flick dropped in so he never looks like a still image.
  idle: [
    { indices: drawCat({ tail: 0, breathe: 0 }), delayMs: 500 },
    { indices: drawCat({ tail: 1, breathe: 1 }), delayMs: 500 },
    { indices: drawCat({ tail: 2, breathe: 0, blink: true }), delayMs: 130 },
    { indices: drawCat({ tail: 2, breathe: 0 }), delayMs: 380 },
    { indices: drawCat({ tail: 1, breathe: 1 }), delayMs: 500 },
    { indices: drawCat({ tail: 0, breathe: 0, twitch: true }), delayMs: 200 },
  ],
  // A proper hop — squash, up, hang, land — tail up and eyes wide.
  excited: [
    { indices: drawCat({ tail: 3, lift: 0, wide: true, breathe: 1 }), delayMs: 110 },
    { indices: drawCat({ tail: 3, lift: 3, wide: true }), delayMs: 110 },
    { indices: drawCat({ tail: 3, lift: 5, wide: true }), delayMs: 140 },
    { indices: drawCat({ tail: 3, lift: 2, wide: true }), delayMs: 110 },
  ],
  walk: [
    { indices: drawCatWalk({ step: 0, bob: 0 }), delayMs: 160 },
    { indices: drawCatWalk({ step: 1, bob: 1 }), delayMs: 160 },
    { indices: drawCatWalk({ step: 2, bob: 0 }), delayMs: 160 },
    { indices: drawCatWalk({ step: 3, bob: 1, blink: true }), delayMs: 160 },
  ],
  point: [
    { indices: drawCat({ tail: 3, paw: 1, wide: true }), delayMs: 240 },
    { indices: drawCat({ tail: 3, paw: 2, wide: true }), delayMs: 240 },
  ],
  sleep: [
    { indices: drawCat({ tail: 0, breathe: 1, happy: true, sleeping: 1 }), delayMs: 620 },
    { indices: drawCat({ tail: 0, breathe: 0, happy: true, sleeping: 2 }), delayMs: 620 },
    { indices: drawCat({ tail: 1, breathe: 1, happy: true, sleeping: 3 }), delayMs: 620 },
  ],
  cheer: [
    { indices: drawCat({ tail: 3, lift: 0, happy: true, paw: 1 }), delayMs: 130 },
    { indices: drawCat({ tail: 3, lift: 4, happy: true, paw: 2, tilt: -2 }), delayMs: 130 },
    { indices: drawCat({ tail: 3, lift: 6, happy: true, paw: 2 }), delayMs: 160 },
    { indices: drawCat({ tail: 3, lift: 3, happy: true, paw: 1, tilt: 2 }), delayMs: 130 },
  ],
  // Watching something happen: head cocked one way, then the other.
  think: [
    { indices: drawCat({ tail: 1, breathe: 0, headTilt: -2 }), delayMs: 520 },
    { indices: drawCat({ tail: 2, breathe: 1, headTilt: -2, blink: true }), delayMs: 140 },
    { indices: drawCat({ tail: 2, breathe: 1, headTilt: 2 }), delayMs: 520 },
    { indices: drawCat({ tail: 1, breathe: 0, headTilt: 2 }), delayMs: 520 },
  ],
  // Ears flat, eyes small, sweating, and shivering on the spot.
  stress: [
    { indices: drawCat({ tail: 2, worried: true, tilt: -1, sweat: 1 }), delayMs: 90 },
    { indices: drawCat({ tail: 1, worried: true, tilt: 1, sweat: 1 }), delayMs: 90 },
    { indices: drawCat({ tail: 2, worried: true, tilt: -1, sweat: 2 }), delayMs: 90 },
    { indices: drawCat({ tail: 1, worried: true, tilt: 1, sweat: 2 }), delayMs: 90 },
    { indices: drawCat({ tail: 2, worried: true, tilt: 0, sweat: 3 }), delayMs: 120 },
  ],
  wave: [
    { indices: drawCat({ tail: 3, paw: 1, happy: true, tilt: -1 }), delayMs: 200 },
    { indices: drawCat({ tail: 3, paw: 2, happy: true, tilt: 1 }), delayMs: 200 },
    { indices: drawCat({ tail: 3, paw: 2, happy: true, tilt: -1 }), delayMs: 200 },
    { indices: drawCat({ tail: 3, paw: 1, happy: true, tilt: 1 }), delayMs: 200 },
  ],
};

function toAscii(g) {
  const rows = [];
  for (let y = 0; y < H; y++) {
    let row = '';
    for (let x = 0; x < W; x++) row += ASCII[g[y * W + x]];
    rows.push(row);
  }
  return rows.join('\n');
}

const gif = (palette, frames) =>
  encodeGif({ width: W, height: H, palette, frames, transparentIndex: 0 });

// One folder per character, one GIF per pose — `themes/<id>/<pose>.gif`, which
// is exactly what the renderer asks for (see buddyArt in clippy.js).
const THEMES = [
  { id: 'cat', palette: PALETTE, poses: CAT_POSES },
  { id: 'clip', poses: CLIP_POSES, perColour: true },
];

// `clip` used to be a blocky two-loop paperclip with `classic` beside it doing
// the original SVG silhouette; now `clip` *is* that silhouette, so `classic` is
// a duplicate and has been retired. Its old folder gets swept up in main().
const RETIRED = ['classic'];

function build() {
  const assets = {};
  for (const theme of THEMES) {
    for (const [pose, frames] of Object.entries(theme.poses)) {
      if (!theme.perColour) {
        assets[`themes/${theme.id}/${pose}.gif`] = gif(theme.palette, frames);
        continue;
      }
      // Clippy himself is built per identity colour: a GIF can't be recoloured
      // by CSS the way the old SVG could, so the palette is baked in.
      for (const identity of IDENTITY_COLOURS) {
        const slug = identity.color.replace('#', '');
        assets[`themes/${theme.id}/${slug}-${pose}.gif`] = gif(clipPalette(identity), frames);
      }
    }
  }
  return assets;
}

/**
 * The quick-start path is safe only when every built-in output matches what
 * this version of the generator would write. Custom sprite packs may sit
 * beside these files, but do not count as proof that the built-ins are fresh.
 */
function builtInAssetsAreCurrent(dir, expected = build()) {
  return Object.entries(expected).every(([name, bytes]) => {
    try {
      return fs.readFileSync(path.join(dir, name)).equals(bytes);
    } catch {
      return false;
    }
  });
}

function main() {
  const dir = path.join(__dirname, '..', 'src', 'renderer', 'assets');
  let assets;
  // `npm start` runs this with --if-missing: a fresh clone gets its buddies
  // without anyone having to know they're generated.
  if (process.argv.includes('--if-missing')) {
    assets = build();
    if (builtInAssetsAreCurrent(dir, assets)) return;
  }

  if (process.argv.includes('--preview')) {
    const only = process.argv[process.argv.indexOf('--preview') + 1];
    for (const theme of THEMES) {
      for (const [pose, frames] of Object.entries(theme.poses)) {
        if (only && !only.startsWith('--') && `${theme.id}:${pose}` !== only) continue;
        console.log(`${theme.id}, ${pose}\n${toAscii(frames[Math.min(1, frames.length - 1)].indices)}\n`);
      }
    }
  }
  // Clear out what *this script* generated, so a renamed character doesn't
  // leave its old GIFs behind forever — but never touch a sprite-sheet theme
  // someone dropped in next to them.
  for (const theme of THEMES.map((t) => t.id)) {
    fs.rmSync(path.join(dir, 'themes', theme), { recursive: true, force: true });
  }
  // Characters this script used to draw and no longer does. Their folders would
  // otherwise sit there forever, and keep turning up in the menus. One with a
  // `theme.json` in it isn't ours, though: that's somebody's sprite pack under a
  // name we happened to have used, and deleting it would take their art with it.
  for (const id of RETIRED) {
    const folder = path.join(dir, 'themes', id);
    if (!fs.existsSync(folder) || fs.existsSync(path.join(folder, 'theme.json'))) continue;
    fs.rmSync(folder, { recursive: true, force: true });
  }
  for (const stale of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (stale.endsWith('.gif')) fs.rmSync(path.join(dir, stale)); // pre-themes layout
  }
  for (const [name, bytes] of Object.entries(assets || build())) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    console.log(`wrote ${path.relative(process.cwd(), file)} (${bytes.length} bytes)`);
  }
}

if (require.main === module) main();

module.exports = {
  drawCat,
  drawCatWalk,
  drawClip,
  toAscii,
  build,
  builtInAssetsAreCurrent,
  THEMES,
  PALETTE,
  clipPalette,
  W,
  H,
};
