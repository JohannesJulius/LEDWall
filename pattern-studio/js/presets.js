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

    // ---------------------------------------------------------------- Hard Techno
    // Schnell, hart, viel Kontrast: Rot/Weiß/Schwarz, Strobos auf der Kick, Bewegung im Takt.
    { group: 'Hard Techno', name: 'HT Kick-Blitz', loopBeats: 1, layers: () => [
      L('solid', { name: 'Glut', palette: ['#250000'] }),
      L('solid', { name: 'Kick', palette: ['#ffffff'], blend: 'add', envelope: { mode: 'pulse', decay: 0.9 } }),
      L('shape', { name: 'Druckwelle', params: { shape: 'circle', size: 14, thickness: 3, pulse: 1.0 }, palette: ['#ff1030'], blend: 'add',
        envelope: { mode: 'sawDown' } }),
    ] },
    { group: 'Hard Techno', name: 'HT Strobo 1/16', loopBeats: 1, layers: () => [
      L('solid', { palette: ['#ffffff'], envelope: { mode: 'strobe', rate: 4, duty: 0.18 } }),
    ] },
    { group: 'Hard Techno', name: 'HT Rote Hämmer', loopBeats: 4, layers: () => [
      L('shape', { name: 'Hammer', params: { shape: 'square', size: 6, pulse: 0.8, tile: 32 }, palette: ['#ff0020'],
        envelope: { mode: 'pulse', decay: 0.6, min: 0.15 } }),
      L('solid', { name: 'Offbeat-Blitz', palette: ['#ffffff'], blend: 'add', envelope: { mode: 'strobe', rate: 1, duty: 0.08, phase: 0.5 } }),
    ] },
    { group: 'Hard Techno', name: 'HT Acid-Tunnel', loopBeats: 4, layers: () => [
      L('stripes', { params: { shape: 'square', size: 4, duty: 0.5, softness: 0.05, speed: 2 }, palette: ['#b6ff00', '#000000'],
        envelope: { mode: 'pulse', decay: 0.6, min: 0.35 } }),
      L('solid', { name: 'Kick', palette: ['#ffffff'], blend: 'add', opacity: 0.5, envelope: { mode: 'pulse', decay: 0.95 } }),
    ] },
    { group: 'Hard Techno', name: 'HT Laser-Fächer', loopBeats: 4, layers: () => [
      L('stripes', { params: { shape: 'angular', arms: 12, duty: 0.18, softness: 0.15, speed: 0 }, palette: ['#ff0030', '#ffffff'],
        transform: { rotate: 0.25, cy: 1.1 }, envelope: { mode: 'pulse', decay: 0.5, min: 0.3 } }),
      L('stripes', { name: 'Gegenfächer', params: { shape: 'angular', arms: 8, duty: 0.1, softness: 0.1, speed: 0 }, palette: ['#ffffff'],
        transform: { rotate: -0.25, cy: 1.1 }, blend: 'add', opacity: 0.6, envelope: { mode: 'strobe', rate: 2, duty: 0.5, phase: 0.5 } }),
    ] },
    { group: 'Hard Techno', name: 'HT Industrie-Scanner', loopBeats: 2, layers: () => [
      L('scanner', { name: 'Rot waagrecht', params: { width: 4, speed: 1, mode: 'bounce', trail: 30 }, palette: ['#ff0020'] }),
      L('scanner', { name: 'Weiß senkrecht', params: { width: 2, speed: 0.5, mode: 'bounce', trail: 12 }, palette: ['#ffffff'],
        transform: { angle: 90 }, blend: 'add' }),
      L('solid', { name: 'Kick', palette: ['#ff0020'], blend: 'add', opacity: 0.35, envelope: { mode: 'pulse', decay: 0.9 } }),
    ] },
    { group: 'Hard Techno', name: 'HT Glitch-Rauschen', loopBeats: 2, layers: () => [
      L('noise', { params: { scale: 3, speed: 2, octaves: 1, contrast: 3 }, palette: ['#000000', '#000000', '#ff0040', '#ffffff'],
        envelope: { mode: 'random', rate: 8, duty: 0.6 } }),
      L('stripes', { name: 'Scanlines', params: { shape: 'linear', size: 4, duty: 0.25, softness: 0, speed: 0 }, palette: ['#000000'],
        transform: { angle: 90 }, opacity: 0.6 }),
    ] },
    { group: 'Hard Techno', name: 'HT Schockwelle', loopBeats: 1, layers: () => [
      L('stripes', { params: { shape: 'radial', size: 14, duty: 0.25, softness: 0.3, speed: 2 }, palette: ['#ffffff', '#ff0020'],
        envelope: { mode: 'sawDown', min: 0.1 } }),
    ] },
    { group: 'Hard Techno', name: 'HT Doppel-Checker', loopBeats: 2, layers: () => [
      L('checker', { params: { size: 8, flipRate: 2 }, palette: ['#ff0030', '#000000'], envelope: { mode: 'pulse', rate: 2, decay: 0.4, min: 0.2 } }),
      L('checker', { name: 'Grob weiß', params: { size: 24, flipRate: 1 }, palette: ['#ffffff', '#000000'], blend: 'multiply' }),
    ] },
    { group: 'Hard Techno', name: 'HT Sirenen-Rotor', loopBeats: 2, layers: () => [
      L('gradient', { params: { shape: 'angular', arms: 2, size: 64, speed: 1 }, palette: ['#ff0000', '#000000', '#000000'] }),
      L('gradient', { name: 'Blau gegenläufig', params: { shape: 'angular', arms: 2, size: 64, speed: -1 }, palette: ['#0030ff', '#000000', '#000000'],
        blend: 'add', opacity: 0.7 }),
      L('solid', { name: 'Kick', palette: ['#ffffff'], blend: 'add', opacity: 0.4, envelope: { mode: 'pulse', decay: 0.95 } }),
    ] },
    { group: 'Hard Techno', name: 'HT Bass-Regen', loopBeats: 4, layers: () => [
      L('rain', { params: { speed: 3, trail: 20, density: 0.9 }, palette: ['#ffffff', '#ff0030', '#300000'],
        envelope: { mode: 'pulse', decay: 0.5, min: 0.4 } }),
    ] },
    { group: 'Hard Techno', name: 'HT Peak-Time', loopBeats: 8, layers: () => [
      L('plasma', { params: { scale: 4, speed: 1, colorSpeed: 0.5 }, palette: ['#ff0020', '#000000', '#ffffff', '#000000'],
        transform: { kaleido: 8, rotate: 0.125 }, envelope: { mode: 'pulse', decay: 0.4, min: 0.35 } }),
      L('solid', { name: 'Strobo', palette: ['#ffffff'], blend: 'add', opacity: 0.7, envelope: { mode: 'strobe', rate: 4, duty: 0.12 } }),
    ] },

    // ---------------------------------------------------------------- Set November
    // Melodic / Progressive / Tech / Afro House um 120–128 BPM (Playlist „Set November“).
    // Weiche Farben, lange Loops, die Kick als sanfter Puls statt hartem Strobo. Zuordnung der
    // Tracks: docs/set-november.md
    { group: 'Set November', name: 'SN Ozean-Atmen', loopBeats: 8, layers: () => [
      L('gradient', { params: { shape: 'linear', size: 96, speed: 0.125 }, palette: ['#001830', '#00507a', '#00b4c8', '#00507a'],
        transform: { angle: 70 } }),
      L('wave', { name: 'Dünung', params: { count: 3, spacing: 10, amplitude: 4, wavelength: 64, speed: 0.25, thickness: 2 },
        palette: ['#80f0ff'], blend: 'add', opacity: 0.45, envelope: { mode: 'sine', rate: 0.25, min: 0.3 } }),
    ] },
    { group: 'Set November', name: 'SN Afterglow', loopBeats: 8, layers: () => [
      L('gradient', { params: { shape: 'linear', size: 80, speed: 0.125 }, palette: ['#1a0030', '#a0005a', '#ff5a1e', '#ffb43c', '#a0005a'],
        transform: { angle: 100 } }),
      L('solid', { name: 'Kick', palette: ['#ffd8a0'], blend: 'add', opacity: 0.25, envelope: { mode: 'pulse', decay: 0.7 } }),
    ] },
    { group: 'Set November', name: 'SN Inner Light', loopBeats: 8, layers: () => [
      L('solid', { name: 'Nacht', palette: ['#06001a'] }),
      L('stripes', { name: 'Strahlen', params: { shape: 'angular', arms: 10, duty: 0.35, softness: 0.5, speed: 0 }, palette: ['#ffd27a', '#000000'],
        transform: { rotate: 0.125 }, blend: 'add', envelope: { mode: 'pulse', decay: 0.5, min: 0.5 } }),
      L('shape', { name: 'Kern', params: { shape: 'circle', size: 5, pulse: 0.4 }, palette: ['#fff4dc'], blend: 'add',
        envelope: { mode: 'pulse', decay: 0.6, min: 0.5 } }),
    ] },
    { group: 'Set November', name: 'SN Generate', loopBeats: 16, layers: () => [
      L('plasma', { params: { scale: 6, speed: 0.0625, colorSpeed: 0.0625 }, palette: ['#14003c', '#5a00c8', '#00c8ff', '#14003c'],
        transform: { kaleido: 6, rotate: 0.0625 } }),
      L('solid', { name: 'Kick', palette: ['#b4f0ff'], blend: 'add', opacity: 0.3, envelope: { mode: 'pulse', decay: 0.8 } }),
    ] },
    { group: 'Set November', name: 'SN Arpeggio', loopBeats: 4, layers: () => [
      L('gradient', { name: 'Grund', params: { shape: 'linear', size: 96, speed: 0.25 }, palette: ['#0a0030', '#1e0050', '#0a0030'] }),
      L('scanner', { name: 'Sechzehntel', params: { width: 3, speed: 1, mode: 'bounce', trail: 22 }, palette: ['#00e6ff'], blend: 'add' }),
      L('scanner', { name: 'Gegenstimme', params: { width: 3, speed: 0.5, mode: 'bounce', trail: 16 }, palette: ['#c800ff'],
        transform: { angle: 90 }, blend: 'add', opacity: 0.85 }),
    ] },
    { group: 'Set November', name: 'SN Groove', loopBeats: 4, layers: () => [
      L('checker', { params: { size: 16, flipRate: 1 }, palette: ['#ff3c78', '#140028'], envelope: { mode: 'pulse', decay: 0.55, min: 0.35 } }),
      L('sparkle', { name: 'Hi-Hats', params: { density: 0.04, rate: 2, life: 0.3, cell: 2 }, palette: ['#ffffff', '#ffd0f0'], blend: 'add',
        envelope: { mode: 'strobe', rate: 1, duty: 0.25, phase: 0.5 } }),
    ] },
    { group: 'Set November', name: 'SN Offbeat-Bass', loopBeats: 4, layers: () => [
      L('stripes', { params: { shape: 'diamond', size: 10, duty: 0.4, softness: 0.3, speed: 0.5 }, palette: ['#00ffb4', '#001e28'] }),
      L('solid', { name: 'Kick', palette: ['#000000'], blend: 'multiply', opacity: 0.55, envelope: { mode: 'pulse', decay: 0.6 } }),
      L('solid', { name: 'Offbeat', palette: ['#ffffff'], blend: 'add', opacity: 0.35, envelope: { mode: 'pulse', decay: 0.8, phase: 0.5 } }),
    ] },
    { group: 'Set November', name: 'SN Drop', loopBeats: 4, layers: () => [
      L('stripes', { params: { shape: 'radial', size: 8, duty: 0.5, softness: 0.3, speed: 1 }, palette: ['#ff2a6d', '#000000', '#05d9e8', '#000000'],
        envelope: { mode: 'pulse', decay: 0.5, min: 0.3 } }),
      L('solid', { name: 'Tiefe', palette: ['#000000'], blend: 'multiply', opacity: 0.5, envelope: { mode: 'sawUp', rate: 1 } }),
      L('solid', { name: 'Achtel-Blitz', palette: ['#ffffff'], blend: 'add', opacity: 0.3, envelope: { mode: 'strobe', rate: 2, duty: 0.1 } }),
    ] },
    { group: 'Set November', name: 'SN Afro-Sonne', loopBeats: 8, layers: () => [
      L('stripes', { params: { shape: 'radial', size: 9, duty: 0.5, softness: 0.4, speed: 0.375 }, palette: ['#ff8c00', '#5a1400', '#ffc832'] }),
      L('stripes', { name: 'Speichen', params: { shape: 'angular', arms: 6, duty: 0.35, softness: 0.4, speed: 0 }, palette: ['#000000', '#ffffff'],
        transform: { rotate: -0.125 }, blend: 'multiply', opacity: 0.5 }),
      L('solid', { name: 'Kick', palette: ['#ffe0a0'], blend: 'add', opacity: 0.3, envelope: { mode: 'pulse', decay: 0.7 } }),
    ] },
    { group: 'Set November', name: 'SN Fire Fire', loopBeats: 4, layers: () => [
      L('noise', { params: { scale: 6, speed: 0.5, octaves: 2, contrast: 1.5 }, palette: ['#100000', '#a01400', '#ff6400', '#ffd250'],
        envelope: { mode: 'pulse', decay: 0.4, min: 0.45 } }),
      L('gradient', { name: 'Abdunkeln oben', blend: 'multiply', palette: ['#000000', '#ffffff'], params: { size: 96, speed: 0 },
        transform: { angle: 90, cy: 0 } }),
    ] },
    { group: 'Set November', name: 'SN Euphorie', loopBeats: 8, layers: () => [
      L('gradient', { params: { shape: 'radial', size: 48, speed: -0.25 }, palette: ['#ff0080', '#ff8000', '#ffe000', '#00ffa0', '#0080ff', '#a000ff'] }),
      L('solid', { name: 'Kick', palette: ['#ffffff'], blend: 'add', opacity: 0.4, envelope: { mode: 'pulse', decay: 0.85 } }),
    ] },
    { group: 'Set November', name: 'SN Mondfahrt', loopBeats: 8, layers: () => [
      L('solid', { name: 'All', palette: ['#02001a'] }),
      L('rain', { name: 'Sterne steigen', params: { speed: 0.5, trail: 6, density: 0.35 }, palette: ['#ffffff', '#8ab4ff', '#000000'],
        transform: { angle: 180 }, blend: 'add' }),
      L('shape', { name: 'Mond', params: { shape: 'circle', size: 9, pulse: 0.15 }, palette: ['#fff6d8'], blend: 'add',
        envelope: { mode: 'sine', rate: 0.5, min: 0.6 } }),
    ] },
    { group: 'Set November', name: 'SN Build-Up 16', loopBeats: 16, layers: () => [
      L('stripes', { name: 'Tunnel', params: { shape: 'square', size: 6, duty: 0.4, softness: 0.2, speed: 1 }, palette: ['#6a3cff', '#000010'],
        envelope: { mode: 'sawUp', rate: 0.0625, min: 0.1 } }),
      L('solid', { name: 'Kick', palette: ['#8a5cff'], blend: 'add', opacity: 0.3,
        envelope: { mode: 'pulse', decay: 0.85 } }),
      L('gradient', { name: 'Ende hell', params: { shape: 'radial', size: 40, speed: 0 }, palette: ['#ffffff', '#000000'], blend: 'add',
        envelope: { mode: 'sawUp', rate: 0.0625 }, opacity: 0.6 }),
    ] },
    { group: 'Set November', name: 'SN Nachtclub', loopBeats: 4, layers: () => [
      L('gradient', { params: { shape: 'angular', arms: 2, size: 64, speed: 0.5 }, palette: ['#ff0040', '#000000', '#7800ff', '#000000'] }),
      L('solid', { name: 'Kick', palette: ['#ff0040'], blend: 'add', opacity: 0.35, envelope: { mode: 'pulse', decay: 0.9 } }),
    ] },
    { group: 'Set November', name: 'SN Polarlicht', loopBeats: 16, layers: () => [
      L('noise', { params: { scale: 10, speed: 0.0625, octaves: 2, contrast: 1.3 }, palette: ['#000814', '#00503c', '#00ff8c', '#5a00b4', '#000814'] }),
      L('gradient', { name: 'Horizont', blend: 'multiply', palette: ['#ffffff', '#202020'], params: { size: 96, speed: 0 }, transform: { angle: 90 } }),
    ] },
    { group: 'Set November', name: 'SN Disco-Glitzer', loopBeats: 4, layers: () => [
      L('solid', { name: 'Samt', palette: ['#1e0014'] }),
      L('sparkle', { params: { density: 0.08, rate: 4, life: 0.5, cell: 2 }, palette: ['#ffd700', '#ffffff', '#ff8cc8'], blend: 'add' }),
      L('solid', { name: 'Kick', palette: ['#ffb000'], blend: 'add', opacity: 0.2, envelope: { mode: 'pulse', decay: 0.8 } }),
    ] },
    { group: 'Set November', name: 'SN Herzlicht', loopBeats: 4, layers: () => [
      L('solid', { name: 'Hintergrund', palette: ['#14000a'] }),
      L('shape', { params: { shape: 'heart', size: 13, pulse: 0.35 }, palette: ['#ff2d78'], blend: 'add',
        envelope: { mode: 'pulse', decay: 0.4, min: 0.4 } }),
    ] },
    { group: 'Set November', name: 'SN Echo-Ringe', loopBeats: 4, layers: () => [
      L('solid', { name: 'Grund', palette: ['#000a18'] }),
      L('stripes', { params: { shape: 'radial', size: 10, duty: 0.3, softness: 0.45, speed: -0.5 }, palette: ['#a0e6ff', '#000000'], blend: 'add',
        envelope: { mode: 'pulse', decay: 0.35, min: 0.45 } }),
      L('shape', { name: 'Quelle', params: { shape: 'circle', size: 4, pulse: 0.5 }, palette: ['#ffffff'], blend: 'add',
        envelope: { mode: 'pulse', decay: 0.7 } }),
    ] },
  ];

  function instantiate(preset) {
    return R.makePattern(preset.name, preset.layers(), preset.loopBeats);
  }

  return { PALETTES, PRESETS, instantiate };
});
