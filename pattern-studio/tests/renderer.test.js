// Ausführen mit: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const R = require('../js/renderer.js');
const P = require('../js/presets.js');

const W = 64, H = 48;

test('jeder Ebenentyp rendert ohne NaN und bleibt in 0..1', () => {
  for (const type of Object.keys(R.LAYER_TYPES)) {
    const p = R.makePattern(type, [R.makeLayer(type)], 4);
    for (const beat of [0, 0.37, 1.5, 3.99]) {
      const buf = R.renderPattern(p, beat, W, H);
      for (const v of buf) assert.ok(v >= 0 && v <= 1, `${type} @${beat}: ${v}`);
    }
  }
});

test('alle Vorlagen loopen nahtlos', () => {
  for (const pr of P.PRESETS) {
    assert.ok(R.checkLoop(P.instantiate(pr), W, H).seamless, pr.name);
  }
});

test('Loop-Prüfung erkennt einen Sprung', () => {
  const p = R.makePattern('x', [R.makeLayer('gradient', { params: { speed: 0.125 } })], 4);
  assert.strictEqual(R.checkLoop(p, W, H).seamless, false);
});

test('Projekt übersteht Speichern und Laden', () => {
  const proj = R.makeProject();
  proj.patterns = P.PRESETS.map(P.instantiate);
  const again = R.normalizeProject(JSON.parse(JSON.stringify(proj)));
  assert.deepStrictEqual(again, proj);
});

test('Zeichen-Ebene: Bitmap kodieren und rendern', () => {
  const bmp = new Uint8Array(W * H * 4);
  const i = (10 * W + 5) * 4;
  bmp.set([255, 0, 0, 255], i);
  const l = R.makeLayer('draw', { params: { pixels: R.encodeBitmap(bmp) } });
  const out = R.renderPattern(R.makePattern('d', [l], 4), 0, W, H);
  assert.strictEqual(out[(10 * W + 5) * 3], 1);
  assert.strictEqual(out[(10 * W + 6) * 3], 0);
  assert.deepStrictEqual(R.layerPixel(l, 5, 10, 0, W, H), [5, 10]);
});

test('Bank-Export: Header, Tabelle und Frames', () => {
  const proj = R.makeProject();
  proj.patterns = [P.instantiate(P.PRESETS[0]), P.instantiate(P.PRESETS[11])];
  for (const format of ['rgb888', 'rgb565']) {
    const opts = { refBpm: 120, fps: 30, format };
    const buf = R.buildBank(proj, opts);
    const dv = new DataView(buf.buffer);
    const bpp = format === 'rgb565' ? 2 : 3;
    assert.strictEqual(String.fromCharCode(...buf.subarray(0, 4)), 'LWB1');
    assert.strictEqual(dv.getUint16(4, true), W);
    assert.strictEqual(dv.getUint16(6, true), H);
    assert.strictEqual(dv.getUint16(8, true), 1200);
    assert.strictEqual(dv.getUint8(10), 15);
    assert.strictEqual(dv.getUint8(11), bpp === 2 ? 1 : 0);
    assert.strictEqual(dv.getUint16(12, true), 2);
    let expected = 32 + 64;
    proj.patterns.forEach((p, i) => {
      const e = 32 + i * 32;
      assert.strictEqual(dv.getUint16(e + 20, true), p.loopBeats);
      assert.strictEqual(dv.getUint32(e + 24, true), p.loopBeats * 15);
      assert.strictEqual(dv.getUint32(e + 28, true), expected);
      expected += p.loopBeats * 15 * W * H * bpp;
    });
    assert.strictEqual(buf.length, expected);
  }
  // Strobe-Vorlage: Frame 0 ist weiß, Frame in der "Aus"-Phase schwarz
  const strobe = R.makeProject();
  strobe.patterns = [P.instantiate(P.PRESETS.find((p) => p.name === 'Strobe'))];
  const b = R.buildBank(strobe, { refBpm: 120, fps: 30, format: 'rgb888' });
  const data = new DataView(b.buffer).getUint32(32 + 28, true);
  assert.strictEqual(b[data], 255);
  assert.strictEqual(b[data + 5 * W * H * 3], 0); // Frame 5 = Beat 1/3 -> aus
});
