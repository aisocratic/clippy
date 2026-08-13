'use strict';

/**
 * The mobile app's artwork, drawn rather than stored — the same bargain the
 * desktop icon and every buddy sprite make (see make-buddies.js). One clip
 * definition feeds the menu-bar app's .icns and the phone's home screen, so
 * they cannot drift apart.
 *
 *   node scripts/make-mobile-icons.js
 *
 * Writes into mobile/assets/:
 *   icon.png           1024², opaque — iOS home screen and the App Store
 *   adaptive-icon.png  1024², the clip inset for Android's mask
 *   splash-icon.png    1024², what expo-splash-screen centres on paper
 *   favicon.png        48², the web build's tab icon
 *   notification-icon.png  96², a white silhouette for Android's status bar
 *
 * The one rule that is not negotiable: **the iOS icon may not have an alpha
 * channel.** App Store Connect rejects an icon with transparency, and the
 * failure arrives after a build and an upload rather than here. So every pixel
 * is composited onto solid paper before it is written.
 */

const fs = require('node:fs');
const path = require('node:path');
const { encodePng, renderIconPixels } = require('./package-app');

// Clippy's warm paper, matching mobile/src/theme.ts's `paper`.
const PAPER = [0xf7, 0xf1, 0xe7];

const ASSETS = path.join(__dirname, '..', 'mobile', 'assets');

/**
 * Flatten RGBA onto an opaque background.
 *
 * The clip is drawn with hard edges and no partial alpha, but composite
 * properly anyway: it costs nothing and it means this still does the right
 * thing if the artwork ever grows a soft edge.
 */
function flatten(rgba, background = PAPER) {
  const out = Buffer.alloc(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3] / 255;
    out[i] = Math.round(rgba[i] * a + background[0] * (1 - a));
    out[i + 1] = Math.round(rgba[i + 1] * a + background[1] * (1 - a));
    out[i + 2] = Math.round(rgba[i + 2] * a + background[2] * (1 - a));
    out[i + 3] = 255; // no alpha, ever
  }
  return out;
}

/**
 * Draw the clip at `size`, scaled to `fill` of the canvas and centred.
 *
 * `renderIconPixels` fits the sprite to the whole square, which is right for a
 * macOS icon sitting in a Dock. A phone icon is cropped to a rounded rect and
 * an Android one to whatever mask the launcher fancies, so the clip is drawn
 * smaller into a bigger canvas and given room to survive the crop.
 */
function clipOn(size, { fill = 1, transparent = false, silhouette = false } = {}) {
  const inner = Math.round(size * fill);
  const sprite = renderIconPixels(inner);
  const canvas = Buffer.alloc(size * size * 4); // transparent to start
  const offset = Math.floor((size - inner) / 2);

  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const from = (y * inner + x) * 4;
      const to = ((y + offset) * size + (x + offset)) * 4;
      // Android draws a notification icon as a mask: every visible pixel is
      // forced to white and only the alpha survives, so shipping the coloured
      // art would render as a white blob. Flatten it to a shape here instead.
      const on = sprite[from + 3] !== 0;
      canvas[to] = silhouette ? 255 : sprite[from];
      canvas[to + 1] = silhouette ? 255 : sprite[from + 1];
      canvas[to + 2] = silhouette ? 255 : sprite[from + 2];
      canvas[to + 3] = silhouette ? (on ? 255 : 0) : sprite[from + 3];
    }
  }
  return transparent ? canvas : flatten(canvas);
}

const write = (name, size, options = {}) => {
  const file = path.join(ASSETS, name);
  // Only the icon Apple validates has to shed its alpha channel; the rest keep
  // theirs so a launcher or a browser can round and mask them as it likes.
  const alpha = Boolean(options.transparent);
  fs.writeFileSync(file, encodePng(size, size, clipOn(size, options), { alpha }));
  return file;
};

function makeMobileIcons() {
  fs.mkdirSync(ASSETS, { recursive: true });
  const made = [
    // Home screen and App Store. iOS rounds the corners itself, so the clip
    // gets a margin rather than going edge to edge.
    write('icon.png', 1024, { fill: 0.66 }),
    // Android masks aggressively — anything outside the middle ~66% can be
    // cropped away, so this one is smaller again.
    write('adaptive-icon.png', 1024, { fill: 0.52, transparent: true }),
    // The launch screen: the same clip, small and centred on paper.
    write('splash-icon.png', 1024, { fill: 0.4, transparent: true }),
    write('favicon.png', 48, { fill: 0.8, transparent: true }),
    // The small monochrome mark Android puts in the status bar.
    write('notification-icon.png', 96, { fill: 0.86, transparent: true, silhouette: true }),
  ];
  return made;
}

if (require.main === module) {
  for (const file of makeMobileIcons()) {
    console.log(`${path.relative(process.cwd(), file)}  ${fs.statSync(file).size} bytes`);
  }
}

module.exports = { makeMobileIcons, flatten, clipOn, PAPER };
