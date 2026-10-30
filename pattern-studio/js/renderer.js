/*
 * LEDWall Pattern Renderer
 *
 * Reine Render-Logik ohne DOM-Abhängigkeiten. Wird von der Pattern-Studio-App
 * (Browser) und den Tests (Node) gleichermaßen benutzt. Alle Zeitangaben sind
 * in BEATS, nicht in Sekunden: ein Pattern sieht bei jeder BPM gleich aus,
 * nur schneller oder langsamer. Die eigentliche Geschwindigkeit bestimmt
 * später der Pico 2W.
 *
 * Bewusst einfach gehalten (nur sin/cos/atan2/floor/Hash), damit sich die
 * Effekte bei Bedarf 1:1 nach C für den RP2040 portieren lassen.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LEDRenderer = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TAU = Math.PI * 2;

  const LAYER_TYPES = {
    solid: 'Vollfarbe',
    gradient: 'Verlauf',
    stripes: 'Streifen / Ringe',
    plasma: 'Plasma',
    noise: 'Rauschen / Feuer',
    checker: 'Schachbrett',
    sparkle: 'Funkeln',
    rain: 'Regen / Matrix',
    wave: 'Welle',
    shape: 'Form',
    scanner: 'Scanner',
    draw: 'Zeichnung',
  };

  const DEFAULT_PARAMS = {
    solid: { mode: 'static', rate: 1 },
    gradient: { shape: 'linear', size: 64, speed: 0.25, arms: 1 },
    stripes: { shape: 'linear', size: 8, duty: 0.5, softness: 0.1, speed: 0.5, arms: 4 },
    plasma: { scale: 8, speed: 0.25, colorSpeed: 0 },
    noise: { scale: 8, speed: 0.25, octaves: 2, contrast: 1.2 },
    checker: { size: 8, flipRate: 1 },
    sparkle: { density: 0.03, rate: 4, life: 0.5, cell: 1 },
    rain: { speed: 1, trail: 12, density: 0.7, cell: 1 },
    wave: { amplitude: 10, wavelength: 48, speed: 0.5, thickness: 3, fill: false, count: 1, spacing: 8 },
    shape: { shape: 'circle', size: 12, thickness: 0, pulse: 0.3, moveX: 0, moveY: 0, moveRate: 0.25, tile: 0, colorSpeed: 0 },
    scanner: { width: 4, speed: 0.25, mode: 'bounce', trail: 12 },
    draw: { pixels: '', wrap: true },
  };

  const DEFAULT_PALETTES = {
    solid: ['#ff0040', '#00c8ff', '#ffd000', '#a000ff'],
    gradient: ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff'],
    stripes: ['#00e5ff', '#ff00aa'],
    plasma: ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff'],
    noise: ['#000000', '#600000', '#ff3000', '#ffb000', '#ffffa0'],
    checker: ['#ffffff', '#000000'],
    sparkle: ['#ffffff', '#a0d8ff'],
    rain: ['#d0ffd0', '#00ff40', '#004010'],
    wave: ['#00ffcc', '#ff00ff', '#ffff00'],
    shape: ['#ff2050'],
    scanner: ['#ff0000'],
    draw: ['#ffffff'],
  };

  const DEFAULT_TRANSFORM = {
    cx: 0.5, cy: 0.5, angle: 0, rotate: 0, zoom: 1,
    scrollX: 0, scrollY: 0, mirrorX: false, mirrorY: false, kaleido: 0,
  };

  const DEFAULT_ENVELOPE = { mode: 'none', rate: 1, duty: 0.5, decay: 0.5, phase: 0, min: 0 };

  // ---------------------------------------------------------------- helpers

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
  function frac(x) { return x - Math.floor(x); }
  function mod(a, n) { return ((a % n) + n) % n; }

  let idCounter = 0;
  function newId(prefix) {
    idCounter++;
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + idCounter.toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }

  // Deterministischer Integer-Hash -> [0, 1). In C mit uint32_t identisch nachbaubar.
  function hash3(a, b, c) {
    let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function hexToRgb(hex) {
    let h = String(hex || '#000000').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function rgbToHex(r, g, b) {
    const c = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
  }

  // ---------------------------------------------------------------- base64

  function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined' && typeof btoa === 'undefined') return Buffer.from(bytes).toString('base64');
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function base64ToBytes(str) {
    if (typeof Buffer !== 'undefined' && typeof atob === 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // Dekodierte Bitmaps der Zeichen-Ebenen cachen (Schlüssel: base64-String).
  const bitmapCache = new Map();
  function decodeBitmap(str, w, h) {
    const key = w + 'x' + h + ':' + str;
    let bmp = bitmapCache.get(key);
    if (bmp) return bmp;
    bmp = new Uint8Array(w * h * 4);
    if (str) {
      const raw = base64ToBytes(str);
      bmp.set(raw.subarray(0, Math.min(raw.length, bmp.length)));
    }
    if (bitmapCache.size > 64) bitmapCache.clear();
    bitmapCache.set(key, bmp);
    return bmp;
  }
  function encodeBitmap(bytes) {
    let empty = true;
    for (let i = 3; i < bytes.length; i += 4) if (bytes[i]) { empty = false; break; }
    return empty ? '' : bytesToBase64(bytes);
  }

  // ---------------------------------------------------------------- model

  function makeLayer(type, overrides) {
    if (!LAYER_TYPES[type]) throw new Error('Unbekannter Ebenentyp: ' + type);
    const layer = {
      id: newId('layer'),
      name: LAYER_TYPES[type],
      type,
      enabled: true,
      blend: 'normal',
      opacity: 1,
      lumaKey: false,
      palette: DEFAULT_PALETTES[type].slice(),
      paletteBlend: 'smooth',
      hueShift: 0,
      hueOffset: 0,
      transform: clone(DEFAULT_TRANSFORM),
      envelope: clone(DEFAULT_ENVELOPE),
      params: clone(DEFAULT_PARAMS[type]),
    };
    if (overrides) {
      for (const k of Object.keys(overrides)) {
        const v = overrides[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && layer[k] && typeof layer[k] === 'object' && !Array.isArray(layer[k])) {
          Object.assign(layer[k], v);
        } else {
          layer[k] = clone(v);
        }
      }
    }
    return layer;
  }

  function normalizeLayer(l) {
    const base = makeLayer(LAYER_TYPES[l.type] ? l.type : 'solid');
    const out = Object.assign(base, l);
    out.transform = Object.assign(clone(DEFAULT_TRANSFORM), l.transform || {});
    out.envelope = Object.assign(clone(DEFAULT_ENVELOPE), l.envelope || {});
    out.params = Object.assign(clone(DEFAULT_PARAMS[out.type]), l.params || {});
    if (!Array.isArray(out.palette) || out.palette.length === 0) out.palette = DEFAULT_PALETTES[out.type].slice();
    if (!out.id) out.id = newId('layer');
    return out;
  }

  function makePattern(name, layers, loopBeats) {
    return { id: newId('pat'), name: name || 'Neues Pattern', loopBeats: loopBeats || 4, layers: layers || [] };
  }

  function normalizePattern(p) {
    return {
      id: p.id || newId('pat'),
      name: p.name || 'Pattern',
      loopBeats: Math.max(1, Math.round(p.loopBeats || 4)),
      layers: (p.layers || []).map(normalizeLayer),
    };
  }

  function makeProject() {
    return { format: 'ledwall-project', version: 1, name: 'Mein LED-Projekt', width: 64, height: 48, refBpm: 120, patterns: [] };
  }

  function normalizeProject(p) {
    if (!p || p.format !== 'ledwall-project') throw new Error('Keine LEDWall-Projektdatei');
    const out = makeProject();
    out.name = p.name || out.name;
    out.width = Math.max(1, p.width | 0) || 64;
    out.height = Math.max(1, p.height | 0) || 48;
    out.refBpm = +p.refBpm || 120;
    out.patterns = (p.patterns || []).map(normalizePattern);
    if (p.setup) out.setup = p.setup; // Raum-Setup, wird von setup.js geprüft
    return out;
  }

  // ---------------------------------------------------------------- palette

  function compilePalette(hexes) {
    const n = Math.max(1, hexes.length);
    const pal = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const c = hexToRgb(hexes[i] || '#000000');
      pal[i * 3] = c[0]; pal[i * 3 + 1] = c[1]; pal[i * 3 + 2] = c[2];
    }
    return pal;
  }

  // zyklisches Abtasten: t=0 -> Farbe 0, t->1 -> zurück zu Farbe 0
  function samplePalette(pal, n, t, smooth, out) {
    t -= Math.floor(t);
    const pos = t * n;
    let i = Math.floor(pos);
    const f = smooth ? pos - i : 0;
    i %= n;
    const j = (i + 1) % n;
    out[0] = pal[i * 3] + (pal[j * 3] - pal[i * 3]) * f;
    out[1] = pal[i * 3 + 1] + (pal[j * 3 + 1] - pal[i * 3 + 1]) * f;
    out[2] = pal[i * 3 + 2] + (pal[j * 3 + 2] - pal[i * 3 + 2]) * f;
  }

  function paletteAt(pal, n, idx, out) {
    const i = mod(idx, n);
    out[0] = pal[i * 3]; out[1] = pal[i * 3 + 1]; out[2] = pal[i * 3 + 2];
  }

  // Farbton-Rotationsmatrix (wie CSS hue-rotate)
  function hueMatrix(turns) {
    const a = turns * TAU, c = Math.cos(a), s = Math.sin(a);
    return [
      0.213 + 0.787 * c - 0.213 * s, 0.715 - 0.715 * c - 0.715 * s, 0.072 - 0.072 * c + 0.928 * s,
      0.213 - 0.213 * c + 0.143 * s, 0.715 + 0.285 * c + 0.140 * s, 0.072 - 0.072 * c - 0.283 * s,
      0.213 - 0.213 * c - 0.787 * s, 0.715 - 0.715 * c + 0.715 * s, 0.072 + 0.928 * c + 0.072 * s,
    ];
  }

  // ---------------------------------------------------------------- envelope

  function envelopeValue(env, beat, loopBeats) {
    if (!env || env.mode === 'none') return 1;
    const x = beat * env.rate + env.phase;
    const f = frac(x);
    let e;
    switch (env.mode) {
      case 'pulse': e = Math.pow(1 - f, 1 + env.decay * 7); break;
      case 'strobe': e = f < env.duty ? 1 : 0; break;
      case 'sine': e = 0.5 + 0.5 * Math.cos(f * TAU); break;
      case 'sawUp': e = f; break;
      case 'sawDown': e = 1 - f; break;
      case 'random': {
        const steps = Math.round(loopBeats * env.rate);
        const k = steps > 0 ? mod(Math.floor(x), steps) : Math.floor(x);
        e = hash3(k, 17, 31) < env.duty ? 1 : 0;
        break;
      }
      default: e = 1;
    }
    return env.min + (1 - env.min) * e;
  }

  // ---------------------------------------------------------------- noise

  function smooth(t) { return t * t * (3 - 2 * t); }

  // 3D Value-Noise, in z periodisch mit Periode `pz` (für nahtlose Loops)
  function valueNoise3(x, y, z, pz, seed) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
    const z0 = mod(zi, pz), z1 = mod(zi + 1, pz);
    const h = (a, b, c) => hash3(a + seed * 101, b, c);
    const c000 = h(xi, yi, z0), c100 = h(xi + 1, yi, z0), c010 = h(xi, yi + 1, z0), c110 = h(xi + 1, yi + 1, z0);
    const c001 = h(xi, yi, z1), c101 = h(xi + 1, yi, z1), c011 = h(xi, yi + 1, z1), c111 = h(xi + 1, yi + 1, z1);
    const x00 = c000 + (c100 - c000) * xf, x10 = c010 + (c110 - c010) * xf;
    const x01 = c001 + (c101 - c001) * xf, x11 = c011 + (c111 - c011) * xf;
    const y0 = x00 + (x10 - x00) * yf, y1 = x01 + (x11 - x01) * yf;
    return y0 + (y1 - y0) * zf;
  }

  // ---------------------------------------------------------------- shapes

  // Koordinate für Verlauf/Streifen je nach Form
  function shapeCoord(shape, px, py, size, arms) {
    switch (shape) {
      case 'radial': return Math.sqrt(px * px + py * py) / size;
      case 'diamond': return (Math.abs(px) + Math.abs(py)) / size;
      case 'square': return Math.max(Math.abs(px), Math.abs(py)) / size;
      case 'angular': return (Math.atan2(py, px) / TAU) * arms;
      case 'spiral': return (Math.atan2(py, px) / TAU) * arms + Math.sqrt(px * px + py * py) / size;
      default: return px / size;
    }
  }

  function sdf(shape, x, y, s) {
    const ax = Math.abs(x), ay = Math.abs(y);
    switch (shape) {
      case 'square': return Math.max(ax, ay) - s;
      case 'diamond': return (ax + ay - s) * 0.7071;
      case 'triangle': {
        // gleichseitiges Dreieck, Spitze oben
        const k = Math.sqrt(3);
        let qx = ax - s, qy = -y + s / k;
        if (qx + k * qy > 0) { const nx = (qx - k * qy) / 2, ny = (-k * qx - qy) / 2; qx = nx; qy = ny; }
        qx -= Math.min(Math.max(qx, -2 * s), 0);
        return -Math.sqrt(qx * qx + qy * qy) * Math.sign(qy);
      }
      case 'cross': {
        const w = s * 0.35;
        const d1 = Math.max(ax - s, ay - w);
        const d2 = Math.max(ax - w, ay - s);
        return Math.min(d1, d2);
      }
      case 'heart': {
        // aus zwei Kreisen und einem Dreieck zusammengesetzt
        const r = s * 0.55;
        const c1 = Math.sqrt((x + r * 0.8) ** 2 + (y + r * 0.35) ** 2) - r;
        const c2 = Math.sqrt((x - r * 0.8) ** 2 + (y + r * 0.35) ** 2) - r;
        const tri = Math.max((ax * 0.9 + y * 0.75) - s * 0.62, -y - s * 0.3);
        return Math.min(Math.min(c1, c2), tri);
      }
      default: return Math.sqrt(x * x + y * y) - s;
    }
  }

  // ---------------------------------------------------------------- generators
  // Jeder Generator bekommt Ebenen-Koordinaten (px, py) und schreibt eine Farbe
  // nach c[0..2]. Rückgabewert ist die Deckkraft 0..1.

  function makeGenerator(layer, beat, W, H, loopBeats) {
    const p = layer.params;
    const pal = compilePalette(layer.palette);
    const n = layer.palette.length || 1;
    const smoothPal = layer.paletteBlend !== 'steps';

    switch (layer.type) {
      case 'solid': {
        const tmp = new Float32Array(3);
        if (p.mode === 'cycle') paletteAt(pal, n, Math.floor(beat * p.rate), tmp);
        else if (p.mode === 'fade') samplePalette(pal, n, (beat * p.rate) / n, true, tmp);
        else paletteAt(pal, n, 0, tmp);
        return (px, py, c) => { c[0] = tmp[0]; c[1] = tmp[1]; c[2] = tmp[2]; return 1; };
      }

      case 'gradient': {
        const off = beat * p.speed, size = Math.max(0.5, p.size), arms = Math.max(1, Math.round(p.arms));
        return (px, py, c) => {
          samplePalette(pal, n, shapeCoord(p.shape, px, py, size, arms) - off, smoothPal, c);
          return 1;
        };
      }

      case 'stripes': {
        const off = beat * p.speed, size = Math.max(0.5, p.size), arms = Math.max(1, Math.round(p.arms));
        const duty = clamp01(p.duty), soft = Math.max(1e-4, p.softness * 0.5);
        return (px, py, c) => {
          const v = shapeCoord(p.shape, px, py, size, arms) - off;
          const idx = Math.floor(v), f = v - idx;
          const a = clamp01(Math.min(f, duty - f) / soft);
          if (a <= 0) return 0;
          paletteAt(pal, n, idx, c);
          return a;
        };
      }

      case 'plasma': {
        const tt = beat * p.speed * TAU, s = Math.max(0.5, p.scale), co = beat * p.colorSpeed;
        return (px, py, c) => {
          const v = Math.sin(px / s + tt) + Math.sin(py / s - tt) +
            Math.sin((px + py) / (s * 1.6) + tt) + Math.sin(Math.sqrt(px * px + py * py) / s - 2 * tt);
          samplePalette(pal, n, v * 0.125 + 0.5 + co, smoothPal, c);
          return 1;
        };
      }

      case 'noise': {
        const PZ = 8, z = beat * p.speed * PZ, s = Math.max(0.5, p.scale);
        const oct = Math.max(1, Math.min(3, Math.round(p.octaves)));
        const contrast = p.contrast;
        return (px, py, c) => {
          let v = 0, amp = 1, norm = 0, f = 1;
          for (let o = 0; o < oct; o++) {
            v += valueNoise3((px / s) * f, (py / s) * f, z, PZ, o) * amp;
            norm += amp; amp *= 0.5; f *= 2;
          }
          v = clamp01((v / norm - 0.5) * contrast + 0.5);
          // Rauschen läuft linear durch die Palette (nicht zyklisch)
          samplePalette(pal, n, v * (n - 1) / n, smoothPal, c);
          return 1;
        };
      }

      case 'checker': {
        const size = Math.max(1, p.size), step = Math.floor(beat * p.flipRate);
        return (px, py, c) => {
          paletteAt(pal, n, Math.floor(px / size) + Math.floor(py / size) + step, c);
          return 1;
        };
      }

      case 'sparkle': {
        const rate = Math.max(0.01, p.rate), life = Math.max(0.01, p.life), cell = Math.max(1, p.cell);
        const loopSteps = Math.round(loopBeats * rate);
        const cur = Math.floor(beat * rate);
        const back = Math.min(16, Math.ceil(life * rate));
        return (px, py, c) => {
          const cx = Math.floor(px / cell), cy = Math.floor(py / cell);
          let best = 0, bestK = 0;
          for (let k = cur - back; k <= cur; k++) {
            const kk = loopSteps > 0 ? mod(k, loopSteps) : k;
            if (hash3(cx, cy, kk) >= p.density) continue;
            const age = beat - k / rate;
            if (age < 0 || age >= life) continue;
            const b = 1 - age / life;
            if (b > best) { best = b; bestK = kk; }
          }
          if (best <= 0) return 0;
          paletteAt(pal, n, Math.floor(hash3(cx, cy, bestK + 7919) * n), c);
          return best * best;
        };
      }

      case 'rain': {
        const cell = Math.max(1, p.cell), trail = Math.max(1, p.trail);
        const period = H + trail;
        return (px, py, c) => {
          const col = Math.floor(px / cell);
          if (hash3(col, 3, 5) > p.density) return 0;
          const cyc = Math.max(1, Math.round(p.speed * loopBeats * (H / period) * (0.6 + 0.8 * hash3(col, 1, 9))));
          const head = frac(beat * cyc / loopBeats + hash3(col, 2, 4)) * period;
          const d = head - (py + H / 2);
          if (d < 0 || d >= trail) return 0;
          const t = d / trail;
          samplePalette(pal, n, t * (n - 1) / n, smoothPal, c);
          return Math.pow(1 - t, 1.5);
        };
      }

      case 'wave': {
        const count = Math.max(1, Math.round(p.count)), wl = Math.max(1, p.wavelength);
        const off = beat * p.speed;
        return (px, py, c) => {
          let best = 0, bestI = 0;
          for (let i = 0; i < count; i++) {
            const shift = (i - (count - 1) / 2) * p.spacing;
            const y0 = p.amplitude * Math.sin((px / wl - off + i / count) * TAU) + shift;
            const d = py - y0;
            const a = p.fill ? clamp01(0.5 + d) : clamp01(p.thickness / 2 + 0.5 - Math.abs(d));
            if (a > best) { best = a; bestI = i; }
          }
          if (best <= 0) return 0;
          paletteAt(pal, n, bestI, c);
          return best;
        };
      }

      case 'shape': {
        const ox = p.moveX * Math.sin(TAU * beat * p.moveRate);
        const oy = p.moveY * Math.cos(TAU * beat * p.moveRate);
        const s = Math.max(0.5, p.size * (1 + p.pulse * Math.pow(1 - frac(beat), 3)));
        const tile = p.tile > 0 ? p.tile : 0;
        const col = new Float32Array(3);
        samplePalette(pal, n, beat * p.colorSpeed, smoothPal, col);
        return (px, py, c) => {
          let x = px - ox, y = py - oy;
          if (tile) { x = mod(x + tile / 2, tile) - tile / 2; y = mod(y + tile / 2, tile) - tile / 2; }
          const d = sdf(p.shape, x, y, s);
          const a = p.thickness > 0 ? clamp01(p.thickness / 2 + 0.5 - Math.abs(d)) : clamp01(0.5 - d);
          if (a <= 0) return 0;
          c[0] = col[0]; c[1] = col[1]; c[2] = col[2];
          return a;
        };
      }

      case 'scanner': {
        const ph = frac(beat * p.speed);
        const w = Math.max(0.5, p.width), trail = Math.max(0, p.trail);
        let pos, dir;
        if (p.mode === 'wrap') { pos = -W / 2 - w - trail + ph * (W + 2 * w + 2 * trail); dir = 1; }
        else { const t = ph < 0.5 ? ph * 2 : 2 - ph * 2; pos = -W / 2 + w / 2 + t * (W - w); dir = ph < 0.5 ? 1 : -1; }
        const col = new Float32Array(3);
        samplePalette(pal, n, ph, smoothPal, col);
        return (px, py, c) => {
          const d = px - pos;
          let a = clamp01(w / 2 + 0.5 - Math.abs(d));
          if (trail > 0) {
            const behind = -d * dir - w / 2;
            if (behind > 0 && behind < trail) a = Math.max(a, Math.pow(1 - behind / trail, 2));
          }
          if (a <= 0) return 0;
          c[0] = col[0]; c[1] = col[1]; c[2] = col[2];
          return a;
        };
      }

      case 'draw': {
        const bmp = decodeBitmap(p.pixels, W, H);
        const ox = layer.transform.cx * W, oy = layer.transform.cy * H;
        return (px, py, c) => {
          let bx = Math.floor(px + ox), by = Math.floor(py + oy);
          if (p.wrap) { bx = mod(bx, W); by = mod(by, H); }
          else if (bx < 0 || by < 0 || bx >= W || by >= H) return 0;
          const i = (by * W + bx) * 4;
          const a = bmp[i + 3];
          if (!a) return 0;
          c[0] = bmp[i] / 255; c[1] = bmp[i + 1] / 255; c[2] = bmp[i + 2] / 255;
          return a / 255;
        };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- transform

  function makeTransform(t, beat, W, H) {
    const ang = (t.angle / 360 + t.rotate * beat) * TAU;
    const cs = Math.cos(ang), sn = Math.sin(ang);
    const zoom = t.zoom || 1;
    const sx = t.scrollX * beat, sy = t.scrollY * beat;
    const cx = t.cx * W, cy = t.cy * H;
    const kal = t.kaleido >= 2 ? Math.round(t.kaleido) : 0;
    const seg = kal ? TAU / kal : 0;
    const out = [0, 0];
    return function (x, y) {
      let px = x + 0.5 - cx, py = y + 0.5 - cy;
      let rx = px * cs + py * sn, ry = -px * sn + py * cs;
      if (kal) {
        const r = Math.sqrt(rx * rx + ry * ry);
        let a = mod(Math.atan2(ry, rx), seg);
        if (a > seg / 2) a = seg - a;
        rx = r * Math.cos(a); ry = r * Math.sin(a);
      }
      if (t.mirrorX) rx = Math.abs(rx);
      if (t.mirrorY) ry = Math.abs(ry);
      out[0] = rx / zoom - sx;
      out[1] = ry / zoom - sy;
      return out;
    };
  }

  // Bildschirm-Pixel -> Bitmap-Pixel einer Zeichen-Ebene (zum Malen "wo man es sieht")
  function layerPixel(layer, x, y, beat, W, H) {
    const tf = makeTransform(layer.transform, beat, W, H);
    const q = tf(x, y);
    let bx = Math.floor(q[0] + layer.transform.cx * W), by = Math.floor(q[1] + layer.transform.cy * H);
    if (layer.params.wrap) { bx = mod(bx, W); by = mod(by, H); }
    else if (bx < 0 || by < 0 || bx >= W || by >= H) return null;
    return [bx, by];
  }

  // ---------------------------------------------------------------- render

  const BLEND_MODES = {
    normal: 'Normal', add: 'Addieren', screen: 'Negativ multipl.', multiply: 'Multiplizieren',
    max: 'Aufhellen', min: 'Abdunkeln', subtract: 'Subtrahieren',
  };

  function blendChannel(mode, d, s) {
    switch (mode) {
      case 'add': return Math.min(1, d + s);
      case 'screen': return 1 - (1 - d) * (1 - s);
      case 'multiply': return d * s;
      case 'max': return Math.max(d, s);
      case 'min': return Math.min(d, s);
      case 'subtract': return Math.max(0, d - s);
      default: return s;
    }
  }

  /**
   * Rendert ein Pattern bei Beat-Position `beat` in `out` (Float32Array W*H*3, 0..1).
   */
  function renderPattern(pattern, beat, W, H, out) {
    out = out || new Float32Array(W * H * 3);
    out.fill(0);
    const loopBeats = pattern.loopBeats || 4;
    const c = new Float32Array(3);
    for (const layer of pattern.layers) {
      if (!layer.enabled || layer.opacity <= 0) continue;
      const env = envelopeValue(layer.envelope, beat, loopBeats);
      const master = layer.opacity * env;
      if (master <= 0) continue;
      const gen = makeGenerator(layer, beat, W, H, loopBeats);
      if (!gen) continue;
      const tf = makeTransform(layer.transform, beat, W, H);
      const hueTurns = layer.hueOffset / 360 + layer.hueShift * beat;
      const hm = frac(hueTurns) !== 0 ? hueMatrix(hueTurns) : null;
      const mode = layer.blend;
      for (let y = 0, i = 0; y < H; y++) {
        for (let x = 0; x < W; x++, i += 3) {
          const q = tf(x, y);
          let a = gen(q[0], q[1], c);
          if (a <= 0) continue;
          let r = c[0], g = c[1], b = c[2];
          if (hm) {
            const r2 = hm[0] * r + hm[1] * g + hm[2] * b;
            const g2 = hm[3] * r + hm[4] * g + hm[5] * b;
            const b2 = hm[6] * r + hm[7] * g + hm[8] * b;
            r = clamp01(r2); g = clamp01(g2); b = clamp01(b2);
          }
          if (layer.lumaKey) a *= Math.max(r, g, b);
          a *= master;
          if (a <= 0) continue;
          if (a > 1) a = 1;
          const dr = out[i], dg = out[i + 1], db = out[i + 2];
          out[i] = dr + (blendChannel(mode, dr, r) - dr) * a;
          out[i + 1] = dg + (blendChannel(mode, dg, g) - dg) * a;
          out[i + 2] = db + (blendChannel(mode, db, b) - db) * a;
        }
      }
    }
    return out;
  }

  function toRGBA(buf, rgba) {
    for (let i = 0, j = 0; i < buf.length; i += 3, j += 4) {
      rgba[j] = buf[i] * 255 + 0.5;
      rgba[j + 1] = buf[i + 1] * 255 + 0.5;
      rgba[j + 2] = buf[i + 2] * 255 + 0.5;
      rgba[j + 3] = 255;
    }
    return rgba;
  }

  // Prüft, ob Loop-Ende nahtlos in den Anfang übergeht (Frame bei 0 vs. bei loopBeats)
  function checkLoop(pattern, W, H) {
    const a = renderPattern(pattern, 0, W, H);
    const b = renderPattern(pattern, pattern.loopBeats, W, H);
    let maxDiff = 0, sum = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i] - b[i]);
      sum += d;
      if (d > maxDiff) maxDiff = d;
    }
    const mean = sum / a.length;
    return { seamless: maxDiff < 0.02 || mean < 0.002, maxDiff, mean };
  }

  // ---------------------------------------------------------------- bank export
  /*
   * .lwb  = "LEDWall Bank", alle Patterns vorgerendert, indiziert nach Beat-Phase.
   * Alle Werte Little Endian.
   *
   * Header (32 Byte)
   *   0  char[4] "LWB1"
   *   4  u16     width
   *   6  u16     height
   *   8  u16     refBpm * 10
   *  10  u8      framesPerBeat
   *  11  u8      pixelFormat (0 = RGB888, 1 = RGB565)
   *  12  u16     patternCount
   *  14  u16     reserved
   *  16  u32     Offset der Pattern-Tabelle (=32)
   *  20  12 Byte reserved
   * Pattern-Tabelle (je 32 Byte)
   *   0  char[20] Name (UTF-8, mit 0 aufgefüllt)
   *  20  u16      loopBeats
   *  22  u16      flags (bit0 = Loop nahtlos)
   *  24  u32      frameCount (= loopBeats * framesPerBeat)
   *  28  u32      Offset der Frame-Daten ab Dateianfang
   * Frame-Daten: zeilenweise von oben links, W*H Pixel.
   *
   * Abspielen: beat = Sekunden * BPM / 60
   *            frame = floor(beat * framesPerBeat) % frameCount
   */
  // opts: refBpm, fps, format, optional width/height (Leinwand), walls[], mode (siehe setup.js bankGeometry)
  function bankLayout(project, opts) {
    const fpb = Math.max(1, Math.min(255, Math.round((opts.fps * 60) / opts.refBpm)));
    const bpp = opts.format === 'rgb565' ? 2 : 3;
    const W = opts.width || project.width, H = opts.height || project.height;
    const frameBytes = W * H * bpp;
    const walls = opts.walls || [];
    const setupOffset = walls.length ? 32 + 32 * project.patterns.length : 0;
    let total = 32 + 32 * project.patterns.length + (walls.length ? 8 + 32 * walls.length : 0);
    const entries = project.patterns.map((p) => {
      const frames = p.loopBeats * fpb;
      const e = { frames, offset: total, bytes: frames * frameBytes };
      total += e.bytes;
      return e;
    });
    return { fpb, bpp, frameBytes, entries, total, W, H, setupOffset };
  }

  function buildBank(project, opts, onProgress) {
    const L = bankLayout(project, opts);
    const W = L.W, H = L.H;
    const buf = new Uint8Array(L.total);
    const dv = new DataView(buf.buffer);
    buf.set([0x4c, 0x57, 0x42, 0x31], 0); // "LWB1"
    dv.setUint16(4, W, true);
    dv.setUint16(6, H, true);
    dv.setUint16(8, Math.round(opts.refBpm * 10), true);
    dv.setUint8(10, L.fpb);
    dv.setUint8(11, L.bpp === 2 ? 1 : 0);
    dv.setUint16(12, project.patterns.length, true);
    dv.setUint32(16, 32, true);
    dv.setUint32(20, L.setupOffset, true);
    dv.setUint32(24, L.total, true);
    const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    if (L.setupOffset) {
      // Raum-Setup: welche Wand (Adresse, Ausgang) welchen Ausschnitt der Leinwand zeigt
      const o = L.setupOffset, walls = opts.walls;
      buf.set([0x4c, 0x57, 0x53, 0x31], o); // "LWS1"
      dv.setUint16(o + 4, walls.length, true);
      dv.setUint8(o + 6, opts.mode === 'span' ? 1 : 0);
      walls.forEach((w, i) => {
        const e = o + 8 + i * 32;
        const fx = (v) => Math.max(0, Math.min(65535, Math.round(v * 16)));
        dv.setUint8(e, w.address);
        dv.setUint8(e + 1, w.channel || 0);
        dv.setUint16(e + 2, w.width, true);
        dv.setUint16(e + 4, w.height, true);
        dv.setUint16(e + 6, fx(w.region.x), true);
        dv.setUint16(e + 8, fx(w.region.y), true);
        dv.setUint16(e + 10, fx(w.region.w), true);
        dv.setUint16(e + 12, fx(w.region.h), true);
        if (enc) buf.set(enc.encode(w.name || '').subarray(0, 17), e + 14);
      });
    }
    const frame = new Float32Array(W * H * 3);
    let done = 0;
    const totalFrames = L.entries.reduce((s, e) => s + e.frames, 0);
    project.patterns.forEach((p, pi) => {
      const e = L.entries[pi];
      const base = 32 + pi * 32;
      const name = enc ? enc.encode(p.name).subarray(0, 19) : [];
      buf.set(name, base);
      dv.setUint16(base + 20, p.loopBeats, true);
      dv.setUint16(base + 22, checkLoop(p, W, H).seamless ? 1 : 0, true);
      dv.setUint32(base + 24, e.frames, true);
      dv.setUint32(base + 28, e.offset, true);
      let o = e.offset;
      for (let f = 0; f < e.frames; f++) {
        renderPattern(p, f / L.fpb, W, H, frame);
        for (let i = 0; i < frame.length; i += 3) {
          const r = Math.round(frame[i] * 255), g = Math.round(frame[i + 1] * 255), b = Math.round(frame[i + 2] * 255);
          if (L.bpp === 3) { buf[o++] = r; buf[o++] = g; buf[o++] = b; }
          else { dv.setUint16(o, ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3), true); o += 2; }
        }
        done++;
        if (onProgress) onProgress(done / totalFrames);
      }
    });
    return buf;
  }

  return {
    LAYER_TYPES, DEFAULT_PARAMS, DEFAULT_PALETTES, BLEND_MODES,
    makeLayer, normalizeLayer, makePattern, normalizePattern, makeProject, normalizeProject,
    renderPattern, toRGBA, checkLoop, envelopeValue, layerPixel,
    bankLayout, buildBank, decodeBitmap, encodeBitmap, bytesToBase64,
    hexToRgb, rgbToHex, hash3, clone, newId,
  };
});
