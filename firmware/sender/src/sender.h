// Schnittstelle zwischen Weboberfläche und Sender-Logik (main.c)
#pragma once
#include <stdbool.h>
#include <stddef.h>

int sender_state_json(char *out, size_t cap, bool full);
// Führt einen Befehl aus (wie über USB) und liefert die Antwort
const char *sender_command(char *line, bool from_usb, char *reply, size_t cap);
