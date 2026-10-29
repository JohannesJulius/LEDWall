// Die eingebaute WS2812 des RP2040 Zero (GP16) zeigt den Zustand an.
#include "status_led.h"

#include "hardware/clocks.h"
#include "hardware/pio.h"
#include "ws2812.pio.h"

#define PIN_STATUS 16
static PIO const pio = pio1;
static const uint sm = 0;

void status_led_init(void) {
    uint offset = pio_add_program(pio, &ws2812_program);
    pio_gpio_init(pio, PIN_STATUS);
    pio_sm_set_consecutive_pindirs(pio, sm, PIN_STATUS, 1, true);
    pio_sm_config c = ws2812_program_get_default_config(offset);
    sm_config_set_sideset_pins(&c, PIN_STATUS);
    sm_config_set_out_shift(&c, false, true, 24);
    sm_config_set_fifo_join(&c, PIO_FIFO_JOIN_TX);
    sm_config_set_clkdiv(&c, clock_get_hz(clk_sys) / (800000.0f * 10));
    pio_sm_init(pio, sm, offset, &c);
    pio_sm_set_enabled(pio, sm, true);
}

void status_led_set(uint8_t r, uint8_t g, uint8_t b) {
    // gedimmt, die LED ist sehr hell; Reihenfolge GRB
    r >>= 3; g >>= 3; b >>= 3;
    if (!pio_sm_is_tx_fifo_full(pio, sm)) pio_sm_put(pio, sm, ((uint32_t)g << 24) | ((uint32_t)r << 16) | ((uint32_t)b << 8));
}
