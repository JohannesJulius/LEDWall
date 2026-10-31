// HUB75-Bildwiederholung direkt am Pico 2W (Direktbetrieb), Core 1
#pragma once
#include <stdbool.h>
#include <stdint.h>

enum { PINMAP_STANDARD = 0, PINMAP_SEENGREAT_V38 = 1 };

typedef struct {
    const char *name;
    uint8_t data_base, data_count;   // OUT-Pins für die Farben
    uint8_t clk, lat;                // LAT und OE = LAT + 1
    uint8_t addr[5];                 // A..E
    uint8_t bit_upper[3], bit_lower[3]; // Bit im Spaltenbyte für R/G/B
    uint8_t btn_tap, btn_next;       // freie Pins für die Taster
} pinmap_t;

const pinmap_t *hub75d_pinmap(int id);
void hub75d_init(int pinmap, uint16_t chain_w, uint16_t rows, uint8_t clk_div, const uint8_t *blank);
void hub75d_set_geometry(uint16_t chain_w, uint16_t rows, uint8_t clk_div, const uint8_t *blank);
void hub75d_show(const uint8_t *buf);
bool hub75d_swap_pending(void);
uint32_t hub75d_refresh_count(void);
