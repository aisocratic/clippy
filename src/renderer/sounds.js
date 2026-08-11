'use strict';

// Tiny synthesized cues keep Clippy self-contained: there are no licensed
// sound files to ship, and each choice is short enough to announce a buddy
// without becoming another notification competing for attention.
(function () {
  let context = null;

  const RECIPES = {
    pop: [
      { at: 0, from: 520, to: 760, length: 0.09, type: 'sine', gain: 0.055 },
      { at: 0.045, from: 760, to: 980, length: 0.08, type: 'sine', gain: 0.035 },
    ],
    chime: [
      { at: 0, from: 659, to: 659, length: 0.2, type: 'sine', gain: 0.045 },
      { at: 0.1, from: 988, to: 988, length: 0.26, type: 'sine', gain: 0.04 },
    ],
    chirp: [
      { at: 0, from: 920, to: 1320, length: 0.08, type: 'triangle', gain: 0.04 },
      { at: 0.1, from: 1080, to: 1540, length: 0.1, type: 'triangle', gain: 0.035 },
    ],
  };

  function play(name) {
    const recipe = RECIPES[name];
    if (!recipe || !window.AudioContext) return false;
    context ||= new AudioContext();
    if (context.state === 'suspended') context.resume().catch(() => {});
    const now = context.currentTime + 0.01;
    for (const note of recipe) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = now + note.at;
      const end = start + note.length;
      oscillator.type = note.type;
      oscillator.frequency.setValueAtTime(note.from, start);
      oscillator.frequency.exponentialRampToValueAtTime(note.to, end);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(note.gain, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(end + 0.02);
    }
    return true;
  }

  window.ClippySounds = { play, choices: Object.keys(RECIPES) };
})();
