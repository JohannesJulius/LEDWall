#include "hub75.h"

#include "config.h"
#include "hardware/clocks.h"
#include "hardware/gpio.h"
#include "hardware/pio.h"
#include "hardware/structs/io_bank0.h"
#include "hardware/structs/sio.h"
#include "hub75.pio.h"
#include "pico/multicore.h"

#define BP DISPLAY_BITPLANES
#define SM_DATA 0
#define SM_ROW 1
#define ROW_CLKDIV 2
#define PULSE_BASE 6  // Takte (bei ROW_CLKDIV) für die niedrigste Bitebene

static PIO const pio = pio0;
static uint data_offset, row_offset;
static volatile const uint8_t *front;
static volatile const uint8_t *pending;
static volatile bool swap_req, pause_req, paused;
static volatile uint32_t refreshes;
static uint16_t g_chain_w, g_rows;

static inline void wait_tx_stall(uint sm) {
    const uint32_t mask = 1u << (PIO_FDEBUG_TXSTALL_LSB + sm);
    pio->fdebug = mask;
    while (!(pio->fdebug & mask)) tight_loop_contents();
}

static void __not_in_flash_func(core1_main)(void) {
    multicore_lockout_victim_init(); // erlaubt Flash-Schreiben von Core 0 aus
    for (;;) {
        if (pause_req) {
            paused = true;
            while (pause_req) tight_loop_contents();
            paused = false;
        }
        const uint8_t *buf = (const uint8_t *)front;
        const uint w4 = g_chain_w / 4, rows = g_rows, stride = g_chain_w;
        for (uint r = 0; r < rows; r++) {
            for (uint b = 0; b < BP; b++) {
                const uint32_t *src = (const uint32_t *)(buf + (r * BP + b) * stride);
                for (uint i = 0; i < w4; i++) pio_sm_put_blocking(pio, SM_DATA, src[i]);
                wait_tx_stall(SM_DATA);
                wait_tx_stall(SM_ROW);
                pio_sm_put_blocking(pio, SM_ROW, r | ((PULSE_BASE << b) - 1) << 5);
            }
        }
        refreshes++;
        if (swap_req) {
            front = pending;
            swap_req = false;
        }
    }
}

static void setup_sms(uint8_t clk_div) {
    pio_sm_set_enabled(pio, SM_DATA, false);
    pio_sm_set_enabled(pio, SM_ROW, false);

    pio_sm_config c = hub75_data_program_get_default_config(data_offset);
    sm_config_set_out_pins(&c, PIN_R0, 6);
    sm_config_set_sideset_pins(&c, PIN_CLK);
    sm_config_set_out_shift(&c, true, true, 32);
    sm_config_set_fifo_join(&c, PIO_FIFO_JOIN_TX);
    sm_config_set_clkdiv(&c, clk_div);
    pio_sm_init(pio, SM_DATA, data_offset, &c);

    c = hub75_row_program_get_default_config(row_offset);
    sm_config_set_out_pins(&c, PIN_ADDR, 5);
    sm_config_set_sideset_pins(&c, PIN_LAT);
    sm_config_set_out_shift(&c, true, true, 32);
    sm_config_set_clkdiv(&c, ROW_CLKDIV);
    pio_sm_init(pio, SM_ROW, row_offset, &c);

    pio_sm_set_enabled(pio, SM_DATA, true);
    pio_sm_set_enabled(pio, SM_ROW, true);
}

void hub75_init(uint16_t chain_w, uint16_t rows, uint8_t clk_div, const uint8_t *blank) {
    for (uint p = PIN_R0; p <= PIN_OE; p++) pio_gpio_init(pio, p);
    // OE zuerst auf high (aus), dann alle Pins als Ausgang
    pio_sm_set_pins_with_mask(pio, SM_ROW, 1u << PIN_OE, 1u << PIN_OE);
    pio_sm_set_consecutive_pindirs(pio, SM_DATA, PIN_R0, 6, true);
    pio_sm_set_consecutive_pindirs(pio, SM_DATA, PIN_CLK, 1, true);
    pio_sm_set_consecutive_pindirs(pio, SM_ROW, PIN_ADDR, 5, true);
    pio_sm_set_consecutive_pindirs(pio, SM_ROW, PIN_LAT, 2, true);
    data_offset = pio_add_program(pio, &hub75_data_program);
    row_offset = pio_add_program(pio, &hub75_row_program);
    g_chain_w = chain_w;
    g_rows = rows;
    front = blank;
    setup_sms(clk_div);
    multicore_launch_core1(core1_main);
}

void hub75_set_geometry(uint16_t chain_w, uint16_t rows, uint8_t clk_div, const uint8_t *blank) {
    pause_req = true;
    while (!paused) tight_loop_contents();
    g_chain_w = chain_w;
    g_rows = rows;
    front = blank;
    swap_req = false;
    setup_sms(clk_div);
    pause_req = false;
}

// Pin-Test: Bildausgabe anhalten und die HUB75-Pins von Hand setzen (zum Nachmessen)
static bool manual;

void hub75_manual(bool on) {
    if (on == manual) return;
    if (on) {
        pause_req = true;
        while (!paused) tight_loop_contents();
        for (uint p = PIN_R0; p <= PIN_OE; p++) {
            gpio_init(p);
            gpio_set_dir(p, GPIO_OUT);
            gpio_put(p, p == PIN_OE); // OE aus, alles andere low
        }
    } else {
        for (uint p = PIN_R0; p <= PIN_OE; p++) pio_gpio_init(pio, p);
        pause_req = false;
    }
    manual = on;
}

bool hub75_manual_set(unsigned pin, bool value) {
    if (!manual || pin < PIN_R0 || pin > PIN_OE) return false;
    gpio_put(pin, value);
    return true;
}

// Handtest ohne PIO: eine Farbe langsam (µs-Takt) in die ganze Kette schieben, latchen und
// Zeile 0 einschalten. Zeigt sich eine farbige Linie, sind CLK/LAT/Farbleitungen in Ordnung.
void hub75_manual_shift(bool r, bool g, bool b, unsigned row) {
    hub75_manual(true);
    gpio_put(PIN_OE, 1);
    const uint32_t c3 = (r ? 1u : 0u) | (g ? 2u : 0u) | (b ? 4u : 0u);
    const uint32_t col = c3 | (c3 << 3); // obere und untere Hälfte
    for (uint i = 0; i < 1024; i++) {     // mehr als jede Kette lang ist
        for (uint k = 0; k < 6; k++) gpio_put(PIN_R0 + k, (col >> k) & 1u);
        busy_wait_us(1);
        gpio_put(PIN_CLK, 1);
        busy_wait_us(1);
        gpio_put(PIN_CLK, 0);
    }
    busy_wait_us(2);
    gpio_put(PIN_LAT, 1);
    busy_wait_us(5);
    gpio_put(PIN_LAT, 0);
    for (uint k = 0; k < 5; k++) gpio_put(PIN_ADDR + k, (row >> k) & 1u);
    busy_wait_us(2);
    gpio_put(PIN_OE, 0);
}

// Selbstdiagnose: zählt für GP2..GP15 die Pegelwechsel am Pad (gelesen über SIO-Eingang, also
// das, was wirklich am Pin anliegt) und meldet Funktion und Ausgangstreiber je Pin.
void hub75_signals(uint32_t counts[14], uint32_t *pio_mask, uint32_t *oe_mask, uint32_t *high_mask, uint32_t ms) {
    for (int i = 0; i < 14; i++) counts[i] = 0;
    uint32_t last = sio_hw->gpio_in, highs = 0;
    const absolute_time_t until = make_timeout_time_ms(ms);
    while (!time_reached(until)) {
        for (int k = 0; k < 256; k++) {
            const uint32_t now = sio_hw->gpio_in;
            uint32_t ch = (now ^ last) & 0xFFFCu;
            highs |= now;
            last = now;
            while (ch) {
                const int p = __builtin_ctz(ch);
                counts[p - 2]++;
                ch &= ch - 1;
            }
        }
    }
    uint32_t pm = 0, om = 0;
    for (uint p = PIN_R0; p <= PIN_OE; p++) {
        if ((io_bank0_hw->io[p].ctrl & IO_BANK0_GPIO0_CTRL_FUNCSEL_BITS) == GPIO_FUNC_PIO0) pm |= 1u << p;
        if (io_bank0_hw->io[p].status & IO_BANK0_GPIO0_STATUS_OETOPAD_BITS) om |= 1u << p;
    }
    *pio_mask = pm;
    *oe_mask = om;
    *high_mask = highs & 0xFFFCu;
}

void hub75_show(const uint8_t *buf) {
    pending = buf;
    swap_req = true;
}

// Während des Pin-Tests steht Core 1: nicht auf den Bildwechsel warten (sonst hinge Core 0)
bool hub75_swap_pending(void) { return swap_req && !manual; }

uint32_t hub75_refresh_count(void) { return refreshes; }
