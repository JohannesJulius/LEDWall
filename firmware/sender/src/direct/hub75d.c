#include "hub75d.h"

#include "config.h"
#include "hardware/gpio.h"
#include "hardware/pio.h"
#include "hub75d.pio.h"
#include "pico/multicore.h"

#define BP DISPLAY_BITPLANES
#define PULSE_BASE 12

static const pinmap_t PINMAPS[2] = {
    // Standard-Belegung, Seengreat ab V3.9, gleiche Pins wie beim RP2040-Zero-Empfänger
    {"Standard / Seengreat ab V3.9", 2, 6, 13, 14, {8, 9, 10, 11, 12}, {0, 1, 2}, {3, 4, 5}, 26, 27},
    // Seengreat RGB Matrix Adapter Board bis V3.8
    {"Seengreat bis V3.8", 2, 8, 11, 12, {10, 16, 18, 20, 22}, {0, 1, 2}, {3, 6, 7}, 15, 14},
};

static PIO const pio = pio0;
static int sm_data = -1, sm_pulse = -1;
static uint data_offset, pulse_offset;
static const pinmap_t *pm;
static uint32_t addr_mask, addr_bits[32];
static volatile const uint8_t *front, *pending;
static volatile bool swap_req, pause_req, paused;
static volatile uint32_t refreshes;
static uint16_t g_chain_w, g_rows;

const pinmap_t *hub75d_pinmap(int id) { return &PINMAPS[id == PINMAP_STANDARD ? 0 : 1]; }

static inline void wait_tx_stall(uint sm) {
    const uint32_t mask = 1u << (PIO_FDEBUG_TXSTALL_LSB + sm);
    pio->fdebug = mask;
    while (!(pio->fdebug & mask)) tight_loop_contents();
}

static void __not_in_flash_func(core1_main)(void) {
    multicore_lockout_victim_init();
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
                for (uint i = 0; i < w4; i++) pio_sm_put_blocking(pio, sm_data, src[i]);
                wait_tx_stall(sm_data);
                wait_tx_stall(sm_pulse);               // vorheriger OE-Puls ist vorbei, OE ist aus
                if (b == 0) gpio_put_masked(addr_mask, addr_bits[r]);
                pio_sm_put_blocking(pio, sm_pulse, (PULSE_BASE << b) - 1);
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
    pio_sm_set_enabled(pio, sm_data, false);
    pio_sm_set_enabled(pio, sm_pulse, false);
    pio_sm_config c = pm->data_count == 8 ? hub75d_data8_program_get_default_config(data_offset)
                                          : hub75d_data6_program_get_default_config(data_offset);
    sm_config_set_out_pins(&c, pm->data_base, pm->data_count);
    sm_config_set_sideset_pins(&c, pm->clk);
    sm_config_set_out_shift(&c, true, true, 32);
    sm_config_set_fifo_join(&c, PIO_FIFO_JOIN_TX);
    sm_config_set_clkdiv(&c, clk_div);
    pio_sm_init(pio, sm_data, data_offset, &c);

    c = hub75d_pulse_program_get_default_config(pulse_offset);
    sm_config_set_sideset_pins(&c, pm->lat);
    sm_config_set_out_shift(&c, true, false, 32);
    pio_sm_init(pio, sm_pulse, pulse_offset, &c);

    pio_sm_set_enabled(pio, sm_data, true);
    pio_sm_set_enabled(pio, sm_pulse, true);
}

void hub75d_init(int pinmap, uint16_t chain_w, uint16_t rows, uint8_t clk_div, const uint8_t *blank) {
    pm = hub75d_pinmap(pinmap);
    // SMs fest belegen, damit der WLAN-Treiber (ebenfalls PIO) andere nimmt
    sm_data = pio_claim_unused_sm(pio, true);
    sm_pulse = pio_claim_unused_sm(pio, true);
    for (uint i = 0; i < pm->data_count; i++) pio_gpio_init(pio, pm->data_base + i);
    pio_gpio_init(pio, pm->clk);
    pio_gpio_init(pio, pm->lat);
    pio_gpio_init(pio, pm->lat + 1);
    pio_sm_set_pins_with_mask(pio, sm_pulse, 1u << (pm->lat + 1), 1u << (pm->lat + 1)); // OE aus
    pio_sm_set_consecutive_pindirs(pio, sm_data, pm->data_base, pm->data_count, true);
    pio_sm_set_consecutive_pindirs(pio, sm_data, pm->clk, 1, true);
    pio_sm_set_consecutive_pindirs(pio, sm_pulse, pm->lat, 2, true);
    addr_mask = 0;
    for (int k = 0; k < 5; k++) {
        gpio_init(pm->addr[k]);
        gpio_set_dir(pm->addr[k], GPIO_OUT);
        addr_mask |= 1u << pm->addr[k];
    }
    for (uint r = 0; r < 32; r++) {
        addr_bits[r] = 0;
        for (int k = 0; k < 5; k++) if (r & (1u << k)) addr_bits[r] |= 1u << pm->addr[k];
    }
    data_offset = pio_add_program(pio, pm->data_count == 8 ? &hub75d_data8_program : &hub75d_data6_program);
    pulse_offset = pio_add_program(pio, &hub75d_pulse_program);
    g_chain_w = chain_w;
    g_rows = rows;
    front = blank;
    setup_sms(clk_div);
    multicore_launch_core1(core1_main);
}

void hub75d_set_geometry(uint16_t chain_w, uint16_t rows, uint8_t clk_div, const uint8_t *blank) {
    pause_req = true;
    while (!paused) tight_loop_contents();
    g_chain_w = chain_w;
    g_rows = rows;
    front = blank;
    swap_req = false;
    setup_sms(clk_div);
    pause_req = false;
}

void hub75d_show(const uint8_t *buf) {
    pending = buf;
    swap_req = true;
}

bool hub75d_swap_pending(void) { return swap_req; }
uint32_t hub75d_refresh_count(void) { return refreshes; }
