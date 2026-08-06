'use strict';

/**
 * Every session gets its own Clippy, so every Clippy needs its own look —
 * otherwise five buddies on screen are five identical paperclips. The colour is
 * derived from the session id, so two agents in the same project still get
 * different-looking buddies. The project name remains the readable label.
 *
 * Pure and dependency-free — the renderer gets the result as query params, and
 * `npm run make-buddies` bakes one paperclip GIF per colour.
 */

// Paperclip wire colours: distinct hues that all read well on a dark card and
// against a light desktop. `dark` is the same hue pushed down for outlines.
const PALETTE = [
  { color: '#9aa3ad', dark: '#6b7481' }, // classic steel
  { color: '#e0803a', dark: '#a8571f' }, // amber
  { color: '#4fa3d1', dark: '#2c6f95' }, // sky
  { color: '#6cbf6c', dark: '#3f8a45' }, // green
  { color: '#c264c9', dark: '#8c3d92' }, // orchid
  { color: '#e0605f', dark: '#a83b3c' }, // coral
  { color: '#d4b03c', dark: '#9a7d18' }, // brass
  { color: '#59b9ae', dark: '#2e857c' }, // teal
];

/** Small stable string hash (FNV-1a); same input -> same buddy, every run. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * @param {string} key   session id (stable within a run)
 * @param {string} name  project name (the readable label)
 * @returns {{name: string, color: string, dark: string}}
 */
function identityFor(key, name = '') {
  const label = String(name || key || 'clippy');
  const palette = PALETTE[hash(String(key || label)) % PALETTE.length];
  return { name: label, color: palette.color, dark: palette.dark };
}

module.exports = { identityFor, PALETTE, hash };
