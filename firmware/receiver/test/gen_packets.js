// Erzeugt Testpakete mit dem JS-Protokoll der App -> stdout (binär)
const P = require('../../../pattern-studio/js/protocol.js');
const W = 64, H = 48;
const img = new Float32Array(W * H * 3);
img[(5 * W + 7) * 3] = 1;                       // Pixel (7,5) rot
const out = [
  Uint8Array.from([1, 2, 3, 0xa5, 0x00]),         // Müll vor dem ersten Paket
  P.frame(3, img, 'rgb888', P.FLAG_SHOW),
  P.frame(9, img, 'rgb565', 0),
  P.packet(P.ADDR_ALL, P.TYPE.SHOW),
  P.packet(3, P.TYPE.IDENT, Uint8Array.from([4])),
];
const bad = P.packet(3, P.TYPE.TEST, Uint8Array.from([2]));
bad[bad.length - 1] ^= 0xff;                     // kaputte Prüfsumme
out.push(bad);
process.stdout.write(Buffer.concat(out.map((a) => Buffer.from(a))));
