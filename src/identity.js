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

// Every buddy answers to a pet name of its own, like an RPG party member —
// the project and model are its small print, not its name. Derived from the
// session id, so the same session keeps its name across restarts and two
// sessions in one folder still introduce themselves differently.
const PET_NAMES = [
  'Biscuit', 'Mochi', 'Waffle', 'Pixel', 'Nori', 'Clover', 'Ziggy', 'Pepper',
  'Miso', 'Tofu', 'Pickle', 'Noodle', 'Bean', 'Maple', 'Cocoa', 'Sprout',
  'Pudding', 'Nimbus', 'Comet', 'Ember', 'Fig', 'Juniper', 'Kiwi', 'Lentil',
  'Mango', 'Olive', 'Pesto', 'Quill', 'Radish', 'Sesame', 'Truffle', 'Umami',
  'Velvet', 'Wasabi', 'Yuzu', 'Zephyr', 'Acorn', 'Bramble', 'Chirpy', 'Dumpling',
  'Echo', 'Flapjack', 'Ginger', 'Hazel', 'Inky', 'Jelly', 'Kelp', 'Lychee',
  'Muffin', 'Nutmeg', 'Onyx', 'Poppy', 'Quokka', 'Rosco', 'Scone', 'Taro',
  'Ube', 'Vinnie', 'Wonton', 'Xylo', 'Yam', 'Zucchini', 'Alfie', 'Butter',
];

function petNamesFor(keys) {
  // A hash into a finite list eventually collides. Allocate in key order so
  // the collision is resolved consistently across restarts, not by arrival.
  const assigned = new Map();
  const taken = new Set();
  const unique = [...new Set((keys || []).map((key) => String(key || 'clippy')))].sort();
  for (const key of unique) {
    const start = hash(`pet:${key}`) % PET_NAMES.length;
    let name = '';
    for (let offset = 0; offset < PET_NAMES.length; offset++) {
      const candidate = PET_NAMES[(start + offset) % PET_NAMES.length];
      if (!taken.has(candidate)) {
        name = candidate;
        break;
      }
    }
    if (!name) {
      const base = PET_NAMES[start];
      let suffix = 2;
      while (taken.has(`${base} ${suffix}`)) suffix++;
      name = `${base} ${suffix}`;
    }
    taken.add(name);
    assigned.set(key, name);
  }
  return assigned;
}

function petNameFor(key, sessionKeys = [key]) {
  const id = String(key || 'clippy');
  // Keep this safe as an Array#map callback, whose second argument is an index.
  const keys = Array.isArray(sessionKeys) ? sessionKeys : [key];
  return petNamesFor([...keys, id]).get(id);
}

module.exports = { identityFor, petNameFor, petNamesFor, PET_NAMES, PALETTE, hash };
