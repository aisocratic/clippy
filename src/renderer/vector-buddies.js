'use strict';

/**
 * Built-in vector buddies.
 *
 * These are SVG elements, not SVG files loaded through an <img>: the renderer
 * can change their pose and session colour without rasterising a frame or
 * baking one asset per colour. Keep the markup here so the drawing remains
 * reviewable alongside the behaviour it expresses.
 */
(function expose(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.ClippyVectors = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const NS = 'http://www.w3.org/2000/svg';
  const POSES = new Set(['idle', 'think', 'excited', 'stress', 'walk', 'point', 'sleep', 'cheer', 'wave']);
  let nextId = 0;

  const safeColour = (value) => (/^#[0-9a-f]{6}$/i.test(value || '') ? value : '#9aa3ad');

  function motion(pose) {
    if (pose === 'stress') {
      return '<animateTransform attributeName="transform" type="translate" values="-1 0;1 0;-1 0;1 0;-1 0" dur=".34s" repeatCount="indefinite" />';
    }
    if (pose === 'excited' || pose === 'cheer') {
      return '<animateTransform attributeName="transform" type="translate" values="0 3;0 -8;0 3" keyTimes="0;.45;1" dur=".72s" repeatCount="indefinite" />';
    }
    if (pose === 'walk') {
      return '<animateTransform attributeName="transform" type="translate" values="0 1;0 -3;0 1" dur=".42s" repeatCount="indefinite" />';
    }
    if (pose === 'sleep') {
      return '<animateTransform attributeName="transform" type="rotate" values="-4 48 72;-2 48 72;-4 48 72" dur="2.4s" repeatCount="indefinite" />';
    }
    return '<animateTransform attributeName="transform" type="translate" values="0 1;0 -2;0 1" dur="2.2s" repeatCount="indefinite" />';
  }

  function eyes(pose) {
    if (pose === 'sleep') {
      return '<path d="M34 57q4 4 8 0M54 57q4 4 8 0" fill="none" stroke="#252938" stroke-width="3" stroke-linecap="round" />';
    }
    if (pose === 'cheer') {
      return '<path d="M33 57q5-6 10 0M53 57q5-6 10 0" fill="none" stroke="#252938" stroke-width="3" stroke-linecap="round" />';
    }
    if (pose === 'stress') {
      return '<path d="M33 51l10 3M63 51l-10 3" fill="none" stroke="#252938" stroke-width="2.6" stroke-linecap="round" /><circle cx="39" cy="58" r="3.2" fill="#252938" /><circle cx="57" cy="58" r="3.2" fill="#252938" />';
    }
    const look = pose === 'think' ? -2 : pose === 'point' ? 2 : 0;
    const radius = pose === 'excited' ? 4.5 : 4;
    return `<circle cx="${38 + look}" cy="56" r="${radius}" fill="#252938" /><circle cx="${58 + look}" cy="56" r="${radius}" fill="#252938" /><circle cx="${37 + look}" cy="54.5" r="1.3" fill="#fff" /><circle cx="${57 + look}" cy="54.5" r="1.3" fill="#fff" />`;
  }

  function mouth(pose) {
    if (pose === 'stress') return '<path d="M42 69q6-5 12 0" fill="none" stroke="#252938" stroke-width="2.5" stroke-linecap="round" />';
    if (pose === 'sleep') return '<path d="M45 67h6" fill="none" stroke="#252938" stroke-width="2.5" stroke-linecap="round" />';
    if (pose === 'excited') return '<path d="M41 66q7 10 14 0z" fill="#252938" />';
    if (pose === 'cheer' || pose === 'wave') return '<path d="M40 65q8 9 16 0" fill="none" stroke="#252938" stroke-width="2.7" stroke-linecap="round" />';
    return '<path d="M43 66q5 4 10 0" fill="none" stroke="#252938" stroke-width="2.4" stroke-linecap="round" />';
  }

  function arms(pose, accent) {
    const common = `fill="none" stroke="${accent}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"`;
    if (pose === 'excited' || pose === 'cheer') {
      return `<path d="M24 66Q13 55 12 42" ${common} /><circle cx="12" cy="39" r="4" fill="${accent}" /><path d="M72 66Q83 55 84 42" ${common} /><circle cx="84" cy="39" r="4" fill="${accent}" />`;
    }
    if (pose === 'point') {
      return `<path d="M24 67Q14 72 12 82" ${common} /><circle cx="11" cy="85" r="4" fill="${accent}" /><path d="M72 67Q82 76 85 93" ${common} /><path d="M81 91l5 4 2-6" ${common} />`;
    }
    if (pose === 'wave') {
      return `<path d="M24 67Q14 72 12 81" ${common} /><circle cx="11" cy="84" r="4" fill="${accent}" /><g><animateTransform attributeName="transform" type="rotate" values="-16 75 65;18 75 65;-16 75 65" dur=".55s" repeatCount="indefinite" /><path d="M72 66Q82 55 82 43" ${common} /><circle cx="82" cy="39" r="4" fill="${accent}" /></g>`;
    }
    return `<path d="M24 67Q14 72 12 82" ${common} /><circle cx="11" cy="85" r="4" fill="${accent}" /><path d="M72 67Q82 72 84 82" ${common} /><circle cx="85" cy="85" r="4" fill="${accent}" />`;
  }

  function extras(pose, accent) {
    if (pose === 'think') {
      return `<g fill="${accent}"><circle cx="73" cy="33" r="2"><animate attributeName="opacity" values=".2;1;.2" dur="1.2s" repeatCount="indefinite" /></circle><circle cx="80" cy="25" r="3"><animate attributeName="opacity" values=".2;.2;1;.2" dur="1.2s" repeatCount="indefinite" /></circle><circle cx="88" cy="15" r="4"><animate attributeName="opacity" values=".2;.2;.2;1;.2" dur="1.2s" repeatCount="indefinite" /></circle></g>`;
    }
    if (pose === 'stress') {
      return `<path d="M82 43c0-5 5-8 5-13 4 5 6 9 3 14-2 4-8 4-8-1z" fill="#72d9ef"><animateTransform attributeName="transform" type="translate" values="0 -2;0 5;0 -2" dur=".9s" repeatCount="indefinite" /></path>`;
    }
    if (pose === 'sleep') {
      return `<g fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M70 45h10l-10 10h10"><animate attributeName="opacity" values="0;1;0" dur="1.8s" repeatCount="indefinite" /></path><path d="M79 30h8l-8 8h8"><animate attributeName="opacity" values="0;0;1;0" dur="1.8s" repeatCount="indefinite" /></path></g>`;
    }
    if (pose === 'cheer') {
      return `<g fill="${accent}"><path d="M11 22l2 4 4 2-4 2-2 4-2-4-4-2 4-2z" /><path d="M84 18l2 4 4 2-4 2-2 4-2-4-4-2 4-2z" /><circle cx="20" cy="13" r="3" /><circle cx="75" cy="10" r="2.5" /></g>`;
    }
    return '';
  }

  function feet(pose, accent) {
    if (pose === 'walk') {
      return `<g fill="${accent}"><ellipse cx="34" cy="99" rx="10" ry="5"><animateTransform attributeName="transform" type="translate" values="0 0;4 -4;0 0" dur=".42s" repeatCount="indefinite" /></ellipse><ellipse cx="62" cy="99" rx="10" ry="5"><animateTransform attributeName="transform" type="translate" values="0 0;-4 4;0 0" dur=".42s" repeatCount="indefinite" /></ellipse></g>`;
    }
    return `<ellipse cx="34" cy="99" rx="10" ry="5" fill="${accent}" /><ellipse cx="62" cy="99" rx="10" ry="5" fill="${accent}" />`;
  }

  function orbit(pose, colour) {
    const accent = safeColour(colour);
    const id = `orbit-${nextId++}`;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 96 120');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Orbit, ${pose}`);
    svg.classList.add('vector-buddy', 'vector-orbit');
    svg.dataset.pose = pose;
    svg.innerHTML = `
      <defs>
        <linearGradient id="${id}-shell" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#ffffff" />
          <stop offset="1" stop-color="#dfe6ee" />
        </linearGradient>
        <filter id="${id}-shadow" x="-40%" y="-40%" width="180%" height="200%">
          <feDropShadow dx="0" dy="5" stdDeviation="4" flood-color="#000" flood-opacity=".35" />
        </filter>
      </defs>
      ${extras(pose, accent)}
      <g filter="url(#${id}-shadow)">
        ${motion(pose)}
        ${feet(pose, accent)}
        ${arms(pose, accent)}
        <path d="M48 32V20" stroke="#252938" stroke-width="4" stroke-linecap="round" />
        <circle cx="48" cy="16" r="6" fill="${accent}" stroke="#252938" stroke-width="3">
          <animate attributeName="r" values="5;6.5;5" dur="${pose === 'think' ? '.8s' : '2s'}" repeatCount="indefinite" />
        </circle>
        <rect x="19" y="29" width="58" height="65" rx="27" fill="url(#${id}-shell)" stroke="#252938" stroke-width="4" />
        <path d="M24 47q24-20 48 0" fill="none" stroke="${accent}" stroke-width="4" stroke-linecap="round" opacity=".9" />
        <rect x="27" y="45" width="42" height="36" rx="17" fill="#eef8fa" stroke="#a8b8c5" stroke-width="2" />
        ${eyes(pose)}
        ${mouth(pose)}
        <circle cx="25" cy="69" r="3" fill="${accent}" opacity=".65" />
        <circle cx="71" cy="69" r="3" fill="${accent}" opacity=".65" />
      </g>`;
    return svg;
  }

  /* ---------- Loopy: the paperclip itself, redrawn as smooth vector ---------- */

  /**
   * Loopy has no mouth, just like the 1997 original: the eyebrows do all the
   * talking. The wire is one continuous path stroked three times — ink, then
   * session colour, then a thin off-centre white line for the metal shine.
   */
  const INK = '#252938';

  function clipBrows(pose) {
    const common = `fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round"`;
    if (pose === 'sleep') return '';
    if (pose === 'stress') return `<path d="M30 4l14 5M66 4l-14 5" ${common} />`;
    const arcs = (dy = 0) => `<path d="M31 ${6 + dy}q8-5 16 0M49 ${6 + dy}q8-5 16 0" ${common} />`;
    if (pose === 'wave') {
      // The classic greeting: the eyebrow waggle.
      return `<g>${arcs()}<animateTransform attributeName="transform" type="translate" values="0 0;0 -4;0 0;0 -4;0 0" dur="1s" repeatCount="indefinite" /></g>`;
    }
    if (pose === 'excited' || pose === 'cheer') return arcs(-3);
    return arcs();
  }

  function clipEyes(pose) {
    const lid = `fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"`;
    if (pose === 'sleep') return `<path d="M31 20q8 6 16 0M49 20q8 6 16 0" ${lid} />`;
    if (pose === 'cheer') return `<path d="M31 21q8-8 16 0M49 21q8-8 16 0" ${lid} />`;
    const whites =
      `<ellipse cx="39" cy="19" rx="8.6" ry="10.4" fill="#fff" stroke="${INK}" stroke-width="2.6" />` +
      `<ellipse cx="57" cy="19" rx="8.6" ry="10.4" fill="#fff" stroke="${INK}" stroke-width="2.6" />`;
    if (pose === 'stress') {
      return `${whites}<circle cx="39" cy="21" r="2.6" fill="${INK}" /><circle cx="57" cy="21" r="2.6" fill="${INK}" />`;
    }
    const [dx, dy] = { think: [-2, -3.5], point: [2.5, 3], walk: [2.5, 0] }[pose] || [0, 0];
    const r = pose === 'excited' ? 4.4 : 3.6;
    const pupil = (cx) =>
      `<circle cx="${cx + dx}" cy="${19 + dy}" r="${r}" fill="${INK}" />` +
      `<circle cx="${cx + dx - 1.2}" cy="${17.6 + dy}" r="1.1" fill="#fff" />`;
    const eyes = whites + pupil(39) + pupil(57);
    if (pose !== 'idle') return eyes;
    // Idle blinks: squash the whole eye group flat around its own centre line.
    return `<g transform="translate(0 19)"><g><animateTransform attributeName="transform" type="scale" values="1 1;1 1;1 .06;1 1" keyTimes="0;.9;.94;1" dur="4.4s" repeatCount="indefinite" /><g transform="translate(0 -19)">${eyes}</g></g></g>`;
  }

  function loopy(pose, colour) {
    const accent = safeColour(colour);
    const id = `loopy-${nextId++}`;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 96 120');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Loopy, ${pose}`);
    svg.classList.add('vector-buddy', 'vector-loopy');
    svg.dataset.pose = pose;
    // Outer wire up and over the top, down, the bottom hook, then the inner
    // wire ending open — a paperclip in one path.
    const wire = 'M36 98V32a12 12 0 0 1 24 0v52a9 9 0 0 1-18 0V42a5 5 0 0 1 10 0v30';
    // Walking and pointing lean the whole clip from its feet.
    const lean = pose === 'walk' ? 'rotate(9 48 98)' : pose === 'point' ? 'rotate(16 48 98)' : '';
    svg.innerHTML = `
      <defs>
        <filter id="${id}-shadow" x="-40%" y="-40%" width="180%" height="200%">
          <feDropShadow dx="0" dy="5" stdDeviation="4" flood-color="#000" flood-opacity=".35" />
        </filter>
      </defs>
      ${pose === 'stress' ? `<g transform="translate(-11 4)">${extras(pose, accent)}</g>` : extras(pose, accent)}
      <g filter="url(#${id}-shadow)">
        ${motion(pose)}
        <g${lean ? ` transform="${lean}"` : ''}>
          <path d="${wire}" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round" />
          <path d="${wire}" fill="none" stroke="${accent}" stroke-width="6" stroke-linecap="round" />
          <path d="${wire}" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".4" transform="translate(-1.4 -1.4)" />
          ${clipBrows(pose)}
          ${clipEyes(pose)}
        </g>
      </g>`;
    return svg;
  }

  const DRAWINGS = { orbit, loopy };

  function create(name, pose = 'idle', colour = '#9aa3ad') {
    const draw = DRAWINGS[name];
    if (!draw) return null;
    return draw(POSES.has(pose) ? pose : 'idle', colour);
  }

  return { create, has: (name) => Boolean(DRAWINGS[name]), poses: [...POSES] };
});
