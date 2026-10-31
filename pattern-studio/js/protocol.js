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
    BRIGHTNESS: 0x05, TEST: 0x06, IDENT: 0x07, BLACKOUT: 0x08, FRAME_PART: 0x09,
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

  // Bild in Zeilenblöcke zerlegen, die in ein UDP-Paket passen (Live-Vorschau per WLAN), danach SHOW
  function framePartPackets(floatRGB, w, h, maxBytes) {
    const rows = Math.max(1, Math.floor((maxBytes || 1400) / (w * 2)));
    const out = [];
    for (let y0 = 0; y0 < h; y0 += rows) {
      const n = Math.min(rows, h - y0);
      const p = new Uint8Array(6 + n * w * 2);
      p[0] = 0; p[1] = 1; p[2] = y0 & 0xff; p[3] = y0 >> 8; p[4] = n & 0xff; p[5] = n >> 8;
      for (let i = 0, o = 6; i < n * w; i++) {
        const k = (y0 * w + i) * 3;
        const r = Math.round(floatRGB[k] * 255), g = Math.round(floatRGB[k + 1] * 255), b = Math.round(floatRGB[k + 2] * 255);
        const v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
        p[o++] = v & 0xff; p[o++] = v >> 8;
      }
      out.push(packet(ADDR_ALL, TYPE.FRAME_PART, p));
    }
    out.push(packet(ADDR_ALL, TYPE.SHOW));
    return out;
  }

  // CRC-32 (zlib) für den Bank-Upload zum Sender
  const T32 = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    T32[i] = c >>> 0;
  }
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = T32[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  return { TYPE, FLAG_SHOW, ADDR_ALL, crc16, crc32, packet, framePayload, frame, framePartPackets };
});
