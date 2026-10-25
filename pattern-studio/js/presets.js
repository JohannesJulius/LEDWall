/*
 * Vorlagen (Start-Patterns) und Farbpaletten für das Pattern Studio.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./renderer.js') : root.LEDRenderer);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LEDPresets = api;
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  const PALETTES = {
    'Regenbogen': ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff'],
    'Feuer': ['#000000', '#600000', '#ff3000', '#ffb000', '#ffffa0'],
    'Ozean': ['#001040', '#0060ff', '#00e0ff', '#80ffff'],
    'Neon': ['#ff0080', '#00ffff', '#ffff00', '#8000ff'],
    'Sunset': ['#2a0050', '#ff0060', '#ff8000', '#ffd000'],
    'Wald': ['#002000', '#00a040', '#80ff00', '#ffff80'],
    'Eis': ['#ffffff', '#a0e0ff', '#2060ff'],
    'Polizei': ['#ff0000', '#0000ff'],
    'Weiß': ['#ffffff'],
    'Schwarz/Weiß': ['#ffffff', '#000000'],
    'Matrix': ['#d0ffd0', '#00ff40', '#004010'],
    'Lava': ['#200000', '#ff2000', '#ff8000', '#200000'],
  };

  const L = (type, o) => R.makeLayer(type, o);

  const PRESETS = [
    { name: 'Regenbogen-Welle', loopBeats: 4, layers: () => [
      L('gradient', { params: { size: 64, speed: 0.25 }, transform: { angle: 20 } }),
    ] },
    { name: 'Beat-Puls', loopBeats: 4, layers: () => [
      L('solid', { params: { mode: 'cycle', rate: 1 }, palette: PALETTES['Neon'], envelope: { mode: 'pulse', decay: 0.5 } }),
    ] },
    { name: 'Ringe', loopBeats: 4, layers: () => [
      L('stripes', { params: { shape: 'radial', size: 10, duty: 0.45, softness: 0.25, speed: 0.5 }, palette: ['#0060ff', '#00e0ff'] }),
    ] },
    { name: 'Plasma', loopBeats: 8, layers: () => [
      L('plasma', { params: { scale: 7, speed: 0.125, colorSpeed: 0.125 } }),
    ] },
    { name: 'Feuer', loopBeats: 4, layers: () => [
      L('noise', { name: 'Glut', params: { scale: 7, speed: 0.25, octaves: 2, contrast: 1.4 }, palette: PALETTES['Feuer'] }),
      L('gradient', { name: 'Abdunkeln oben', blend: 'multiply', paletteBlend: 'smooth', palette: ['#000000', '#ffffff'],
        params: { size: 96, speed: 0 }, transform: { angle: 90, cy: 0 } }),
    ] },
    { name: 'Sternenhimmel', loopBeats: 4, layers: () => [
      L('solid', { name: 'Hintergrund', palette: ['#000818'] }),
      L('sparkle', { params: { density: 0.03, rate: 4, life: 0.75 }, blend: 'add' }),
    ] },
    { name: 'Matrix-Regen', loopBeats: 4, layers: () => [
      L('rain', { params: { speed: 0.75, trail: 16, density: 0.7 } }),
    ] },
    { name: 'Spirale', loopBeats: 4, layers: () => [
      L('stripes', { params: { shape: 'spiral', size: 24, arms: 3, duty: 0.5, softness: 0.2, speed: 1 }, palette: PALETTES['Neon'] }),
    ] },
    { name: 'Schachbrett-Flip', loopBeats: 2, layers: () => [
      L('checker', { params: { size: 8, flipRate: 1 }, envelope: { mode: 'pulse', decay: 0.3, min: 0.2 } }),
    ] },
    { name: 'Scanner', loopBeats: 4, layers: () => [
      L('scanner', { params: { width: 3, speed: 0.25, mode: 'bounce', trail: 18 } }),
    ] },
    { name: 'Kaleidoskop', loopBeats: 8, layers: () => [
      L('plasma', { params: { scale: 6, speed: 0.125, colorSpeed: 0.125 }, transform: { kaleido: 6, rotate: 0.125 } }),
    ] },
    { name: 'Strobe', loopBeats: 1, layers: () => [
      L('solid', { palette: ['#ffffff'], envelope: { mode: 'strobe', rate: 2, duty: 0.25 } }),
    ] },
    { name: 'Herzschlag', loopBeats: 1, layers: () => [
      L('shape', { params: { shape: 'heart', size: 14, pulse: 0.5 }, palette: ['#ff1040'], envelope: { mode: 'pulse', decay: 0.2, min: 0.3 } }),
    ] },
    { name: 'Wellen', loopBeats: 2, layers: () => [
      L('wave', { params: { count: 3, spacing: 12, amplitude: 8, wavelength: 64, speed: 0.5, thickness: 3 } }),
    ] },
    { name: 'Tunnel', loopBeats: 4, layers: () => [
      L('stripes', { params: { shape: 'square', size: 6, duty: 0.5, softness: 0.1, speed: 1 }, palette: PALETTES['Sunset'], hueShift: 0.25 }),
    ] },
    { name: 'Polizei', loopBeats: 2, layers: () => [
      L('gradient', { paletteBlend: 'steps', palette: ['#ff0000', '#0000ff'], params: { size: 64, speed: 0 },
        envelope: { mode: 'strobe', rate: 4, duty: 0.5 } }),
    ] },
  ];

  function instantiate(preset) {
    return R.makePattern(preset.name, preset.layers(), preset.loopBeats);
  }

  return { PALETTES, PRESETS, instantiate };
});
