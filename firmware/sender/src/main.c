// LEDWall-Sender für den Pico 2W
//
// Hält die Pattern-Bank im Flash, bestimmt aus der BPM die Beat-Position und schickt jeder
// Wand ihr Bild über UART. Danach "SHOW" an alle: alle Wände schalten gleichzeitig um.
// Gesteuert wird per WLAN (Weboberfläche), über USB von der App und per Taster.
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bank.h"
#include "dhcpserver.h"
#include "hardware/flash.h"
#include "hardware/gpio.h"
#include "hardware/watchdog.h"
#include "lwip/apps/mdns.h"
#include "lwip/ip4_addr.h"
#include "lwip/netif.h"
#include "output.h"
#include "pico/bootrom.h"
#include "pico/cyw43_arch.h"
#include "pico/flash.h"
#include "pico/stdlib.h"
#include "pico/unique_id.h"
#include "player.h"
#include "protocol.h"
#include "sender.h"
#include "settings.h"
#include "web.h"

#ifndef FW_VERSION
#define FW_VERSION "0.0.0-dev"
#endif

#define BANK_OFFSET (1024u * 1024u)
#define SETTINGS_OFFSET (PICO_FLASH_SIZE_BYTES - FLASH_SECTOR_SIZE)
#define BANK_MAX (SETTINGS_OFFSET - BANK_OFFSET)
#define PIN_TAP 15   // Taster gegen GND: tippen = Tempo, halten = Sync
#define PIN_NEXT 14  // Taster gegen GND: nächstes Pattern (am Taktanfang)
#define MAX_WALL_BYTES (128 * 64 * 3)

static settings_t set;
static bank_t bank;
static bool bank_ok;
static const char *bank_err = "keine Bank";
static player_t pl;
static bool blackout, bright_dirty = true, blackout_dirty, ident_req;
static uint8_t ident_secs = 5;

// ---------------------------------------------------------------- Senden

enum { C_IDLE, C_FRAMES, C_SHOW, C_CTRL };
static int cyc = C_IDLE;
static uint8_t hdr[BANK_MAX_WALLS + OUT_CHANNELS][7];
static uint8_t crcb[BANK_MAX_WALLS + OUT_CHANNELS][2];
static uint8_t wallbuf[BANK_MAX_WALLS][MAX_WALL_BYTES];
static uint8_t ctrl[OUT_CHANNELS][12];
static uint64_t cycle_start, last_send;
static uint32_t cycle_us = 20000, frames_sent;
static float fps;
static int last_pattern = -1;
static uint32_t last_frame = 0xFFFFFFFF;

static uint16_t packet_header(uint8_t *h, uint8_t addr, uint8_t type, uint16_t len, uint8_t flags) {
    h[0] = LW_SYNC0; h[1] = LW_SYNC1; h[2] = addr; h[3] = type;
    h[4] = (uint8_t)(len & 0xFF); h[5] = (uint8_t)(len >> 8); h[6] = flags;
    return lw_crc16(0xFFFF, h + 2, len ? 5 : 4);
}

static void put_crc(uint8_t *c, uint16_t crc) { c[0] = (uint8_t)(crc & 0xFF); c[1] = (uint8_t)(crc >> 8); }

static unsigned used_channels(void) {
    if (!bank_ok || !bank.wall_count) return (1u << OUT_CHANNELS) - 1;
    unsigned m = 0;
    for (int i = 0; i < bank.wall_count; i++) m |= 1u << bank.walls[i].channel;
    return m;
}

// kleines Steuerpaket (ohne Bilddaten) an alle Wände auf allen Ausgängen
static void queue_ctrl(uint8_t type, const uint8_t *payload, uint8_t len) {
    for (int c = 0; c < OUT_CHANNELS; c++) {
        uint8_t *p = ctrl[c];
        p[0] = LW_SYNC0; p[1] = LW_SYNC1; p[2] = LW_ADDR_ALL; p[3] = type; p[4] = len; p[5] = 0;
        memcpy(p + 6, payload, len);
        put_crc(p + 6 + len, lw_crc16(0xFFFF, p + 2, 4u + len));
        out_queue(c, p, 8u + len);
    }
}

static void send_frame(uint64_t now) {
    const double beat = player_beat(&pl, now + (pl.playing ? cycle_us : 0)); // Sendezeit vorwegnehmen
    const uint32_t fi = bank_frame_index(&bank, pl.pattern, beat);
    if (fi == last_frame && pl.pattern == last_pattern && now - last_send < 500000) return;
    const uint8_t *frame = bank_frame(&bank, pl.pattern, fi);
    const uint8_t type = bank.bpp == 3 ? LW_FRAME_RGB888 : LW_FRAME_RGB565;
    int k = 0;
    if (bank.broadcast) {
        const uint32_t n = bank_frame_bytes(&bank);
        const unsigned chans = used_channels();
        uint16_t crc = 0;
        for (int c = 0; c < OUT_CHANNELS; c++) {
            if (!(chans & (1u << c))) continue;
            uint16_t h = packet_header(hdr[k], LW_ADDR_ALL, type, (uint16_t)(n + 1), 0);
            if (k == 0) crc = lw_crc16(h, frame, n);
            put_crc(crcb[k], crc);
            out_queue(c, hdr[k], 7);
            out_queue(c, frame, n);
            out_queue(c, crcb[k], 2);
            k++;
        }
    } else {
        for (int i = 0; i < bank.wall_count; i++) {
            const bank_wall_t *w = &bank.walls[i];
            const uint32_t n = (uint32_t)w->width * w->height * bank.bpp;
            bank_sample_wall(&bank, frame, w, wallbuf[i]);
            uint16_t h = packet_header(hdr[k], w->address, type, (uint16_t)(n + 1), 0);
            put_crc(crcb[k], lw_crc16(h, wallbuf[i], n));
            out_queue(w->channel, hdr[k], 7);
            out_queue(w->channel, wallbuf[i], n);
            out_queue(w->channel, crcb[k], 2);
            k++;
        }
    }
    last_frame = fi;
    last_pattern = pl.pattern;
    last_send = now;
    cycle_start = now;
    cyc = C_FRAMES;
}

static void engine_poll(uint64_t now) {
    out_poll();
    if (cyc != C_IDLE && !out_idle()) return;
    if (cyc == C_FRAMES) {
        // alle Bilder sind draußen -> alle Wände gleichzeitig umschalten
        queue_ctrl(LW_SHOW, NULL, 0);
        cyc = C_SHOW;
        return;
    }
    if (cyc == C_SHOW) {
        cycle_us = (uint32_t)(now - cycle_start);
        frames_sent++;
        fps = fps * 0.9f + 0.1f * (1e6f / (float)(cycle_us ? cycle_us : 1));
    }
    cyc = C_IDLE;

    if (bright_dirty) {
        bright_dirty = false;
        queue_ctrl(LW_BRIGHTNESS, &set.brightness, 1);
        cyc = C_CTRL;
        return;
    }
    if (ident_req) {
        ident_req = false;
        queue_ctrl(LW_IDENT, &ident_secs, 1);
        cyc = C_CTRL;
        return;
    }
    if (blackout_dirty) {
        blackout_dirty = false;
        if (blackout) { queue_ctrl(LW_BLACKOUT, NULL, 0); cyc = C_CTRL; return; }
        last_frame = 0xFFFFFFFF; // nach dem Blackout sofort wieder senden
    }
    if (!bank_ok || blackout) return;
    if (player_update(&pl, now, bank.count)) last_frame = 0xFFFFFFFF;
    send_frame(now);
}

// ---------------------------------------------------------------- Flash

static const uint8_t *flash_ptr(uint32_t off) { return (const uint8_t *)(XIP_BASE + off); }

typedef struct { uint32_t off; const uint8_t *data; uint32_t len; } flash_job_t;

static void flash_job(void *p) {
    const flash_job_t *j = p;
    flash_range_erase(j->off, FLASH_SECTOR_SIZE);
    if (j->data) flash_range_program(j->off, j->data, j->len);
}

static bool flash_write_sector(uint32_t off, const uint8_t *data, uint32_t len) {
    // Die DMA liest Bilder direkt aus dem Flash: erst fertig senden lassen, dann schreiben
    while (!out_idle()) out_poll();
    flash_job_t j = {off, data, len};
    return flash_safe_execute(flash_job, &j, 1000) == PICO_OK;
}

static void load_bank(void) {
    const uint8_t *d = flash_ptr(BANK_OFFSET);
    // Gesamtgröße steht im Kopf (Byte 24..27, siehe docs/lwb-format.md)
    const uint32_t size = (uint32_t)d[24] | ((uint32_t)d[25] << 8) | ((uint32_t)d[26] << 16) | ((uint32_t)d[27] << 24);
    bank_err = bank_open(&bank, d, size > BANK_MAX ? 0 : size);
    bank_ok = bank_err == NULL;
    if (bank_ok && pl.pattern >= bank.count) pl.pattern = 0;
    last_frame = 0xFFFFFFFF;
}

static bool save_settings(void) {
    static uint8_t page[FLASH_PAGE_SIZE * ((sizeof(settings_t) + FLASH_PAGE_SIZE - 1) / FLASH_PAGE_SIZE)];
    set.crc = settings_checksum(&set);
    memset(page, 0xFF, sizeof page);
    memcpy(page, &set, sizeof set);
    return flash_write_sector(SETTINGS_OFFSET, page, sizeof page);
}

// ---------------------------------------------------------------- Upload der Bank (USB)

static struct {
    bool active;
    uint32_t size, crc, got, fill;
    uint64_t last;
    uint8_t buf[FLASH_SECTOR_SIZE];
} up;

static void upload_flush(void) {
    const uint32_t sector = (up.got - 1) / FLASH_SECTOR_SIZE;
    memset(up.buf + up.fill, 0xFF, FLASH_SECTOR_SIZE - up.fill);
    flash_write_sector(BANK_OFFSET + sector * FLASH_SECTOR_SIZE, up.buf, FLASH_SECTOR_SIZE);
    up.fill = 0;
}

static void upload_byte(uint8_t b) {
    up.buf[up.fill++] = b;
    up.got++;
    if (up.fill == FLASH_SECTOR_SIZE || up.got == up.size) {
        upload_flush();
        printf("ACK %lu\n", (unsigned long)up.got);
    }
    if (up.got == up.size) {
        up.active = false;
        const uint32_t crc = crc32_update(0, flash_ptr(BANK_OFFSET), up.size);
        load_bank();
        if (crc != up.crc) printf("ERR Prüfsumme\n");
        else if (!bank_ok) printf("ERR %s\n", bank_err);
        else printf("OK\n");
    }
}

// ---------------------------------------------------------------- WLAN

static dhcp_server_t dhcp;
static bool wifi_ok, sta_connecting, ap_active, mdns_on;
static uint64_t sta_deadline;
static char ip_str[16] = "";

static void start_mdns(struct netif *n) {
    if (mdns_on) return;
    mdns_resp_init();
    mdns_resp_add_netif(n, "ledwall");
    mdns_resp_add_service(n, "LEDWall", "_http", DNSSD_PROTO_TCP, 80, NULL, NULL);
    mdns_on = true;
}

static void start_ap(void) {
    cyw43_arch_enable_ap_mode(set.ap_ssid, set.ap_pass, CYW43_AUTH_WPA2_AES_PSK);
    ip_addr_t gw, mask;
    IP4_ADDR(ip_2_ip4(&gw), 192, 168, 4, 1);
    IP4_ADDR(ip_2_ip4(&mask), 255, 255, 255, 0);
    dhcp_server_init(&dhcp, &gw, &mask);
    ap_active = true;
    strcpy(ip_str, "192.168.4.1");
    start_mdns(&cyw43_state.netif[CYW43_ITF_AP]);
}

static void wifi_start(void) {
    if (cyw43_arch_init()) { wifi_ok = false; return; }
    wifi_ok = true;
    if (set.wifi_mode == 1 && set.sta_ssid[0]) {
        cyw43_arch_enable_sta_mode();
        cyw43_arch_wifi_connect_async(set.sta_ssid, set.sta_pass[0] ? set.sta_pass : NULL,
                                      set.sta_pass[0] ? CYW43_AUTH_WPA2_AES_PSK : CYW43_AUTH_OPEN);
        sta_connecting = true;
        sta_deadline = time_us_64() + 20000000;
    } else {
        start_ap();
    }
}

static void wifi_poll(uint64_t now) {
    if (!wifi_ok) return;
    cyw43_arch_poll();
    if (!sta_connecting) return;
    int st = cyw43_tcpip_link_status(&cyw43_state, CYW43_ITF_STA);
    if (st == CYW43_LINK_UP) {
        sta_connecting = false;
        struct netif *n = &cyw43_state.netif[CYW43_ITF_STA];
        ip4addr_ntoa_r(netif_ip4_addr(n), ip_str, sizeof ip_str);
        start_mdns(n);
    } else if (st < 0 || now > sta_deadline) {
        // WLAN nicht erreichbar -> eigenes Netz aufmachen
        sta_connecting = false;
        cyw43_arch_disable_sta_mode();
        start_ap();
    }
}

static const char *wifi_state(void) {
    if (!wifi_ok) return "aus";
    if (sta_connecting) return "verbinde";
    return ap_active ? "ap" : "sta";
}

// ---------------------------------------------------------------- Befehle

static void json_str(char *out, size_t cap, const char *s) {
    size_t n = 0;
    out[n++] = '"';
    for (; *s && n + 3 < cap; s++) {
        if (*s == '"' || *s == '\\') out[n++] = '\\';
        out[n++] = (*s >= 0 && *s < 0x20) ? ' ' : *s;
    }
    out[n++] = '"';
    out[n] = 0;
}

int sender_state_json(char *out, size_t cap, bool full) {
    const uint64_t now = time_us_64();
    char uid[2 * PICO_UNIQUE_BOARD_ID_SIZE_BYTES + 1], ssid[80], apssid[80], stassid[80], name[48];
    pico_get_unique_board_id_string(uid, sizeof uid);
    json_str(ssid, sizeof ssid, ap_active ? set.ap_ssid : set.sta_ssid);
    json_str(apssid, sizeof apssid, set.ap_ssid);
    json_str(stassid, sizeof stassid, set.sta_ssid);
    json_str(name, sizeof name, bank_ok ? bank.patterns[pl.pattern].name : "");
    int n = snprintf(out, cap,
        "{\"fw\":\"ledwall-tx\",\"ver\":\"%s\",\"uid\":\"%s\",\"board\":\"pico2w\","
        "\"bpm\":%.2f,\"beat\":%.4f,\"playing\":%s,\"pattern\":%d,\"patternName\":%s,\"next\":%d,\"auto\":%d,"
        "\"bright\":%u,\"blackout\":%s,\"fps\":%.1f,\"baud\":%lu,"
        "\"bank\":{\"ok\":%s,\"error\":\"%s\",\"patterns\":%u,\"w\":%u,\"h\":%u,\"refBpm\":%.1f,\"fpb\":%u,"
        "\"walls\":%u,\"mode\":%u,\"size\":%lu,\"max\":%lu},"
        "\"wifi\":{\"state\":\"%s\",\"mode\":%u,\"ssid\":%s,\"ip\":\"%s\",\"apSsid\":%s,\"staSsid\":%s}",
        FW_VERSION, uid, pl.bpm, player_beat(&pl, now), pl.playing ? "true" : "false", pl.pattern, name, pl.next,
        pl.auto_bars, set.brightness, blackout ? "true" : "false", fps, (unsigned long)set.baud,
        bank_ok ? "true" : "false", bank_ok ? "" : bank_err, bank_ok ? bank.count : 0, bank.width, bank.height,
        bank.ref_bpm, bank.fpb, bank.wall_count, bank.mode, (unsigned long)(bank_ok ? bank.size : 0),
        (unsigned long)BANK_MAX, wifi_state(), set.wifi_mode, ssid, ip_str, apssid, stassid);
    if (full && bank_ok && n > 0) {
        n += snprintf(out + n, cap - n, ",\"patterns\":[");
        for (int i = 0; i < bank.count && n > 0 && (size_t)n + 40 < cap; i++) {
            json_str(name, sizeof name, bank.patterns[i].name);
            n += snprintf(out + n, cap - n, "%s{\"name\":%s,\"beats\":%u}", i ? "," : "", name, bank.patterns[i].loop_beats);
        }
        n += snprintf(out + n, cap - n, "]");
    }
    if (n > 0 && (size_t)n + 2 < cap) { out[n++] = '}'; out[n] = 0; }
    return n;
}

static void url_decode(char *dst, const char *src, size_t cap) {
    size_t n = 0;
    while (*src && n + 1 < cap) {
        if (*src == '%' && src[1] && src[2]) {
            char hex[3] = {src[1], src[2], 0};
            dst[n++] = (char)strtol(hex, NULL, 16);
            src += 3;
        } else {
            dst[n++] = *src == '+' ? ' ' : *src;
            src++;
        }
    }
    dst[n] = 0;
}

static bool kv(const char *args, const char *key, char *out, size_t cap) {
    const size_t kl = strlen(key);
    for (const char *p = args; *p;) {
        while (*p == ' ') p++;
        if (!strncmp(p, key, kl) && p[kl] == '=') {
            char raw[160];
            size_t n = 0;
            for (p += kl + 1; *p && *p != ' ' && n + 1 < sizeof raw; p++) raw[n++] = *p;
            raw[n] = 0;
            url_decode(out, raw, cap);
            return true;
        }
        while (*p && *p != ' ') p++;
    }
    return false;
}

const char *sender_command(char *line, bool from_usb, char *reply, size_t cap) {
    const uint64_t now = time_us_64();
    char *arg = strchr(line, ' ');
    if (arg) *arg++ = 0;
    else arg = line + strlen(line);
    const int count = bank_ok ? bank.count : 0;
    snprintf(reply, cap, "OK");

    if (!strcmp(line, "INFO")) {
        strcpy(reply, "INFO ");
        sender_state_json(reply + 5, cap - 5, false);
    } else if (!strcmp(line, "PATTERNS")) {
        strcpy(reply, "STATE ");
        sender_state_json(reply + 6, cap - 6, true);
    } else if (!strcmp(line, "BPM")) {
        double v = atof(arg);
        if (v < 20 || v > 300) snprintf(reply, cap, "ERR BPM 20..300");
        else player_set_bpm(&pl, v, now);
    } else if (!strcmp(line, "TAP")) {
        player_tap(&pl, now);
    } else if (!strcmp(line, "SYNC")) {
        player_sync(&pl, now);
    } else if (!strcmp(line, "NUDGE")) {
        player_nudge(&pl, atof(arg), now);
    } else if (!strcmp(line, "PATTERN")) {
        player_select(&pl, atoi(arg), strstr(arg, "now") != NULL, count);
        if (strstr(arg, "now")) last_frame = 0xFFFFFFFF;
    } else if (!strcmp(line, "NEXT")) {
        player_select(&pl, (pl.next >= 0 ? pl.next : pl.pattern) + 1, false, count);
    } else if (!strcmp(line, "PREV")) {
        player_select(&pl, (pl.next >= 0 ? pl.next : pl.pattern) - 1, false, count);
    } else if (!strcmp(line, "PLAY")) {
        player_set_playing(&pl, true, now);
    } else if (!strcmp(line, "STOP")) {
        player_set_playing(&pl, false, now);
    } else if (!strcmp(line, "AUTO")) {
        pl.auto_bars = atoi(arg) < 0 ? 0 : atoi(arg);
        pl.switch_bar = pl.last_bar;
        set.auto_bars = (int16_t)pl.auto_bars;
    } else if (!strcmp(line, "BRIGHT")) {
        int v = atoi(arg);
        set.brightness = (uint8_t)(v < 0 ? 0 : v > 255 ? 255 : v);
        bright_dirty = true;
    } else if (!strcmp(line, "BLACKOUT")) {
        blackout = atoi(arg) != 0;
        blackout_dirty = true;
    } else if (!strcmp(line, "IDENT")) {
        int s = atoi(arg);
        ident_secs = (uint8_t)(s > 0 && s < 60 ? s : 5);
        ident_req = true;
    } else if (!strcmp(line, "WIFI")) {
        char v[80];
        settings_t t = set;
        bool fits = true;
#define SETF(key, field) if (kv(arg, key, v, sizeof v)) { if (strlen(v) < sizeof(field)) strcpy(field, v); else fits = false; }
        if (kv(arg, "mode", v, sizeof v)) t.wifi_mode = !strcmp(v, "sta") ? 1 : 0;
        SETF("ssid", t.sta_ssid)
        SETF("pass", t.sta_pass)
        SETF("apssid", t.ap_ssid)
        SETF("appass", t.ap_pass)
#undef SETF
        if (!fits) snprintf(reply, cap, "ERR Name oder Passwort zu lang");
        else if (!t.ap_ssid[0] || strlen(t.ap_pass) < 8) snprintf(reply, cap, "ERR Passwort mindestens 8 Zeichen");
        else if (t.wifi_mode == 1 && !t.sta_ssid[0]) snprintf(reply, cap, "ERR WLAN-Name fehlt");
        else { set = t; snprintf(reply, cap, save_settings() ? "OK Neustart nötig" : "ERR Flash"); }
    } else if (!strcmp(line, "BAUD")) {
        uint32_t b = (uint32_t)strtoul(arg, NULL, 10);
        if (b < 9600 || b > 7800000) snprintf(reply, cap, "ERR Baudrate");
        else { set.baud = b; out_set_baud(b); }
    } else if (!strcmp(line, "SAVE")) {
        set.bpm = (float)pl.bpm;
        set.auto_bars = (int16_t)pl.auto_bars;
        snprintf(reply, cap, save_settings() ? "OK" : "ERR Flash");
    } else if (!strcmp(line, "UPLOAD") && from_usb) {
        unsigned long size = 0, crc = 0;
        if (sscanf(arg, "%lu %lu", &size, &crc) != 2 || size < 64 || size > BANK_MAX) {
            snprintf(reply, cap, "ERR Größe (max. %lu Byte)", (unsigned long)BANK_MAX);
        } else {
            bank_ok = false; // Wiedergabe stoppen, der Flash wird überschrieben
            up = (typeof(up)){.active = true, .size = size, .crc = crc, .last = now};
            snprintf(reply, cap, "READY");
        }
    } else if (!strcmp(line, "BOOTSEL") && from_usb) {
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
        snprintf(reply, cap, "ERR unbekannter Befehl");
    } else {
        reply[0] = 0;
    }
    return reply;
}

// ---------------------------------------------------------------- USB

static void usb_poll(uint64_t now) {
    static char line[300];
    static size_t n;
    static char reply[8192];
    char buf[64];
    int got;
    if (up.active && now - up.last > 5000000) {
        up.active = false;
        load_bank();
        printf("ERR Upload abgebrochen (Zeitüberschreitung)\n");
    }
    while ((got = stdio_get_until(buf, sizeof buf, get_absolute_time())) > 0) {
        for (int i = 0; i < got; i++) {
            if (up.active) {
                up.last = now;
                upload_byte((uint8_t)buf[i]);
                continue;
            }
            const char c = buf[i];
            if (c == '\n' || c == '\r') {
                line[n] = 0;
                if (n) {
                    sender_command(line, true, reply, sizeof reply);
                    if (reply[0]) printf("%s\n", reply);
                }
                n = 0;
            } else if (n + 1 < sizeof line) {
                line[n++] = c;
            }
        }
    }
}

// ---------------------------------------------------------------- Taster und LED

static void buttons_poll(uint64_t now) {
    static bool tap_down, next_down, held;
    static uint64_t tap_t, next_t;
    const bool t = !gpio_get(PIN_TAP), nx = !gpio_get(PIN_NEXT);
    if (t && !tap_down && now - tap_t > 30000) { tap_down = true; tap_t = now; held = false; player_tap(&pl, now); }
    if (t && tap_down && !held && now - tap_t > 800000) { held = true; pl.tap_count = 0; player_sync(&pl, now); }
    if (!t && tap_down && now - tap_t > 30000) tap_down = false;
    if (nx && !next_down && now - next_t > 30000) {
        next_down = true; next_t = now;
        player_select(&pl, (pl.next >= 0 ? pl.next : pl.pattern) + 1, false, bank_ok ? bank.count : 0);
    }
    if (!nx && next_down && now - next_t > 30000) next_down = false;
}

static void led_poll(uint64_t now) {
    static int64_t last_beat = -1;
    static uint64_t on_until;
    static bool on;
    if (!wifi_ok) return;
    const int64_t b = (int64_t)floor(player_beat(&pl, now));
    if (b != last_beat && pl.playing) { last_beat = b; on_until = now + 60000; if (!on) { cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, 1); on = true; } }
    if (on && now > on_until) { cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, 0); on = false; }
}

// ---------------------------------------------------------------- main

int main(void) {
    stdio_init_all();
    const settings_t *fs = (const settings_t *)flash_ptr(SETTINGS_OFFSET);
    if (settings_valid(fs)) set = *fs;
    else settings_defaults(&set);

    player_init(&pl, set.bpm);
    pl.auto_bars = set.auto_bars;
    for (uint p = PIN_NEXT; p <= PIN_TAP; p++) { gpio_init(p); gpio_set_dir(p, GPIO_IN); gpio_pull_up(p); }

    out_init(set.baud);
    load_bank();
    wifi_start();
    web_init();

    for (;;) {
        const uint64_t now = time_us_64();
        usb_poll(now);
        if (!up.active) engine_poll(now);
        wifi_poll(now);
        buttons_poll(now);
        led_poll(now);
    }
}
