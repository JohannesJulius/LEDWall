// LEDWall-Empfänger für den RP2040 Zero
//
// Core 1: HUB75-Bildwiederholung (hub75.c)
// Core 0: Pakete vom Sender (UART, DMA-Ringpuffer) und von der App (USB) auswerten,
//         Bilder in Bitebenen umrechnen, Einstellungen verwalten.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "config.h"
#include "display.h"
#include "hardware/dma.h"
#include "hardware/flash.h"
#include "hardware/uart.h"
#include "hardware/watchdog.h"
#include "hub75.h"
#include "pico/bootrom.h"
#include "pico/flash.h"
#include "pico/stdlib.h"
#include "pico/unique_id.h"
#include "protocol.h"
#include "status_led.h"

#ifndef FW_VERSION
#define FW_VERSION "0.0.0-dev"
#endif

#define UART_ID uart0
#define PIN_UART_TX 0
#define PIN_UART_RX 1
#define RING_BITS 14
#define CFG_FLASH_OFFSET (PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE)
#define PAYLOAD_MAX (1 + CFG_MAX_PIXELS * 3)

static config_t cfg;
static display_t disp;
static uint8_t bufs[2][DISPLAY_BUF_MAX] __attribute__((aligned(4)));
static uint8_t canvas[CFG_MAX_PIXELS * 3];
static uint8_t uart_payload[PAYLOAD_MAX];
static uint8_t usb_payload[PAYLOAD_MAX];
static uint8_t ring[1 << RING_BITS] __attribute__((aligned(1 << RING_BITS)));

static int back = 0;           // Puffer, in den als Nächstes gezeichnet wird
static bool frame_ready;       // Bild im Rückpuffer wartet auf SHOW
static int test_mode;          // aktives Testbild
static absolute_time_t ident_until;
static bool showing_ident;
static bool got_frame;
static int dma_ch;
static uint32_t frames, last_frame_ms;
static lw_parser_t uart_parser, usb_parser;

// ---------------------------------------------------------------- Anzeige

static uint8_t *draw_buffer(void) {
    while (hub75_swap_pending()) tight_loop_contents(); // höchstens eine Bildwiederholung
    return bufs[back];
}

static void present(void) {
    hub75_show(bufs[back]);
    back ^= 1;
    frame_ready = false;
}

static void show_canvas(void) {
    display_convert(&disp, canvas, FMT_RGB888, draw_buffer());
    present();
}

static void redraw_overlay(void) {
    if (showing_ident) draw_ident(&cfg, canvas);
    else if (test_mode) draw_test(&cfg, test_mode, canvas);
    else if (!got_frame) draw_ident(&cfg, canvas);
    else return;
    show_canvas();
}

static void start_ident(uint32_t seconds) {
    showing_ident = true;
    ident_until = make_timeout_time_ms(seconds * 1000);
    redraw_overlay();
}

static void apply_geometry(void) {
    display_setup(&disp, &cfg);
    // Core 1 zeigt währenddessen einen leeren Puffer; danach zeichnen wir in den anderen
    memset(bufs[0], 0, sizeof bufs[0]);
    hub75_set_geometry(disp.chain_w, disp.rows, cfg.clk_div, bufs[0]);
    back = 1;
    frame_ready = false;
}

// ---------------------------------------------------------------- Pakete

static void on_packet(void *ctx, uint8_t addr, uint8_t type, const uint8_t *pl, uint16_t len) {
    const bool from_usb = ctx != NULL;
    if (!from_usb && addr != cfg.address && addr != LW_ADDR_ALL) return;
    const bool overlay = test_mode || showing_ident;
    const uint32_t npix = (uint32_t)cfg.width * cfg.height;
    switch (type) {
    case LW_FRAME_RGB888:
    case LW_FRAME_RGB565: {
        const uint32_t bpp = type == LW_FRAME_RGB888 ? 3 : 2;
        if (len != 1 + npix * bpp) return; // falsche Größe für diese Wand
        frames++;
        last_frame_ms = to_ms_since_boot(get_absolute_time());
        if (!got_frame) { got_frame = true; }
        if (overlay) return;
        display_convert(&disp, pl + 1, bpp == 3 ? FMT_RGB888 : FMT_RGB565, draw_buffer());
        frame_ready = true;
        if (pl[0] & LW_FLAG_SHOW) present();
        break;
    }
    case LW_SHOW:
        if (frame_ready && !overlay) present();
        break;
    case LW_FILL:
        if (len < 4 || overlay) return;
        for (uint32_t i = 0; i < npix; i++) memcpy(canvas + i * 3, pl + 1, 3);
        got_frame = true;
        display_convert(&disp, canvas, FMT_RGB888, draw_buffer());
        frame_ready = true;
        if (pl[0] & LW_FLAG_SHOW) present();
        break;
    case LW_BRIGHTNESS:
        if (len < 1) return;
        display_set_lut(&disp, pl[0], cfg.gamma_x10);
        break;
    case LW_TEST:
        if (len < 1) return;
        test_mode = pl[0] < TEST_COUNT ? pl[0] : 0;
        if (!test_mode) { memset(canvas, 0, npix * 3); show_canvas(); }
        redraw_overlay();
        break;
    case LW_IDENT:
        start_ident(len ? pl[0] : 5);
        break;
    case LW_BLACKOUT:
        memset(canvas, 0, npix * 3);
        show_canvas();
        break;
    }
}

// ---------------------------------------------------------------- UART (Sender)

static void uart_setup(void) {
    uart_init(UART_ID, cfg.baud);
    gpio_set_function(PIN_UART_TX, GPIO_FUNC_UART);
    gpio_set_function(PIN_UART_RX, GPIO_FUNC_UART);
    gpio_pull_up(PIN_UART_RX);
    uart_set_fifo_enabled(UART_ID, true);

    dma_ch = dma_claim_unused_channel(true);
    dma_channel_config c = dma_channel_get_default_config(dma_ch);
    channel_config_set_transfer_data_size(&c, DMA_SIZE_8);
    channel_config_set_read_increment(&c, false);
    channel_config_set_write_increment(&c, true);
    channel_config_set_ring(&c, true, RING_BITS);
    channel_config_set_dreq(&c, DREQ_UART0_RX);
    dma_channel_configure(dma_ch, &c, ring, &uart_get_hw(UART_ID)->dr, 0xFFFFFFFFu, true);
}

static void uart_poll(void) {
    static uint32_t tail;
    if (!dma_channel_is_busy(dma_ch)) dma_channel_set_trans_count(dma_ch, 0xFFFFFFFFu, true);
    const uint32_t head = (uint32_t)dma_hw->ch[dma_ch].write_addr - (uint32_t)ring;
    while (tail != head) {
        lw_parser_feed(&uart_parser, ring[tail]);
        tail = (tail + 1) & ((1u << RING_BITS) - 1);
    }
}

// ---------------------------------------------------------------- Flash

static void flash_write_cfg(void *param) {
    const config_t *c = param;
    static uint8_t page[FLASH_PAGE_SIZE * ((sizeof(config_t) + FLASH_PAGE_SIZE - 1) / FLASH_PAGE_SIZE)];
    memset(page, 0xFF, sizeof page);
    memcpy(page, c, sizeof *c);
    flash_range_erase(CFG_FLASH_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(CFG_FLASH_OFFSET, page, sizeof page);
}

static const config_t *flash_cfg(void) { return (const config_t *)(XIP_BASE + CFG_FLASH_OFFSET); }

static bool cfg_saved(void) { return memcmp(flash_cfg(), &cfg, sizeof cfg) == 0; }

static void load_cfg(void) {
    const config_t *f = flash_cfg();
    if (config_valid(f, NULL) && f->crc == config_checksum(f)) cfg = *f;
    else config_defaults(&cfg);
    cfg.crc = config_checksum(&cfg);
}

// ---------------------------------------------------------------- USB (App)

static void print_info(void) {
    static char json[700];
    char uid[2 * PICO_UNIQUE_BOARD_ID_SIZE_BYTES + 1];
    pico_get_unique_board_id_string(uid, sizeof uid);
    config_json(&cfg, json, sizeof json);
    printf("INFO {\"fw\":\"ledwall-rx\",\"ver\":\"%s\",\"uid\":\"%s\",\"board\":\"rp2040-zero\",%s,\"saved\":%s,\"test\":%d}\n",
           FW_VERSION, uid, json, cfg_saved() ? "true" : "false", test_mode);
}

static void handle_line(char *line) {
    char *arg = strchr(line, ' ');
    if (arg) *arg++ = 0;
    else arg = line + strlen(line);
    const char *why = NULL;

    if (!strcmp(line, "INFO")) {
        print_info();
    } else if (!strcmp(line, "SET")) {
        config_t old = cfg;
        if (!config_apply(&cfg, arg, &why)) { printf("ERR %s\n", why); return; }
        cfg.crc = config_checksum(&cfg);
        if (old.width != cfg.width || old.height != cfg.height || old.panel_w != cfg.panel_w ||
            old.panel_h != cfg.panel_h || old.panel_count != cfg.panel_count || old.clk_div != cfg.clk_div ||
            memcmp(old.panels, cfg.panels, sizeof cfg.panels) || old.color_order != cfg.color_order) {
            apply_geometry();
        } else {
            display_set_lut(&disp, cfg.brightness, cfg.gamma_x10);
        }
        if (old.baud != cfg.baud) uart_set_baudrate(UART_ID, cfg.baud);
        redraw_overlay();
        printf("OK\n");
    } else if (!strcmp(line, "SAVE")) {
        cfg.crc = config_checksum(&cfg);
        int r = flash_safe_execute(flash_write_cfg, &cfg, 500);
        if (r == PICO_OK && cfg_saved()) printf("OK\n");
        else printf("ERR Flash (%d)\n", r);
    } else if (!strcmp(line, "DEFAULTS")) {
        config_defaults(&cfg);
        cfg.crc = config_checksum(&cfg);
        apply_geometry();
        redraw_overlay();
        printf("OK\n");
    } else if (!strcmp(line, "IDENT")) {
        int s = atoi(arg);
        start_ident(s > 0 && s < 120 ? (uint32_t)s : 5);
        printf("OK\n");
    } else if (!strcmp(line, "TEST")) {
        uint8_t m = (uint8_t)atoi(arg);
        on_packet((void *)1, 0, LW_TEST, &m, 1);
        printf("OK\n");
    } else if (!strcmp(line, "STATS")) {
        printf("STATS {\"frames\":%lu,\"uart_packets\":%lu,\"uart_crc_errors\":%lu,\"usb_packets\":%lu,"
               "\"refresh\":%lu,\"uptime_ms\":%lu,\"last_frame_ms\":%lu}\n",
               (unsigned long)frames, (unsigned long)uart_parser.packets, (unsigned long)uart_parser.crc_errors,
               (unsigned long)usb_parser.packets, (unsigned long)hub75_refresh_count(),
               (unsigned long)to_ms_since_boot(get_absolute_time()), (unsigned long)last_frame_ms);
    } else if (!strcmp(line, "BOOTSEL")) {
        printf("OK\n");
        stdio_flush();
        sleep_ms(100);
        reset_usb_boot(0, 0);
    } else if (!strcmp(line, "REBOOT")) {
        printf("OK\n");
        stdio_flush();
        sleep_ms(100);
        watchdog_reboot(0, 0, 0);
    } else if (line[0]) {
        printf("ERR unbekannter Befehl\n");
    }
}

static void usb_poll(void) {
    static char line[256];
    static size_t n;
    char buf[64];
    int got;
    while ((got = stdio_get_until(buf, sizeof buf, get_absolute_time())) > 0) {
        for (int i = 0; i < got; i++) {
            const uint8_t b = (uint8_t)buf[i];
            // Binärpakete beginnen mit 0xA5, Textbefehle sind reines ASCII
            if (!lw_parser_idle(&usb_parser) || b == LW_SYNC0) {
                lw_parser_feed(&usb_parser, b);
                continue;
            }
            if (b == '\n' || b == '\r') {
                line[n] = 0;
                if (n) handle_line(line);
                n = 0;
            } else if (n + 1 < sizeof line) {
                line[n++] = (char)b;
            }
        }
    }
}

// ---------------------------------------------------------------- main

int main(void) {
    stdio_init_all();
    status_led_init();
    load_cfg();
    display_setup(&disp, &cfg);
    hub75_init(disp.chain_w, disp.rows, cfg.clk_div, bufs[0]);
    back = 1;
    lw_parser_init(&uart_parser, uart_payload, sizeof uart_payload, on_packet, NULL);
    lw_parser_init(&usb_parser, usb_payload, sizeof usb_payload, on_packet, (void *)1);
    uart_setup();
    redraw_overlay(); // Adresse anzeigen, bis das erste Bild kommt

    uint32_t last_led = 0;
    for (;;) {
        uart_poll();
        usb_poll();
        if (showing_ident && time_reached(ident_until)) {
            showing_ident = false;
            if (test_mode || !got_frame) redraw_overlay();
        }
        const uint32_t now = to_ms_since_boot(get_absolute_time());
        if (now - last_led > 50) {
            last_led = now;
            if (showing_ident) status_led_set(255, 0, 255);
            else if (test_mode) status_led_set(255, 160, 0);
            else if (got_frame && now - last_frame_ms < 500) status_led_set(0, 255, 0);
            else status_led_set(0, 0, (now / 500) % 2 ? 255 : 40); // wartet auf Signal
        }
    }
}
