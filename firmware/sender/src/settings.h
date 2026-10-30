// Dauerhafte Einstellungen des Senders (letzter Flash-Sektor)
#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    uint32_t magic;
    uint16_t version, size;
    uint8_t wifi_mode;        // 0 = eigenes Netz (Access Point), 1 = vorhandenes WLAN
    char ap_ssid[33];
    char ap_pass[65];
    char sta_ssid[33];
    char sta_pass[65];
    float bpm;                // Start-BPM
    int16_t auto_bars;        // Auto-Wechsel (0 = aus)
    uint8_t brightness;       // 0..255, an alle Wände
    uint32_t baud;            // UART zu den Empfängern
    uint32_t crc;
} settings_t;

void settings_defaults(settings_t *s);
bool settings_valid(const settings_t *s);
uint32_t settings_checksum(const settings_t *s);
