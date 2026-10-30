#include "bank.h"

#include <math.h>
#include <string.h>

static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | (p[1] << 8)); }
static uint32_t rd32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }

const char *bank_open(bank_t *b, const uint8_t *d, uint32_t size) {
    memset(b, 0, sizeof *b);
    if (size < 32 || memcmp(d, "LWB1", 4)) return "keine Bank";
    b->data = d;
    b->size = size;
    b->width = rd16(d + 4);
    b->height = rd16(d + 6);
    b->ref_bpm = rd16(d + 8) / 10.0f;
    b->fpb = d[10];
    b->bpp = d[11] == 1 ? 2 : 3;
    b->count = rd16(d + 12);
    const uint32_t table = rd32(d + 16), setup = rd32(d + 20), total = rd32(d + 24);
    if (total != size) return "Größe stimmt nicht (Bank mit der App neu exportieren)";
    if (!b->width || !b->height || !b->fpb || d[11] > 1) return "Kopf ungültig";
    if (b->count == 0 || b->count > BANK_MAX_PATTERNS) return "Anzahl Patterns";
    if (table < 32 || table + 32u * b->count > size) return "Tabelle";
    const uint32_t fb = bank_frame_bytes(b);
    for (int i = 0; i < b->count; i++) {
        const uint8_t *e = d + table + 32 * i;
        bank_pattern_t *p = &b->patterns[i];
        memcpy(p->name, e, 20);
        p->name[20] = 0;
        p->loop_beats = rd16(e + 20);
        p->flags = rd16(e + 22);
        p->frame_count = rd32(e + 24);
        p->offset = rd32(e + 28);
        if (!p->loop_beats || !p->frame_count) return "Pattern leer";
        if ((uint64_t)p->offset + (uint64_t)p->frame_count * fb > size) return "Frames außerhalb";
    }
    if (setup) {
        if (setup + 8 > size || memcmp(d + setup, "LWS1", 4)) return "Setup ungültig";
        const uint16_t n = rd16(d + setup + 4);
        if (n > BANK_MAX_WALLS || setup + 8 + 32u * n > size) return "zu viele Wände";
        b->mode = d[setup + 6];
        b->wall_count = (uint8_t)n;
        for (int i = 0; i < n; i++) {
            const uint8_t *e = d + setup + 8 + 32 * i;
            bank_wall_t *w = &b->walls[i];
            w->address = e[0];
            w->channel = e[1] & 1;
            w->width = rd16(e + 2);
            w->height = rd16(e + 4);
            w->rx = rd16(e + 6); w->ry = rd16(e + 8); w->rw = rd16(e + 10); w->rh = rd16(e + 12);
            memcpy(w->name, e + 14, 18);
            w->name[18] = 0;
            if (!w->width || !w->height || !w->rw || !w->rh) return "Wand ungültig";
            if ((uint32_t)w->width * w->height > 128u * 64u) return "Wand zu groß";
        }
    }
    // Sonderfall: jede Wand zeigt genau das ganze Leinwandbild -> ein Paket an alle
    b->broadcast = true;
    for (int i = 0; i < b->wall_count; i++) {
        const bank_wall_t *w = &b->walls[i];
        if (w->width != b->width || w->height != b->height || w->rx || w->ry ||
            w->rw != b->width * 16 || w->rh != b->height * 16) b->broadcast = false;
    }
    return NULL;
}

uint32_t bank_frame_bytes(const bank_t *b) { return (uint32_t)b->width * b->height * b->bpp; }

uint32_t bank_frame_index(const bank_t *b, int pattern, double beat) {
    const bank_pattern_t *p = &b->patterns[pattern];
    double lb = fmod(beat, (double)p->loop_beats);
    if (lb < 0) lb += p->loop_beats;
    uint32_t i = (uint32_t)floor(lb * b->fpb);
    return i % p->frame_count;
}

const uint8_t *bank_frame(const bank_t *b, int pattern, uint32_t index) {
    const bank_pattern_t *p = &b->patterns[pattern];
    return b->data + p->offset + index * bank_frame_bytes(b);
}

void bank_sample_wall(const bank_t *b, const uint8_t *frame, const bank_wall_t *w, uint8_t *out) {
    const uint32_t bpp = b->bpp;
    for (uint32_t y = 0; y < w->height; y++) {
        // Mittelpunkt des Wandpixels in Leinwand-Pixeln (Festkomma 1/16)
        const int32_t sy = (int32_t)(w->ry + ((2 * y + 1) * (uint32_t)w->rh) / (2u * w->height)) >> 4;
        for (uint32_t x = 0; x < w->width; x++, out += bpp) {
            const int32_t sx = (int32_t)(w->rx + ((2 * x + 1) * (uint32_t)w->rw) / (2u * w->width)) >> 4;
            if (sx < 0 || sy < 0 || sx >= b->width || sy >= b->height) { memset(out, 0, bpp); continue; }
            memcpy(out, frame + ((uint32_t)sy * b->width + (uint32_t)sx) * bpp, bpp);
        }
    }
}

uint32_t crc32_update(uint32_t crc, const uint8_t *data, size_t len) {
    static uint32_t table[256];
    static bool ready;
    if (!ready) {
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (int k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[i] = c;
        }
        ready = true;
    }
    crc = ~crc;
    while (len--) crc = table[(crc ^ *data++) & 0xFF] ^ (crc >> 8);
    return ~crc;
}
