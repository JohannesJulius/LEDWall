/*
 * Raum-Setup: wo stehen die LED-Wände, welche Adresse haben sie und was zeigen sie.
 * Wird im Projekt gespeichert (project.setup). Koordinaten in Metern, y zeigt nach oben,
 * Ursprung = Mitte des Bodens. Drehung in Grad.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./renderer.js') : root.LEDRenderer);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LEDSetup = api;
})(typeof self !== 'undefined' ? self : this, function (R) {
  'use strict';

  const MAX_CANVAS = 1024; // größte Leinwand im Modus "verteilt" (Pixel je Richtung)

  function makeWall(n, overrides) {
    return Object.assign({
      id: R.newId('wall'),
      name: 'Wand ' + n,
      address: n,
      uid: '',             // verknüpfter Empfänger (USB-Seriennummer)
      width: 64,
      height: 48,
      pitch: 4,            // Pixelabstand in mm
      channel: 0,          // Ausgang am Sender (0 = GP0, 1 = GP4)
      pos: { x: 0, y: 1.2, z: 0 },
      rot: { x: 0, y: 0, z: 0 },
    }, overrides || {});
  }

  function defaultSetup() {
    return { room: { w: 6, d: 4, h: 3 }, mode: 'copy', walls: [makeWall(1, { pos: { x: 0, y: 1.2, z: -1.9 } })] };
  }

  function num(v, d) { v = +v; return isFinite(v) ? v : d; }

  function normalizeSetup(s) {
    const d = defaultSetup();
    if (!s || typeof s !== 'object') return d;
    const out = {
      room: { w: num(s.room && s.room.w, 6), d: num(s.room && s.room.d, 4), h: num(s.room && s.room.h, 3) },
      mode: s.mode === 'span' ? 'span' : 'copy',
      walls: Array.isArray(s.walls) ? s.walls.map((w, i) => {
        const base = makeWall(i + 1);
        return Object.assign(base, w, {
          address: Math.max(1, Math.min(254, Math.round(num(w.address, i + 1)))),
          width: Math.max(1, Math.round(num(w.width, 64))),
          height: Math.max(1, Math.round(num(w.height, 48))),
          pitch: Math.max(0.5, num(w.pitch, 4)),
          channel: w.channel === 1 ? 1 : 0,
          pos: { x: num(w.pos && w.pos.x, 0), y: num(w.pos && w.pos.y, 1.2), z: num(w.pos && w.pos.z, 0) },
          rot: { x: num(w.rot && w.rot.x, 0), y: num(w.rot && w.rot.y, 0), z: num(w.rot && w.rot.z, 0) },
          id: w.id || base.id,
        });
      }) : d.walls,
    };
    return out;
  }

  // Größe einer Wand in Metern
  function wallSize(w) { return { w: (w.width * w.pitch) / 1000, h: (w.height * w.pitch) / 1000 }; }

  /*
   * Modus "verteilt": alle Wände bilden zusammen eine große Leinwand, von vorne gesehen
   * (x/y-Position, Drehung wird ignoriert). Rasterweite = kleinster Pixelabstand.
   */
  function spanLayout(setup) {
    const walls = setup.walls;
    if (!walls.length) return null;
    const cp = Math.min(...walls.map((w) => w.pitch)) / 1000;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const w of walls) {
      const s = wallSize(w);
      minX = Math.min(minX, w.pos.x - s.w / 2); maxX = Math.max(maxX, w.pos.x + s.w / 2);
      minY = Math.min(minY, w.pos.y - s.h / 2); maxY = Math.max(maxY, w.pos.y + s.h / 2);
    }
    const W = Math.min(MAX_CANVAS, Math.max(1, Math.round((maxX - minX) / cp)));
    const H = Math.min(MAX_CANVAS, Math.max(1, Math.round((maxY - minY) / cp)));
    const regions = {};
    for (const w of walls) {
      const s = wallSize(w);
      regions[w.id] = { x: (w.pos.x - s.w / 2 - minX) / cp, y: (maxY - (w.pos.y + s.h / 2)) / cp, w: s.w / cp, h: s.h / cp };
    }
    return { W, H, regions };
  }

  /*
   * Rendert das Pattern für jede Wand. Ergebnis: { [wallId]: Float32Array(width*height*3) }
   */
  function renderWalls(pattern, beat, setup, cache) {
    cache = cache || {};
    const out = {};
    if (!pattern) return out;
    if (setup.mode === 'span') {
      const L = spanLayout(setup);
      if (!L) return out;
      const key = 'span' + L.W + 'x' + L.H;
      const big = cache[key] = R.renderPattern(pattern, beat, L.W, L.H, cache[key]);
      for (const w of setup.walls) {
        const r = L.regions[w.id];
        const buf = out[w.id] = cache['w' + w.id] && cache['w' + w.id].length === w.width * w.height * 3
          ? cache['w' + w.id] : (cache['w' + w.id] = new Float32Array(w.width * w.height * 3));
        for (let y = 0; y < w.height; y++) {
          const sy = Math.floor(r.y + ((y + 0.5) * r.h) / w.height);
          for (let x = 0; x < w.width; x++) {
            const sx = Math.floor(r.x + ((x + 0.5) * r.w) / w.width);
            const o = (y * w.width + x) * 3;
            if (sx < 0 || sy < 0 || sx >= L.W || sy >= L.H) { buf[o] = buf[o + 1] = buf[o + 2] = 0; continue; }
            const i = (sy * L.W + sx) * 3;
            buf[o] = big[i]; buf[o + 1] = big[i + 1]; buf[o + 2] = big[i + 2];
          }
        }
      }
    } else {
      for (const w of setup.walls) {
        const key = 'copy' + w.width + 'x' + w.height;
        if (!cache['_done_' + key]) {
          cache[key] = R.renderPattern(pattern, beat, w.width, w.height, cache[key]);
          cache['_done_' + key] = true;
        }
        out[w.id] = cache[key];
      }
      for (const k of Object.keys(cache)) if (k.startsWith('_done_')) delete cache[k];
    }
    return out;
  }

  /*
   * Geometrie für den Bank-Export: Leinwandgröße und pro Wand der Ausschnitt.
   * Ohne Wände: nur die Leinwand (W x H des Projekts), Bilder gehen an alle Wände.
   */
  function bankGeometry(project) {
    const setup = project.setup;
    if (!setup || !setup.walls.length) return { width: project.width, height: project.height, walls: [], mode: 'copy' };
    if (setup.mode === 'span') {
      const L = spanLayout(setup);
      return {
        width: L.W, height: L.H, mode: 'span',
        walls: setup.walls.map((w) => ({ address: w.address, channel: w.channel, width: w.width, height: w.height, name: w.name, region: L.regions[w.id] })),
      };
    }
    const first = setup.walls[0];
    return {
      width: first.width, height: first.height, mode: 'copy',
      walls: setup.walls.map((w) => ({ address: w.address, channel: w.channel, width: w.width, height: w.height, name: w.name,
        region: { x: 0, y: 0, w: first.width, h: first.height } })),
    };
  }

  return { makeWall, defaultSetup, normalizeSetup, wallSize, spanLayout, renderWalls, bankGeometry };
});
