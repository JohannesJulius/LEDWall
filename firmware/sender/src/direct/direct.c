#include "direct.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "config.h"
#include "display.h"
#include "hardware/flash.h"
#include "hub75d.h"
#include "lwip/pbuf.h"
#include "lwip/udp.h"
#include "pico/flash.h"
#include "pico/stdlib.h"
#include "protocol.h"

#define PANEL_OFFSET (PICO_FLASH_SIZE_BYTES - 2 * FLASH_SECTOR_SIZE)
#define DCFG_MAGIC 0x4C574443u // "LWDC"
#define PREVIEW_PORT 4210

typedef struct {
    uint32_t magic;
    uint8_t pinmap;
    uint8_t pad[3];
    config_t panel;
    uint32_t crc;
} dcfg_t;

static dcfg_t dc;
static display_t disp;
static uint8_t bufs[2][DISPLAY_BUF_MAX] __attribute__((aligned(4)));
static uint8_t canvas[CFG_MAX_PIXELS * 3];
static int back = 1;
static uint8_t master = 255;
static int test_mode;
static absolute_time_t ident_until;
static bool ident_on;
static uint64_t preview_until;
static uint32_t frames;
static uint8_t buttons[2];

static uint32_t dcfg_crc(const dcfg_t *d) {
    const uint8_t *p = (const uint8_t *)d;
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < offsetof(dcfg_t, crc); i++) h = (h ^ p[i]) * 16777619u;
    return h;
}

static const dcfg_t *flash_dcfg(void) { return (const dcfg_t *)(XIP_BASE + PANEL_OFFSET); }

static void apply_lut(void) {
    display_set_lut(&disp, (uint8_t)((unsigned)dc.panel.brightness * master / 255), dc.panel.gamma_x10);
}

static uint8_t *draw_buffer(void) {
    while (hub75d_swap_pending()) tight_loop_contents();
    return bufs[back];
}

static void present(void) {
    hub75d_show(bufs[back]);
    back ^= 1;
}

static void show_canvas(void) {
    display_convert(&disp, canvas, FMT_RGB888, draw_buffer());
    present();
}

static void apply_geometry(bool first) {
    const pinmap_t *pm = hub75d_pinmap(dc.pinmap);
    display_set_bitpos(&disp, pm->bit_upper, pm->bit_lower);
    display_setup(&disp, &dc.panel);
    apply_lut();
    memset(bufs[0], 0, sizeof bufs[0]);
    if (first) hub75d_init(dc.pinmap, disp.chain_w, disp.rows, dc.panel.clk_div, bufs[0]);
    else hub75d_set_geometry(disp.chain_w, disp.rows, dc.panel.clk_div, bufs[0]);
    back = 1;
}

static void redraw_overlay(void) {
    if (ident_on) draw_ident(&dc.panel, canvas);
    else if (test_mode) draw_test(&dc.panel, test_mode, canvas);
    else return;
    show_canvas();
}

void direct_init(void) {
    const dcfg_t *f = flash_dcfg();
    if (f->magic == DCFG_MAGIC && f->crc == dcfg_crc(f) && config_valid(&f->panel, NULL) && f->pinmap <= 1) {
        dc = *f;
    } else {
        memset(&dc, 0, sizeof dc);
        dc.magic = DCFG_MAGIC;
        dc.pinmap = PINMAP_SEENGREAT_V38;
        config_defaults(&dc.panel);
        strcpy(dc.panel.name, "Direkt");
    }
    const pinmap_t *pm = hub75d_pinmap(dc.pinmap);
    buttons[0] = pm->btn_tap;
    buttons[1] = pm->btn_next;
    apply_geometry(true);
    // Adresse zeigen, bis das erste Bild kommt
    direct_ident(4);
}

uint16_t direct_width(void) { return dc.panel.width; }
uint16_t direct_height(void) { return dc.panel.height; }
const uint8_t *direct_buttons(void) { return buttons; }
uint32_t direct_frames(void) { return frames; }

void direct_poll(uint64_t now) {
    if (ident_on && time_reached(ident_until)) {
        ident_on = false;
        if (test_mode) redraw_overlay();
    }
}

bool direct_busy(uint64_t now) { return ident_on || test_mode || now < preview_until; }

void direct_show(const uint8_t *pixels, int fmt) {
    display_convert(&disp, pixels, fmt, draw_buffer());
    present();
    frames++;
}

void direct_blackout(void) {
    memset(canvas, 0, (size_t)dc.panel.width * dc.panel.height * 3);
    show_canvas();
}

void direct_ident(uint8_t secs) {
    ident_on = true;
    ident_until = make_timeout_time_ms(secs * 1000u);
    redraw_overlay();
}

void direct_brightness(uint8_t m) {
    master = m;
    apply_lut();
    redraw_overlay();
}

static void flash_job(void *p) {
    flash_range_erase(PANEL_OFFSET, FLASH_SECTOR_SIZE);
    flash_range_program(PANEL_OFFSET, p, FLASH_PAGE_SIZE * ((sizeof(dcfg_t) + FLASH_PAGE_SIZE - 1) / FLASH_PAGE_SIZE));
}

bool direct_save(void) {
    static uint8_t page[FLASH_PAGE_SIZE * ((sizeof(dcfg_t) + FLASH_PAGE_SIZE - 1) / FLASH_PAGE_SIZE)];
    dc.panel.crc = config_checksum(&dc.panel);
    dc.crc = dcfg_crc(&dc);
    memset(page, 0xFF, sizeof page);
    memcpy(page, &dc, sizeof dc);
    return flash_safe_execute(flash_job, page, 1000) == PICO_OK && !memcmp(flash_dcfg(), &dc, sizeof dc);
}

bool direct_command(const char *cmd, const char *arg, char *reply, size_t cap) {
    const char *why = NULL;
    if (!strcmp(cmd, "SET")) {
        config_t old = dc.panel;
        if (!config_apply(&dc.panel, arg, &why)) { snprintf(reply, cap, "ERR %s", why); return true; }
        if (memcmp(&old, &dc.panel, sizeof old)) {
            if (old.brightness != dc.panel.brightness || old.gamma_x10 != dc.panel.gamma_x10) apply_lut();
            apply_geometry(false);
        }
        redraw_overlay();
        snprintf(reply, cap, "OK");
    } else if (!strcmp(cmd, "TEST")) {
        int m = atoi(arg);
        test_mode = m > 0 && m < TEST_COUNT ? m : 0;
        if (!test_mode) direct_blackout();
        redraw_overlay();
        snprintf(reply, cap, "OK");
    } else if (!strcmp(cmd, "PINMAP")) {
        int m = atoi(arg);
        if (m < 0 || m > 1) { snprintf(reply, cap, "ERR 0 = Standard, 1 = Seengreat bis V3.8"); return true; }
        dc.pinmap = (uint8_t)m;
        snprintf(reply, cap, direct_save() ? "OK Neustart nötig" : "ERR Flash");
    } else if (!strcmp(cmd, "DEFAULTS")) {
        config_defaults(&dc.panel);
        apply_geometry(false);
        redraw_overlay();
        snprintf(reply, cap, "OK");
    } else {
        return false;
    }
    return true;
}

int direct_json(char *out, size_t cap) {
    char cfg[700];
    config_json(&dc.panel, cfg, sizeof cfg);
    return snprintf(out, cap, ",\"direct\":{\"pinmap\":%u,\"pinmapName\":\"%s\",\"test\":%d,\"preview\":%s,\"refresh\":%lu,%s,\"saved\":%s}",
                    dc.pinmap, hub75d_pinmap(dc.pinmap)->name, test_mode,
                    time_us_64() < preview_until ? "true" : "false", (unsigned long)hub75d_refresh_count(), cfg,
                    (flash_dcfg()->magic == DCFG_MAGIC && !memcmp(&flash_dcfg()->panel, &dc.panel, offsetof(config_t, crc)) &&
                     flash_dcfg()->pinmap == dc.pinmap) ? "true" : "false");
}

// ---------------------------------------------------------------- Live-Vorschau per UDP
// Die App schickt das Bild in Zeilenblöcken (FRAME_PART) und danach SHOW.

static void handle_packet(uint8_t type, const uint8_t *pl, uint16_t len) {
    const uint32_t W = dc.panel.width, H = dc.panel.height;
    switch (type) {
    case LW_FRAME_PART: {
        if (len < 6) return;
        const uint8_t fmt = pl[1];
        const uint32_t y0 = pl[2] | (pl[3] << 8), rows = pl[4] | (pl[5] << 8);
        const uint32_t bpp = fmt == 1 ? 2 : 3;
        if (y0 + rows > H || len != 6 + rows * W * bpp) return;
        const uint8_t *src = pl + 6;
        uint8_t *dst = canvas + y0 * W * 3;
        for (uint32_t i = 0; i < rows * W; i++, dst += 3) {
            if (bpp == 3) { dst[0] = src[0]; dst[1] = src[1]; dst[2] = src[2]; src += 3; }
            else {
                const uint16_t v = (uint16_t)(src[0] | (src[1] << 8));
                dst[0] = (uint8_t)(((v >> 11) & 0x1F) * 255 / 31);
                dst[1] = (uint8_t)(((v >> 5) & 0x3F) * 255 / 63);
                dst[2] = (uint8_t)((v & 0x1F) * 255 / 31);
                src += 2;
            }
        }
        preview_until = time_us_64() + 1500000;
        break;
    }
    case LW_SHOW:
        if (time_us_64() < preview_until && !test_mode && !ident_on) { show_canvas(); frames++; }
        break;
    case LW_TEST:
        if (len) { char a[4]; snprintf(a, sizeof a, "%u", pl[0]); char r[8]; direct_command("TEST", a, r, sizeof r); }
        break;
    case LW_IDENT:
        direct_ident(len ? pl[0] : 5);
        break;
    }
}

static void on_udp(void *arg, struct udp_pcb *pcb, struct pbuf *p, const ip_addr_t *addr, u16_t port) {
    static uint8_t buf[1600];
    const uint16_t n = pbuf_copy_partial(p, buf, sizeof buf, 0);
    pbuf_free(p);
    if (n < 8 || buf[0] != LW_SYNC0 || buf[1] != LW_SYNC1) return;
    const uint16_t len = (uint16_t)(buf[4] | (buf[5] << 8));
    if (8u + len != n) return;
    const uint16_t crc = (uint16_t)(buf[6 + len] | (buf[7 + len] << 8));
    if (lw_crc16(0xFFFF, buf + 2, 4u + len) != crc) return;
    handle_packet(buf[3], buf + 6, len);
}

void direct_udp_init(void) {
    struct udp_pcb *pcb = udp_new_ip_type(IPADDR_TYPE_ANY);
    if (!pcb || udp_bind(pcb, IP_ANY_TYPE, PREVIEW_PORT) != ERR_OK) return;
    udp_recv(pcb, on_udp, NULL);
}
