#include "output.h"

#include "hardware/dma.h"
#include "hardware/gpio.h"
#include "hardware/uart.h"

#define QLEN 48

typedef struct { const uint8_t *p; uint32_t n; } seg_t;

typedef struct {
    uart_inst_t *uart;
    uint tx_pin;
    uint dreq;
    int dma;
    seg_t q[QLEN];
    int head, tail;
} chan_t;

static chan_t ch[OUT_CHANNELS] = {
    {uart0, 0, DREQ_UART0_TX, -1, {{0}}, 0, 0},
    {uart1, 4, DREQ_UART1_TX, -1, {{0}}, 0, 0},
};
static uint32_t sent;

void out_init(uint32_t baud) {
    for (int i = 0; i < OUT_CHANNELS; i++) {
        uart_init(ch[i].uart, baud);
        uart_set_fifo_enabled(ch[i].uart, true);
        gpio_set_function(ch[i].tx_pin, UART_FUNCSEL_NUM(ch[i].uart, ch[i].tx_pin));
        ch[i].dma = dma_claim_unused_channel(true);
        dma_channel_config c = dma_channel_get_default_config(ch[i].dma);
        channel_config_set_transfer_data_size(&c, DMA_SIZE_8);
        channel_config_set_read_increment(&c, true);
        channel_config_set_write_increment(&c, false);
        channel_config_set_dreq(&c, ch[i].dreq);
        dma_channel_configure(ch[i].dma, &c, &uart_get_hw(ch[i].uart)->dr, NULL, 0, false);
    }
}

void out_set_baud(uint32_t baud) {
    for (int i = 0; i < OUT_CHANNELS; i++) {
        uart_tx_wait_blocking(ch[i].uart);
        uart_set_baudrate(ch[i].uart, baud);
    }
}

bool out_queue(int c, const uint8_t *data, uint32_t len) {
    if (c < 0 || c >= OUT_CHANNELS || !len) return false;
    chan_t *k = &ch[c];
    int nt = (k->tail + 1) % QLEN;
    if (nt == k->head) return false;
    k->q[k->tail] = (seg_t){data, len};
    k->tail = nt;
    out_poll();
    return true;
}

void out_poll(void) {
    for (int i = 0; i < OUT_CHANNELS; i++) {
        chan_t *k = &ch[i];
        if (k->head == k->tail || dma_channel_is_busy(k->dma)) continue;
        seg_t s = k->q[k->head];
        k->head = (k->head + 1) % QLEN;
        sent += s.n;
        dma_channel_transfer_from_buffer_now(k->dma, s.p, s.n);
    }
}

bool out_idle(void) {
    for (int i = 0; i < OUT_CHANNELS; i++) {
        if (ch[i].head != ch[i].tail || dma_channel_is_busy(ch[i].dma)) return false;
        if (uart_get_hw(ch[i].uart)->fr & UART_UARTFR_BUSY_BITS) return false;
    }
    return true;
}

uint32_t out_bytes_sent(void) { return sent; }
