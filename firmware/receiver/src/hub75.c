#include "hub75.h"

#include "config.h"
#include "hardware/clocks.h"
#include "hardware/pio.h"
#include "hub75.pio.h"
#include "pico/multicore.h"

#define BP DISPLAY_BITPLANES
#define SM_DATA 0
#define SM_ROW 1
#define PULSE_BASE 12 // Takte für die niedrigste Bitebene

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

void hub75_show(const uint8_t *buf) {
    pending = buf;
    swap_req = true;
}

bool hub75_swap_pending(void) { return swap_req; }

uint32_t hub75_refresh_count(void) { return refreshes; }
