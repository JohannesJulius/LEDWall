// Schnittstelle zwischen Weboberfläche und Sender-Logik (main.c)
#pragma once
#include <stdbool.h>
#include <stddef.h>

int sender_state_json(char *out, size_t cap, bool full);
// Führt einen Befehl aus (wie über USB) und liefert die Antwort
const char *sender_command(char *line, bool from_usb, char *reply, size_t cap);

#include <stdint.h>
// Bank-Upload über WLAN: Start (NULL = ok, sonst Fehlertext), Daten, Ergebnis (NULL = läuft noch)
const char *sender_upload_begin(uint32_t size, uint32_t crc);
void sender_upload_data(const uint8_t *data, uint32_t len);
const char *sender_upload_result(void);
