#include "display.h"

#include <math.h>
#include <string.h>

#define NONE 0xFFFFFFFFu
#define BP DISPLAY_BITPLANES

static const uint8_t PERMS[6][3] = {{0, 1, 2}, {0, 2, 1}, {1, 0, 2}, {1, 2, 0}, {2, 0, 1}, {2, 1, 0}};

void display_set_lut(display_t *d, uint8_t brightness, uint8_t gamma_x10) {
    const float g = gamma_x10 / 10.0f, scale = (float)((1 << BP) - 1) * brightness / 255.0f;
    for (int i = 0; i < 256; i++) {
        float v = powf(i / 255.0f, g) * scale;
        d->lut[i] = (uint16_t)(v + 0.5f);
    }
}

void display_setup(display_t *d, const config_t *c) {
    d->width = c->width;
    d->height = c->height;
    d->chain_w = (uint16_t)(c->panel_w * c->panel_count);
    d->rows = (uint16_t)(c->panel_h / 2);
    d->buf_size = (uint32_t)d->rows * BP * d->chain_w;
    memcpy(d->perm, PERMS[c->color_order % 6], 3);
    display_set_lut(d, c->brightness, c->gamma_x10);
    const uint32_t npix = (uint32_t)c->width * c->height;
    for (uint32_t i = 0; i < npix; i++) d->map[i] = NONE;
    for (int p = 0; p < c->panel_count; p++) {
        const panel_t *pn = &c->panels[p];
        for (int ly = 0; ly < c->panel_h; ly++) {
            for (int lx = 0; lx < c->panel_w; lx++) {
                int x = pn->x + ((pn->flags & PANEL_MIRROR_X) ? c->panel_w - 1 - lx : lx);
                int y = pn->y + ((pn->flags & PANEL_MIRROR_Y) ? c->panel_h - 1 - ly : ly);
                if (x >= c->width || y >= c->height) continue;
                uint32_t col = (uint32_t)p * c->panel_w + lx;
                uint32_t row = (uint32_t)(ly % d->rows);
                uint32_t shift = ly < d->rows ? 0 : 3;
                d->map[y * c->width + x] = (row * BP * d->chain_w + col) | (shift << 24);
            }
        }
    }
}

void display_convert(const display_t *d, const uint8_t *src, int fmt, uint8_t *dst) {
    memset(dst, 0, d->buf_size);
    const uint32_t npix = (uint32_t)d->width * d->height;
    const uint32_t stride = d->chain_w;
    uint8_t ch[3];
    for (uint32_t i = 0; i < npix; i++) {
        const uint32_t m = d->map[i];
        if (fmt == FMT_RGB888) {
            ch[0] = src[0]; ch[1] = src[1]; ch[2] = src[2];
            src += 3;
        } else {
            const uint16_t v = (uint16_t)(src[0] | (src[1] << 8));
            ch[0] = (uint8_t)(((v >> 11) & 0x1F) * 255 / 31);
            ch[1] = (uint8_t)(((v >> 5) & 0x3F) * 255 / 63);
            ch[2] = (uint8_t)((v & 0x1F) * 255 / 31);
            src += 2;
        }
        if (m == NONE) continue;
        const uint32_t r = d->lut[ch[d->perm[0]]], g = d->lut[ch[d->perm[1]]], b = d->lut[ch[d->perm[2]]];
        if (!(r | g | b)) continue;
        uint8_t *p = dst + (m & 0xFFFFFF);
        const uint32_t sh = m >> 24;
        for (int bit = 0; bit < BP; bit++, p += stride) {
            *p |= (uint8_t)((((r >> bit) & 1) | (((g >> bit) & 1) << 1) | (((b >> bit) & 1) << 2)) << sh);
        }
    }
}

// ---------------------------------------------------------------- Zeichnen

static const uint8_t DIGITS[10][7] = {
    {0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E}, {0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E},
    {0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F}, {0x1F, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0E},
    {0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02}, {0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E},
    {0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E}, {0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08},
    {0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E}, {0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C},
};

static void put(const config_t *c, uint8_t *cv, int x, int y, uint8_t r, uint8_t g, uint8_t b) {
    if (x < 0 || y < 0 || x >= c->width || y >= c->height) return;
    uint8_t *p = cv + (y * c->width + x) * 3;
    p[0] = r; p[1] = g; p[2] = b;
}

static void rect(const config_t *c, uint8_t *cv, int x0, int y0, int w, int h, uint8_t r, uint8_t g, uint8_t b) {
    for (int y = y0; y < y0 + h; y++)
        for (int x = x0; x < x0 + w; x++) put(c, cv, x, y, r, g, b);
}

static void number(const config_t *c, uint8_t *cv, int x, int y, unsigned n, int s, uint8_t r, uint8_t g, uint8_t b) {
    char buf[6];
    int len = 0;
    do { buf[len++] = (char)('0' + n % 10); n /= 10; } while (n && len < 5);
    for (int i = len - 1, cx = x; i >= 0; i--, cx += 6 * s) {
        const uint8_t *gl = DIGITS[buf[i] - '0'];
        for (int row = 0; row < 7; row++)
            for (int col = 0; col < 5; col++)
                if (gl[row] & (0x10 >> col)) rect(c, cv, cx + col * s, y + row * s, s, s, r, g, b);
    }
}

static int digits(unsigned n) { int d = 1; while (n >= 10) { n /= 10; d++; } return d; }

static void hue(int i, uint8_t *r, uint8_t *g, uint8_t *b) {
    static const uint8_t H[8][3] = {{255, 0, 0}, {0, 255, 0}, {0, 80, 255}, {255, 200, 0},
                                    {255, 0, 255}, {0, 255, 255}, {255, 120, 0}, {160, 255, 160}};
    *r = H[i % 8][0]; *g = H[i % 8][1]; *b = H[i % 8][2];
}

void draw_test(const config_t *c, int mode, uint8_t *cv) {
    const int W = c->width, H = c->height;
    memset(cv, 0, (size_t)W * H * 3);
    switch (mode) {
    case TEST_COLORS:
        for (int x = 0; x < W; x++) {
            int q = x * 4 / W;
            rect(c, cv, x, 0, 1, H, q == 0 || q == 3 ? 255 : 0, q == 1 || q == 3 ? 255 : 0, q == 2 || q == 3 ? 255 : 0);
        }
        break;
    case TEST_GRADIENT:
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++) put(c, cv, x, y, (uint8_t)(x * 255 / (W - 1)), (uint8_t)(y * 255 / (H - 1)), 40);
        break;
    case TEST_PANELS:
        for (int p = 0; p < c->panel_count; p++) {
            const panel_t *pn = &c->panels[p];
            uint8_t r, g, b;
            hue(p, &r, &g, &b);
            rect(c, cv, pn->x, pn->y, c->panel_w, c->panel_h, r / 6, g / 6, b / 6);
            for (int i = 0; i < c->panel_w; i++) { put(c, cv, pn->x + i, pn->y, r, g, b); put(c, cv, pn->x + i, pn->y + c->panel_h - 1, r, g, b); }
            for (int i = 0; i < c->panel_h; i++) { put(c, cv, pn->x, pn->y + i, r, g, b); put(c, cv, pn->x + c->panel_w - 1, pn->y + i, r, g, b); }
            int s = c->panel_h >= 24 ? 2 : 1;
            number(c, cv, pn->x + 2, pn->y + 2, (unsigned)p + 1, s, 255, 255, 255);
            // Pfeil nach rechts: zeigt die Leserichtung des Panels
            int ay = pn->y + 2 + 3 * s, ax = pn->x + 2 + 6 * s * digits((unsigned)p + 1) + 1;
            for (int i = 0; i < 6; i++) put(c, cv, ax + i, ay, 255, 255, 255);
            put(c, cv, ax + 4, ay - 1, 255, 255, 255); put(c, cv, ax + 4, ay + 1, 255, 255, 255);
        }
        break;
    case TEST_GRID:
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
                if (x % 8 == 0 || y % 8 == 0 || x == W - 1 || y == H - 1) put(c, cv, x, y, 60, 60, 60);
        rect(c, cv, 0, 0, 3, 3, 255, 0, 0);          // oben links rot
        rect(c, cv, W - 3, 0, 3, 3, 0, 255, 0);      // oben rechts grün
        rect(c, cv, 0, H - 3, 3, 3, 0, 80, 255);     // unten links blau
        rect(c, cv, W - 3, H - 3, 3, 3, 255, 255, 255);
        break;
    case TEST_WHITE:
        memset(cv, 255, (size_t)W * H * 3);
        break;
    default:
        break;
    }
}

void draw_ident(const config_t *c, uint8_t *cv) {
    const int W = c->width, H = c->height;
    memset(cv, 0, (size_t)W * H * 3);
    for (int x = 0; x < W; x++) { put(c, cv, x, 0, 0, 90, 120); put(c, cv, x, H - 1, 0, 90, 120); }
    for (int y = 0; y < H; y++) { put(c, cv, 0, y, 0, 90, 120); put(c, cv, W - 1, y, 0, 90, 120); }
    const int n = digits(c->address);
    int s = (W - 6) / (n * 6);
    if ((H - 6) / 7 < s) s = (H - 6) / 7;
    if (s < 1) s = 1;
    const int tw = n * 6 * s - s, th = 7 * s;
    number(c, cv, (W - tw) / 2, (H - th) / 2, c->address, s, 0, 230, 255);
}
