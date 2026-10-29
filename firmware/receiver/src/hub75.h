// HUB75-Bildwiederholung auf Core 1 (PIO0)
#pragma once
#include <stdbool.h>
#include <stdint.h>

// Feste Pinbelegung RP2040 Zero (siehe docs/receiver.md)
#define PIN_R0 2      // R0 G0 B0 R1 G1 B1 = GP2..GP7
#define PIN_ADDR 8    // A B C D E = GP8..GP12
#define PIN_CLK 13
#define PIN_LAT 14    // LAT = GP14, OE = GP15
#define PIN_OE 15

void hub75_init(uint16_t chain_w, uint16_t rows, uint8_t clk_div, const uint8_t *blank);
// Geometrie ändern: hält Core 1 kurz an
void hub75_set_geometry(uint16_t chain_w, uint16_t rows, uint8_t clk_div, const uint8_t *blank);
// Puffer zum nächsten Bildwechsel anzeigen
void hub75_show(const uint8_t *buf);
bool hub75_swap_pending(void);
uint32_t hub75_refresh_count(void);
