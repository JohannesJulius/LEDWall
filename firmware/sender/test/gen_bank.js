// Erzeugt Test-Banken mit der App-Logik: argv[2] = Ausgabeordner
const fs = require('fs');
const path = require('path');
const R = require('../../../pattern-studio/js/renderer.js');
const S = require('../../../pattern-studio/js/setup.js');
const out = process.argv[2];

const grad = R.makePattern('Verlauf', [R.makeLayer('gradient', { params: { size: 1000, speed: 0.25 }, palette: ['#000000', '#ffffff'] })], 4);
const strobe = R.makePattern('Strobe', [R.makeLayer('solid', { palette: ['#ffffff'], envelope: { mode: 'strobe', rate: 2, duty: 0.25 } })], 1);

// 1) zwei Wände nebeneinander, verteilt, zweite Wand an Ausgang 2
const p1 = R.makeProject();
p1.patterns = [grad, strobe];
const w = S.wallSize(S.makeWall(1)).w;
p1.setup = S.normalizeSetup({ mode: 'span', walls: [
  S.makeWall(1, { name: 'Links', pos: { x: -w / 2, y: 1, z: 0 } }),
  S.makeWall(2, { name: 'Rechts', address: 7, channel: 1, pos: { x: w / 2, y: 1, z: 0 } }),
] });
const g1 = S.bankGeometry(p1);
const opts = { refBpm: 120, fps: 30, format: 'rgb888', width: g1.width, height: g1.height, walls: g1.walls, mode: g1.mode };
fs.writeFileSync(path.join(out, 'span.lwb'), R.buildBank(p1, opts));
// erwartetes Bild der rechten Wand bei Frame 7 von Pattern 0 (Beat 7/15)
const frames = S.renderWalls(grad, 7 / 15, p1.setup);
const right = frames[p1.setup.walls[1].id];
fs.writeFileSync(path.join(out, 'span_right_f7.bin'), Buffer.from(Array.from(right, (v) => Math.round(v * 255))));

// 2) ohne Setup (alte Form): Bild an alle
const p2 = R.makeProject();
p2.patterns = [strobe];
fs.writeFileSync(path.join(out, 'plain.lwb'), R.buildBank(p2, { refBpm: 128, fps: 30, format: 'rgb565' }));
