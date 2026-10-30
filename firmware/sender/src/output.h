// UART-Ausgänge zu den Empfängern, gesendet per DMA
#pragma once
#include <stdbool.h>
#include <stdint.h>

#define OUT_CHANNELS 2   // Ausgang 1 = UART0 TX (GP0), Ausgang 2 = UART1 TX (GP4)

void out_init(uint32_t baud);
void out_set_baud(uint32_t baud);
// Datenblock anhängen; der Speicher muss gültig bleiben, bis out_idle() true ist
bool out_queue(int ch, const uint8_t *data, uint32_t len);
void out_poll(void);
bool out_idle(void);
uint32_t out_bytes_sent(void);
