#include "config.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CFG_MAGIC 0x4C57524Bu // "LWRK"
#define CFG_VERSION 1

void config_defaults(config_t *c) {
    memset(c, 0, sizeof *c);
    c->magic = CFG_MAGIC;
    c->version = CFG_VERSION;
    c->size = sizeof *c;
    c->address = 1;
    strcpy(c->name, "Wand");
    c->width = 64;
    c->height = 48;
    c->panel_w = 64;
    c->panel_h = 16;
    c->panel_count = 3;
    for (int i = 0; i < 3; i++) c->panels[i] = (panel_t){0, (uint16_t)(i * 16), 0};
    c->color_order = 0;
    c->brightness = 255;
    c->gamma_x10 = 22;
    c->clk_div = 3;
    c->baud = 2000000;
}

uint32_t config_checksum(const config_t *c) {
    // FNV-1a über alles außer dem crc-Feld
    const uint8_t *p = (const uint8_t *)c;
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < offsetof(config_t, crc); i++) h = (h ^ p[i]) * 16777619u;
    return h;
}

static bool is_pow2(unsigned v) { return v && !(v & (v - 1)); }

bool config_valid(const config_t *c, const char **why) {
    const char *w = NULL;
    if (c->magic != CFG_MAGIC || c->version != CFG_VERSION || c->size != sizeof *c) w = "format";
    else if (c->address < 1 || c->address > 254) w = "addr muss 1..254 sein";
    else if (!c->width || !c->height || (unsigned)c->width * c->height > CFG_MAX_PIXELS) w = "w/h zu groß";
    else if (c->panel_w < 4 || c->panel_w % 4) w = "pw muss ein Vielfaches von 4 sein";
    else if (c->panel_h < 4 || !is_pow2(c->panel_h / 2u) || c->panel_h / 2u > 32) w = "ph muss 8, 16, 32 oder 64 sein";
    else if (!c->panel_count || c->panel_count > CFG_MAX_PANELS) w = "1..8 Panels";
    else if ((unsigned)c->panel_count * c->panel_w > CFG_MAX_CHAIN_W) w = "Kette zu lang";
    else if ((unsigned)c->panel_h / 2u * DISPLAY_BITPLANES * c->panel_count * c->panel_w > DISPLAY_BUF_MAX) w = "zu viele Pixel in der Kette";
    else if (c->color_order > 5) w = "order 0..5";
    else if (c->gamma_x10 < 10 || c->gamma_x10 > 30) w = "gamma 10..30";
    else if (c->clk_div < 1 || c->clk_div > 16) w = "div 1..16";
    else if (c->baud < 9600 || c->baud > 7800000) w = "baud";
    if (why) *why = w;
    return w == NULL;
}

static void url_decode(char *dst, const char *src, size_t cap) {
    size_t n = 0;
    while (*src && n + 1 < cap) {
        if (*src == '%' && src[1] && src[2]) {
            char hex[3] = {src[1], src[2], 0};
            dst[n++] = (char)strtol(hex, NULL, 16);
            src += 3;
        } else {
            dst[n++] = *src++;
        }
    }
    dst[n] = 0;
}

static bool parse_panels(config_t *c, const char *v) {
    // "x,y,flags;x,y,flags;..."
    int n = 0;
    while (*v && n < CFG_MAX_PANELS) {
        char *end;
        long x = strtol(v, &end, 10);
        if (*end != ',') return false;
        long y = strtol(end + 1, &end, 10);
        long f = 0;
        if (*end == ',') f = strtol(end + 1, &end, 10);
        if (x < 0 || y < 0 || x > 1024 || y > 1024 || f < 0 || f > 3) return false;
        c->panels[n++] = (panel_t){(uint16_t)x, (uint16_t)y, (uint8_t)f};
        if (*end == ';') end++;
        else if (*end) return false;
        v = end;
    }
    if (*v) return false;
    c->panel_count = (uint8_t)n;
    return n > 0;
}

bool config_apply(config_t *c, const char *args, const char **why) {
    config_t t = *c;
    char tok[160];
    const char *p = args;
    while (*p) {
        while (*p == ' ') p++;
        if (!*p) break;
        size_t n = 0;
        while (p[n] && p[n] != ' ') n++;
        if (n >= sizeof tok) { *why = "zu lang"; return false; }
        memcpy(tok, p, n);
        tok[n] = 0;
        p += n;
        char *eq = strchr(tok, '=');
        if (!eq) { *why = "key=value erwartet"; return false; }
        *eq = 0;
        const char *k = tok, *v = eq + 1;
        long num = strtol(v, NULL, 10);
        if (!strcmp(k, "addr")) t.address = (uint8_t)(num < 0 || num > 255 ? 0 : num);
        else if (!strcmp(k, "name")) url_decode(t.name, v, sizeof t.name);
        else if (!strcmp(k, "w")) t.width = (uint16_t)num;
        else if (!strcmp(k, "h")) t.height = (uint16_t)num;
        else if (!strcmp(k, "pw")) t.panel_w = (uint16_t)num;
        else if (!strcmp(k, "ph")) t.panel_h = (uint16_t)num;
        else if (!strcmp(k, "panels")) { if (!parse_panels(&t, v)) { *why = "panels ungültig"; return false; } }
        else if (!strcmp(k, "order")) t.color_order = (uint8_t)num;
        else if (!strcmp(k, "bright")) t.brightness = (uint8_t)(num > 255 ? 255 : num < 0 ? 0 : num);
        else if (!strcmp(k, "gamma")) t.gamma_x10 = (uint8_t)num;
        else if (!strcmp(k, "div")) t.clk_div = (uint8_t)num;
        else if (!strcmp(k, "baud")) t.baud = (uint32_t)strtoul(v, NULL, 10);
        else { *why = "unbekannter Schlüssel"; return false; }
    }
    if (!config_valid(&t, why)) return false;
    for (int i = 0; i < t.panel_count; i++) {
        if (t.panels[i].x + t.panel_w > t.width || t.panels[i].y + t.panel_h > t.height) {
            *why = "Panel liegt außerhalb des Bildes";
            return false;
        }
    }
    *c = t;
    return true;
}

int config_json(const config_t *c, char *out, size_t cap) {
    char name[64];
    size_t n = 0;
    for (const char *s = c->name; *s && n + 2 < sizeof name; s++) {
        if (*s == '"' || *s == '\\') name[n++] = '\\';
        name[n++] = *s;
    }
    name[n] = 0;
    int len = snprintf(out, cap,
        "\"addr\":%u,\"name\":\"%s\",\"w\":%u,\"h\":%u,\"pw\":%u,\"ph\":%u,\"panels\":[",
        c->address, name, c->width, c->height, c->panel_w, c->panel_h);
    for (int i = 0; i < c->panel_count && len > 0 && (size_t)len < cap; i++) {
        len += snprintf(out + len, cap - len, "%s[%u,%u,%u]", i ? "," : "",
                        c->panels[i].x, c->panels[i].y, c->panels[i].flags);
    }
    if (len > 0 && (size_t)len < cap) {
        len += snprintf(out + len, cap - len, "],\"order\":%u,\"bright\":%u,\"gamma\":%u,\"div\":%u,\"baud\":%lu",
                        c->color_order, c->brightness, c->gamma_x10, c->clk_div, (unsigned long)c->baud);
    }
    return len;
}
