// Einstellungen des Empfängers (im Flash gespeichert, von der App über USB gesetzt)
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define CFG_MAX_PANELS 8
#define CFG_MAX_PIXELS (128 * 64)
#define CFG_MAX_CHAIN_W 512
#define DISPLAY_BITPLANES 10                 // Farbtiefe pro Kanal (Bit)
#define DISPLAY_BUF_MAX (16 * DISPLAY_BITPLANES * 256)  // Bytes je Bildpuffer

enum { PANEL_MIRROR_X = 1, PANEL_MIRROR_Y = 2 };

typedef struct {
    uint16_t x, y;  // Lage des Panels im Wandbild (Pixel, oben links)
    uint8_t flags;  // PANEL_MIRROR_X | PANEL_MIRROR_Y (beides = 180° gedreht)
} panel_t;

typedef struct {
    uint32_t magic;
    uint16_t version;
    uint16_t size;
    uint8_t address;       // 1..254
    char name[24];
    uint16_t width, height;      // Wandbild, z. B. 64 x 48
    uint16_t panel_w, panel_h;   // ein HUB75-Panel, z. B. 64 x 16
    uint8_t panel_count;         // Panels in der Kette (Reihenfolge = Datenfluss)
    panel_t panels[CFG_MAX_PANELS];
    uint8_t color_order;   // 0 RGB, 1 RBG, 2 GRB, 3 GBR, 4 BRG, 5 BGR
    uint8_t brightness;    // 0..255
    uint8_t gamma_x10;     // 22 = Gamma 2,2
    uint8_t clk_div;       // PIO-Taktteiler (Panel-Takt = sys / (2 * div))
    uint32_t baud;         // UART vom Sender
    uint32_t crc;
} config_t;

void config_defaults(config_t *c);
bool config_valid(const config_t *c, const char **why);
// "key=value key=value ..." anwenden. Gibt false + Grund zurück, ohne c zu ändern.
bool config_apply(config_t *c, const char *args, const char **why);
// Einstellungen als JSON-Objekt (ohne Zeilenumbruch)
int config_json(const config_t *c, char *out, size_t cap);
uint32_t config_checksum(const config_t *c);
