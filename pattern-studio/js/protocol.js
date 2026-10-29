/*
 * LEDWall-Protokoll (Gegenstück zu firmware/receiver/src/protocol.c).
 *
 *   0xA5 0x5A | addr | type | len u16 LE | payload | crc16 LE
 *
 * Wird von der App für die Live-Vorschau über USB benutzt und später vom Sender (Pico 2W)
 * in gleicher Form über UART verschickt. Beschreibung: docs/protocol.md
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LEDProtocol = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TYPE = {
    FRAME_RGB888: 0x01, FRAME_RGB565: 0x02, SHOW: 0x03, FILL: 0x04,
    BRIGHTNESS: 0x05, TEST: 0x06, IDENT: 0x07, BLACKOUT: 0x08,
  };
  const FLAG_SHOW = 0x01;
  const ADDR_ALL = 0xff;

  const TABLE = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let b = 0; b < 8; b++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
    TABLE[i] = c;
  }

  function crc16(bytes, crc) {
    crc = crc === undefined ? 0xffff : crc;
    for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ TABLE[((crc >> 8) ^ bytes[i]) & 0xff]) & 0xffff;
    return crc;
  }

  function packet(addr, type, payload) {
    payload = payload || new Uint8Array(0);
    const out = new Uint8Array(8 + payload.length);
    out[0] = 0xa5; out[1] = 0x5a; out[2] = addr; out[3] = type;
    out[4] = payload.length & 0xff; out[5] = payload.length >> 8;
    out.set(payload, 6);
    const crc = crc16(out.subarray(2, 6 + payload.length));
    out[6 + payload.length] = crc & 0xff;
    out[7 + payload.length] = crc >> 8;
    return out;
  }

  // Bild aus Float32 (0..1, RGB je Pixel) wie vom Renderer
  function framePayload(floatRGB, fmt, flags) {
    const n = floatRGB.length / 3;
    const bpp = fmt === 'rgb888' ? 3 : 2;
    const p = new Uint8Array(1 + n * bpp);
    p[0] = flags || 0;
    for (let i = 0, o = 1; i < n; i++) {
      const r = Math.round(floatRGB[i * 3] * 255), g = Math.round(floatRGB[i * 3 + 1] * 255), b = Math.round(floatRGB[i * 3 + 2] * 255);
      if (bpp === 3) { p[o++] = r; p[o++] = g; p[o++] = b; }
      else { const v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3); p[o++] = v & 0xff; p[o++] = v >> 8; }
    }
    return p;
  }

  function frame(addr, floatRGB, fmt, flags) {
    return packet(addr, fmt === 'rgb888' ? TYPE.FRAME_RGB888 : TYPE.FRAME_RGB565, framePayload(floatRGB, fmt, flags));
  }

  return { TYPE, FLAG_SHOW, ADDR_ALL, crc16, packet, framePayload, frame };
});
