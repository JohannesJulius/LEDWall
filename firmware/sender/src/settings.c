#include "settings.h"

#include <stddef.h>
#include <string.h>

#define MAGIC 0x4C575458u // "LWTX"

void settings_defaults(settings_t *s) {
    memset(s, 0, sizeof *s);
    s->magic = MAGIC;
    s->version = 1;
    s->size = sizeof *s;
    s->wifi_mode = 0;
    strcpy(s->ap_ssid, "LEDWall");
    strcpy(s->ap_pass, "ledwall123");
    s->bpm = 140.0f;
    s->auto_bars = 0;
    s->brightness = 255;
    s->baud = 2000000;
    s->crc = settings_checksum(s);
}

uint32_t settings_checksum(const settings_t *s) {
    const uint8_t *p = (const uint8_t *)s;
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < offsetof(settings_t, crc); i++) h = (h ^ p[i]) * 16777619u;
    return h;
}

bool settings_valid(const settings_t *s) {
    return s->magic == MAGIC && s->version == 1 && s->size == sizeof *s && s->crc == settings_checksum(s) &&
           s->bpm >= 20 && s->bpm <= 300 && s->baud >= 9600 && s->baud <= 7800000 &&
           s->ap_ssid[0] && strlen(s->ap_pass) >= 8;
}
