// LEDWall-Protokoll: Pakete vom Sender (Pico 2W, UART) bzw. von der App (USB).
//
//   0xA5 0x5A | addr u8 | type u8 | len u16 LE | payload[len] | crc16 LE
//
// crc16 = CRC-16/CCITT-FALSE (Poly 0x1021, Start 0xFFFF) über addr..payload.
// addr 0xFF = an alle. Genaue Beschreibung: docs/protocol.md
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define LW_SYNC0 0xA5
#define LW_SYNC1 0x5A
#define LW_ADDR_ALL 0xFF

enum {
    LW_FRAME_RGB888 = 0x01, // flags u8, dann W*H*3 Byte
    LW_FRAME_RGB565 = 0x02, // flags u8, dann W*H*2 Byte (u16 LE)
    LW_SHOW = 0x03,         // gepuffertes Bild anzeigen (alle Wände gleichzeitig)
    LW_FILL = 0x04,         // flags u8, r, g, b
    LW_BRIGHTNESS = 0x05,   // u8 0..255 (nicht gespeichert)
    LW_TEST = 0x06,         // u8 Testbild-Nummer (0 = aus)
    LW_IDENT = 0x07,        // u8 Sekunden: Adresse groß anzeigen
    LW_BLACKOUT = 0x08,     // alles aus
};

#define LW_FLAG_SHOW 0x01 // Bild sofort anzeigen statt auf SHOW zu warten

uint16_t lw_crc16(uint16_t crc, const uint8_t *data, size_t len);

typedef void (*lw_packet_cb)(void *ctx, uint8_t addr, uint8_t type, const uint8_t *payload, uint16_t len);

typedef struct {
    uint8_t state;
    uint8_t addr, type;
    uint16_t len, got, crc, rx_crc;
    uint8_t *buf;
    uint16_t cap;
    uint32_t packets, crc_errors, overflows;
    lw_packet_cb cb;
    void *ctx;
} lw_parser_t;

void lw_parser_init(lw_parser_t *p, uint8_t *buf, uint16_t cap, lw_packet_cb cb, void *ctx);
// Gibt true zurück, solange der Parser mitten in einem Paket steckt.
bool lw_parser_feed(lw_parser_t *p, uint8_t byte);
bool lw_parser_idle(const lw_parser_t *p);
