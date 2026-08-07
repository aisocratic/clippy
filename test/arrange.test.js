'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EDGE_OPTIONS, EDGE_IDS, edgeLineup, edgeHome } = require('../src/arrange');

// A display with a menu bar already carved out, the way Electron's workArea
// arrives, plus a buddy the size of the medium compact window.
const AREA = { x: 0, y: 25, width: 1440, height: 875 };
const SIZE = { width: 124, height: 196 };
const GAP = 6;

test('the tray offers exactly the four edges', () => {
  assert.deepEqual(EDGE_IDS, ['top', 'left', 'bottom', 'right']);
  for (const opt of EDGE_OPTIONS) assert.ok(opt.id && opt.label);
});

test('a bottom lineup stands on the work area floor, evenly spread', () => {
  const spots = edgeLineup(AREA, 'bottom', 2, SIZE, GAP);
  const floor = AREA.y + AREA.height - GAP - SIZE.height;
  assert.deepEqual(spots, [
    { x: 360 - SIZE.width / 2, y: floor },
    { x: 1080 - SIZE.width / 2, y: floor },
  ]);
});

test('a top lineup hangs from the top of the work area, not the display', () => {
  const [spot] = edgeLineup(AREA, 'top', 1, SIZE, GAP);
  // One buddy sits dead centre; y respects the menu bar the workArea excludes.
  assert.deepEqual(spot, { x: Math.round(720 - SIZE.width / 2), y: AREA.y + GAP });
});

test('vertical edges spread along the height instead', () => {
  const left = edgeLineup(AREA, 'left', 3, SIZE, GAP);
  const right = edgeLineup(AREA, 'right', 3, SIZE, GAP);
  for (const spot of left) assert.equal(spot.x, AREA.x + GAP);
  for (const spot of right) assert.equal(spot.x, AREA.x + AREA.width - GAP - SIZE.width);
  // Same even spacing on both sides, centred in equal thirds of the height.
  const centres = left.map((s) => s.y + SIZE.height / 2);
  assert.deepEqual(centres, right.map((s) => s.y + SIZE.height / 2));
  const [a, b, c] = centres;
  assert.ok(Math.abs(b - a - (c - b)) <= 1, `uneven: ${centres}`); // ±1px of rounding
});

test('a crowd never hangs off either end of the edge', () => {
  const spots = edgeLineup(AREA, 'bottom', 30, SIZE, GAP);
  assert.equal(spots.length, 30);
  for (const spot of spots) {
    assert.ok(spot.x >= AREA.x, `left end: ${spot.x}`);
    assert.ok(spot.x + SIZE.width <= AREA.x + AREA.width, `right end: ${spot.x}`);
  }
});

test('a work area pushed in by the dock moves the whole lineup with it', () => {
  const docked = { x: 80, y: 25, width: 1360, height: 875 }; // dock on the left
  const [spot] = edgeLineup(docked, 'left', 1, SIZE, GAP);
  assert.equal(spot.x, 80 + GAP);
});

test('no buddies, no spots', () => {
  assert.deepEqual(edgeLineup(AREA, 'bottom', 0, SIZE, GAP), []);
});

test('made-up edges are refused', () => {
  assert.throws(() => edgeLineup(AREA, 'middle', 1, SIZE, GAP), /not a screen edge/);
  assert.throws(() => edgeHome(AREA, '', 0, SIZE, GAP), /not a screen edge/);
});

test('slot 0 of an edge home tucks into the far end, like the classic corner', () => {
  assert.deepEqual(edgeHome(AREA, 'bottom', 0, SIZE, GAP), {
    x: AREA.x + AREA.width - GAP - SIZE.width,
    y: AREA.y + AREA.height - GAP - SIZE.height,
  });
  assert.deepEqual(edgeHome(AREA, 'left', 0, SIZE, GAP), {
    x: AREA.x + GAP,
    y: AREA.y + AREA.height - GAP - SIZE.height,
  });
});

test('later slots step along the edge without leaving it', () => {
  const first = edgeHome(AREA, 'top', 0, SIZE, GAP);
  const second = edgeHome(AREA, 'top', 1, SIZE, GAP);
  assert.equal(second.y, first.y);
  assert.equal(first.x - second.x, SIZE.width + GAP);
  // A slot far past the end stops at the near end instead of going off screen.
  const parked = edgeHome(AREA, 'top', 999, SIZE, GAP);
  assert.equal(parked.x, AREA.x);
});

test('a fixed step keeps the far edge anchored while the window grows', () => {
  const step = 268 + GAP; // the full panel's pitch
  const compact = edgeHome(AREA, 'bottom', 1, SIZE, GAP, step);
  const full = edgeHome(AREA, 'bottom', 1, { width: 268, height: 470 }, GAP, step);
  // Same right edge for both widths — the panel grows leftwards, the buddy
  // doesn't slide along the row when a card opens.
  assert.equal(compact.x + SIZE.width, full.x + 268);
});
