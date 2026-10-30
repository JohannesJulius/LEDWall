// Pattern-Bank (.lwb) lesen, siehe docs/lwb-format.md
#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define BANK_MAX_PATTERNS 128
#define BANK_MAX_WALLS 8

typedef struct {
    char name[21];
    uint16_t loop_beats;
    uint16_t flags;
    uint32_t frame_count;
    uint32_t offset;
} bank_pattern_t;

typedef struct {
    uint8_t address;
    uint8_t channel;          // Sender-Ausgang (0 = GP0, 1 = GP4)
    uint16_t width, height;   // Pixel der Wand
    uint16_t rx, ry, rw, rh;  // Ausschnitt der Leinwand in 1/16 Pixel
    char name[19];
} bank_wall_t;

typedef struct {
    const uint8_t *data;
    uint32_t size;
    uint16_t width, height;   // Leinwand (= Bildgröße in der Bank)
    float ref_bpm;
    uint8_t fpb;              // Frames pro Beat
    uint8_t bpp;              // 3 = RGB888, 2 = RGB565
    uint16_t count;
    bank_pattern_t patterns[BANK_MAX_PATTERNS];
    uint8_t mode;             // 0 = jede Wand ganzes Bild, 1 = verteilt
    uint8_t wall_count;       // 0 = kein Setup: Bild an alle (Adresse 0xFF)
    bank_wall_t walls[BANK_MAX_WALLS];
    bool broadcast;           // alle Wände zeigen genau das Leinwandbild -> ein Paket an alle
} bank_t;

// Prüft und liest die Bank. Gibt NULL oder eine Fehlermeldung zurück.
const char *bank_open(bank_t *b, const uint8_t *data, uint32_t size);
uint32_t bank_frame_bytes(const bank_t *b);
// Frame zur Beat-Position (läuft im Loop des Patterns)
uint32_t bank_frame_index(const bank_t *b, int pattern, double beat);
const uint8_t *bank_frame(const bank_t *b, int pattern, uint32_t index);
// Bild einer Wand aus dem Leinwandbild ausschneiden/skalieren (gleiches Pixelformat)
void bank_sample_wall(const bank_t *b, const uint8_t *frame, const bank_wall_t *w, uint8_t *out);

uint32_t crc32_update(uint32_t crc, const uint8_t *data, size_t len);
