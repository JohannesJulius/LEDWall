const test = require('node:test');
const assert = require('node:assert');
const R = require('../js/renderer.js');
const S = require('../js/setup.js');
const P = require('../js/protocol.js');

test('Setup normalisieren füllt Lücken und begrenzt Werte', () => {
  const s = S.normalizeSetup({ mode: 'span', walls: [{ address: 999, pos: { x: 1 } }] });
  assert.strictEqual(s.mode, 'span');
  assert.strictEqual(s.walls[0].address, 254);
  assert.deepStrictEqual(s.walls[0].pos, { x: 1, y: 1.2, z: 0 });
  assert.strictEqual(S.normalizeSetup(null).walls.length, 1);
});

test('Verteilt: zwei Wände nebeneinander ergeben eine 128x48-Leinwand', () => {
  const s = S.defaultSetup();
  const w = (S.wallSize(s.walls[0]).w);
  s.mode = 'span';
  s.walls = [S.makeWall(1, { pos: { x: -w / 2, y: 1, z: 0 } }), S.makeWall(2, { pos: { x: w / 2, y: 1, z: 0 } })];
  const L = S.spanLayout(s);
  assert.strictEqual(L.W, 128);
  assert.strictEqual(L.H, 48);
  assert.ok(Math.abs(L.regions[s.walls[1].id].x - 64) < 1e-6);
  // Verlauf läuft über beide Wände: rechte Wand setzt die linke fort
  const pat = R.makePattern('g', [R.makeLayer('gradient', { params: { size: 1000, speed: 0 }, paletteBlend: 'smooth', palette: ['#000000', '#ffffff'] })], 4);
  const frames = S.renderWalls(pat, 0, s);
  const big = R.renderPattern(pat, 0, 128, 48);
  const right = frames[s.walls[1].id];
  assert.strictEqual(right[(10 * 64 + 0) * 3], big[(10 * 128 + 64) * 3]);
});

test('Gleiches Bild: jede Wand bekommt das ganze Pattern', () => {
  const s = S.defaultSetup();
  s.walls.push(S.makeWall(2));
  const pat = R.makePattern('p', [R.makeLayer('plasma')], 4);
  const f = S.renderWalls(pat, 1, s);
  assert.deepStrictEqual(Array.from(f[s.walls[0].id]), Array.from(R.renderPattern(pat, 1, 64, 48)));
});

test('Protokoll: CRC-Prüfwert und Paketaufbau', () => {
  assert.strictEqual(P.crc16(Buffer.from('123456789')), 0x29b1);
  assert.strictEqual(P.crc32(Buffer.from('123456789')), 0xcbf43926);
  const pk = P.packet(5, P.TYPE.IDENT, Uint8Array.from([3]));
  assert.deepStrictEqual(Array.from(pk.subarray(0, 7)), [0xa5, 0x5a, 5, 7, 1, 0, 3]);
  const f = P.frame(1, new Float32Array(64 * 48 * 3), 'rgb565', P.FLAG_SHOW);
  assert.strictEqual(f.length, 8 + 1 + 64 * 48 * 2);
});

test('Bank mit Raum-Setup: Kopf enthält Setup-Offset und Gesamtgröße', () => {
  const proj = R.makeProject();
  proj.patterns = [R.makePattern('a', [R.makeLayer('plasma')], 1)];
  proj.setup = S.normalizeSetup({ mode: 'copy', walls: [S.makeWall(3, { channel: 1 }), S.makeWall(4)] });
  const g = S.bankGeometry(proj);
  const buf = R.buildBank(proj, Object.assign({ refBpm: 120, fps: 10, format: 'rgb565' }, g));
  const dv = new DataView(buf.buffer);
  const setup = dv.getUint32(20, true);
  assert.strictEqual(dv.getUint32(24, true), buf.length);
  assert.strictEqual(String.fromCharCode(...buf.subarray(setup, setup + 4)), 'LWS1');
  assert.strictEqual(dv.getUint16(setup + 4, true), 2);
  assert.strictEqual(buf[setup + 8], 3);      // Adresse Wand 1
  assert.strictEqual(buf[setup + 9], 1);      // Ausgang 2
  assert.strictEqual(dv.getUint16(setup + 8 + 10, true), 64 * 16);
});
