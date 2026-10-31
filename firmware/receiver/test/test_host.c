// Host-Tests für Protokoll, Einstellungen und Bildumrechnung (ohne Pico SDK).
//   ./firmware/receiver/test/run.sh
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "config.h"
#include "display.h"
#include "protocol.h"

static int seen, types[16], addrs[16], lens[16];
static uint8_t first_frame[1 + 64 * 48 * 3];

static void cb(void *ctx, uint8_t addr, uint8_t type, const uint8_t *pl, uint16_t len) {
    if (seen == 0) memcpy(first_frame, pl, len);
    types[seen] = type; addrs[seen] = addr; lens[seen] = len;
    seen++;
}

static void test_protocol(const char *path) {
    FILE *f = fopen(path, "rb");
    assert(f);
    static uint8_t data[40000], buf[1 + 64 * 48 * 3];
    size_t n = fread(data, 1, sizeof data, f);
    fclose(f);
    lw_parser_t p;
    lw_parser_init(&p, buf, sizeof buf, cb, NULL);
    for (size_t i = 0; i < n; i++) lw_parser_feed(&p, data[i]);
    assert(seen == 4);
    assert(types[0] == LW_FRAME_RGB888 && addrs[0] == 3 && lens[0] == 1 + 64 * 48 * 3);
    assert(first_frame[0] == LW_FLAG_SHOW);
    assert(first_frame[1 + (5 * 64 + 7) * 3] == 255 && first_frame[1 + (5 * 64 + 8) * 3] == 0);
    assert(types[1] == LW_FRAME_RGB565 && addrs[1] == 9 && lens[1] == 1 + 64 * 48 * 2);
    assert(types[2] == LW_SHOW && addrs[2] == LW_ADDR_ALL && lens[2] == 0);
    assert(types[3] == LW_IDENT);
    assert(p.crc_errors == 1);
    // bekannter Prüfwert CRC-16/CCITT-FALSE
    assert(lw_crc16(0xFFFF, (const uint8_t *)"123456789", 9) == 0x29B1);
    puts("protocol ok");
}

static void test_config(void) {
    config_t c;
    const char *why = NULL;
    config_defaults(&c);
    assert(config_valid(&c, &why));
    assert(config_apply(&c, "addr=7 name=Wand%202 pw=32 ph=16 panels=0,0,0;32,0,0;0,16,3;32,16,3;0,32,0;32,32,0", &why));
    assert(c.address == 7 && !strcmp(c.name, "Wand 2") && c.panel_count == 6 && c.panels[2].flags == 3);
    config_t before = c;
    assert(!config_apply(&c, "addr=0", &why));
    assert(!config_apply(&c, "panels=0,40,0", &why)); // ragt über den Rand (pw 32, ph 16, h 48)
    assert(!config_apply(&c, "foo=1", &why));
    assert(!memcmp(&before, &c, sizeof c));             // nichts verändert
    char json[700];
    config_json(&c, json, sizeof json);
    assert(strstr(json, "\"addr\":7") && strstr(json, "\"name\":\"Wand 2\"") && strstr(json, "[32,16,3]"));
    puts("config ok");
}

static void test_display(void) {
    static display_t d;
    static uint8_t frame[64 * 48 * 3], buf[DISPLAY_BUF_MAX];
    config_t c;
    config_defaults(&c);
    const char *why;
    // 6 Panels 32x16, zweite Reihe um 180° gedreht
    assert(config_apply(&c, "pw=32 ph=16 panels=0,0,0;32,0,0;32,16,3;0,16,3;0,32,0;32,32,0 gamma=10", &why));
    display_setup(&d, &c);
    assert(d.chain_w == 192 && d.rows == 8 && d.buf_size == 8 * 10 * 192);
    // jedes Pixel genau einem Puffer-Bit zugeordnet
    static uint8_t used[DISPLAY_BUF_MAX * 2];
    memset(used, 0, sizeof used);
    for (int i = 0; i < 64 * 48; i++) {
        uint32_t m = d.map[i];
        assert(m != 0xFFFFFFFFu);
        uint32_t k = (m & 0xFFFFFF) * 2 + (m >> 24);
        assert(!used[k]);
        used[k] = 1;
    }
    // weißes Pixel bei (40, 20): Panel 2 (x 32..63, y 16..31, gedreht)
    memset(frame, 0, sizeof frame);
    memset(frame + (20 * 64 + 40) * 3, 255, 3);
    display_convert(&d, frame, FMT_RGB888, buf);
    int lx = 31 - (40 - 32), ly = 15 - (20 - 16);   // 23, 11 -> untere Hälfte, Zeile 3
    int col = 2 * 32 + lx, row = ly % 8;
    for (int b = 0; b < DISPLAY_BITPLANES; b++) assert(buf[(row * DISPLAY_BITPLANES + b) * 192 + col] == 0x38);
    int ones = 0;
    for (uint32_t i = 0; i < d.buf_size; i++) ones += buf[i] != 0;
    assert(ones == DISPLAY_BITPLANES);
    // Seengreat-Adapter bis V3.8: unteres Grün/Blau auf Bit 6/7
    static const uint8_t up[3] = {0, 1, 2}, lo[3] = {3, 6, 7};
    display_set_bitpos(&d, up, lo);
    display_convert(&d, frame, FMT_RGB888, buf);
    for (int b = 0; b < DISPLAY_BITPLANES; b++) assert(buf[(row * DISPLAY_BITPLANES + b) * 192 + col] == 0xC8);
    // Testbilder dürfen nicht über den Rand schreiben
    for (int m = 1; m < TEST_COUNT; m++) draw_test(&c, m, frame);
    draw_ident(&c, frame);
    puts("display ok");
}

int main(int argc, char **argv) {
    assert(argc > 1);
    test_protocol(argv[1]);
    test_config();
    test_display();
    puts("alle Host-Tests bestanden");
    return 0;
}
