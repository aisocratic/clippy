'use strict';

/**
 * Lining buddies up along a screen edge — the "Organize buddies" tray action.
 *
 * Pure geometry so the maths is testable without Electron: callers hand in a
 * work area (which is how the dock / menu bar / notch are respected — Electron
 * has already carved them out of `workArea`) and get top-left corners back.
 */

// The four choices the tray offers, in the order they appear there.
const EDGE_OPTIONS = [
  { id: 'top', label: 'Top' },
  { id: 'left', label: 'Left' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'right', label: 'Right' },
];

const EDGE_IDS = EDGE_OPTIONS.map((e) => e.id);

const isHorizontal = (edge) => edge === 'top' || edge === 'bottom';

const assertEdge = (edge) => {
  if (!EDGE_IDS.includes(edge)) throw new Error(`not a screen edge: ${edge}`);
};

/**
 * How far from the chosen edge the windows sit, on the axis *across* the edge:
 * a top lineup hangs from the top of the work area, a bottom one stands on its
 * floor, and so on.
 */
function crossAxis(workArea, edge, { width, height }, gap) {
  switch (edge) {
    case 'top':
      return workArea.y + gap;
    case 'bottom':
      return workArea.y + workArea.height - gap - height;
    case 'left':
      return workArea.x + gap;
    default: // right
      return workArea.x + workArea.width - gap - width;
  }
}

/**
 * Evenly spaced spots for `count` windows along one edge of `workArea`: the
 * edge is cut into equal segments and each window is centred in its own, so
 * two buddies sit at the third-points, three at the quarter-points, and a
 * crowd packs in without ever hanging off either end.
 *
 * @param {{x:number,y:number,width:number,height:number}} workArea
 * @param {'top'|'left'|'bottom'|'right'} edge
 * @param {number} count       how many windows to place
 * @param {{width:number,height:number}} size  one window's size
 * @param {number} gap         breathing room from the edges
 * @returns {Array<{x:number,y:number}>} a top-left corner per window
 */
function edgeLineup(workArea, edge, count, size, gap = 0) {
  assertEdge(edge);
  if (!Number.isInteger(count) || count <= 0) return [];
  const horizontal = isHorizontal(edge);
  const start = horizontal ? workArea.x : workArea.y;
  const span = horizontal ? workArea.width : workArea.height;
  const own = horizontal ? size.width : size.height;
  const cross = crossAxis(workArea, edge, size, gap);
  return Array.from({ length: count }, (_, i) => {
    const centre = start + ((i + 0.5) * span) / count;
    const along = Math.round(Math.max(start, Math.min(start + span - own, centre - own / 2)));
    return horizontal ? { x: along, y: cross } : { x: cross, y: along };
  });
}

/**
 * Where a *new* buddy goes once an edge is the house style: slot 0 tucks into
 * the end of the edge and later slots step along it, the same habit as the
 * classic bottom-right corner stack. Horizontal edges fill from the right,
 * vertical ones from the bottom, and a slot that would step off the far end
 * just stops there rather than leaving the screen.
 *
 * Each slot is anchored by its *far* edge (right end / bottom end), so a
 * window that grows for a card keeps that edge still and grows inwards —
 * the same trick `cornerBounds` plays with its bottom-right anchor. `step`
 * is the slot pitch; it defaults to the window's own size plus the gap, but
 * a caller whose windows change size can pass a fixed pitch so slots don't
 * drift.
 *
 * @returns {{x:number,y:number}} the window's top-left corner
 */
function edgeHome(workArea, edge, slot, size, gap = 0, step = 0) {
  assertEdge(edge);
  const horizontal = isHorizontal(edge);
  const start = horizontal ? workArea.x : workArea.y;
  const span = horizontal ? workArea.width : workArea.height;
  const own = horizontal ? size.width : size.height;
  const pitch = step > 0 ? step : own + gap;
  const anchor = start + span - gap - Math.max(0, slot) * pitch;
  const along = Math.round(Math.max(start, anchor - own));
  const cross = crossAxis(workArea, edge, size, gap);
  return horizontal ? { x: along, y: cross } : { x: cross, y: along };
}

module.exports = { EDGE_OPTIONS, EDGE_IDS, edgeLineup, edgeHome };
