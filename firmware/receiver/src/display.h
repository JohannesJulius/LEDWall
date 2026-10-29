// Umrechnung Wandbild (zeilenweise, oben links) -> HUB75-Bitebenen der Panel-Kette
#pragma once
#include <stdbool.h>
#include <stdint.h>

#include "config.h"

typedef struct {
    uint16_t width, height;   // Wandbild
    uint16_t chain_w;         // Spalten der ganzen Kette
    uint16_t rows;            // Adresszeilen (= Panelhöhe / 2)
    uint32_t buf_size;        // Bytes je Bildpuffer
    uint8_t perm[3];          // Farbreihenfolge
    uint16_t lut[256];        // Gamma + Helligkeit -> 10 Bit
    uint32_t map[CFG_MAX_PIXELS]; // Pufferoffset | (Bitversatz << 24), 0xFFFFFFFF = kein Panel
} display_t;

enum { FMT_RGB888, FMT_RGB565 };

void display_setup(display_t *d, const config_t *c);
void display_set_lut(display_t *d, uint8_t brightness, uint8_t gamma_x10);
// src: width*height Pixel im Format fmt -> dst (buf_size Byte)
void display_convert(const display_t *d, const uint8_t *src, int fmt, uint8_t *dst);

// Zeichnen in ein RGB888-Wandbild (für Testbilder und Adressanzeige)
enum { TEST_OFF, TEST_COLORS, TEST_GRADIENT, TEST_PANELS, TEST_GRID, TEST_WHITE, TEST_COUNT };
void draw_test(const config_t *c, int mode, uint8_t *canvas);
void draw_ident(const config_t *c, uint8_t *canvas);
