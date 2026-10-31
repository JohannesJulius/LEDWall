// Direktbetrieb: HUB75-Panels hängen direkt am Pico 2W (vorübergehend ohne RP2040 Zero)
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

void direct_init(void);
uint16_t direct_width(void);
uint16_t direct_height(void);
const uint8_t *direct_buttons(void);          // [tap, next]
void direct_poll(uint64_t now);
bool direct_busy(uint64_t now);               // Testbild, Adressanzeige oder Live-Vorschau aktiv
void direct_show(const uint8_t *pixels, int fmt);
void direct_blackout(void);
void direct_ident(uint8_t secs);
void direct_brightness(uint8_t master);
bool direct_save(void);
void direct_udp_init(void);
// Befehle SET / TEST / PINMAP / DEFAULTS. Gibt false zurück, wenn der Befehl nicht dazugehört.
bool direct_command(const char *cmd, const char *arg, char *reply, size_t cap);
int direct_json(char *out, size_t cap);       // ,"direct":{...}
uint32_t direct_frames(void);
