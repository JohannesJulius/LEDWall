// Host-Tests für den Sender: Bank lesen, Wand-Ausschnitte, Beat-Uhr.
//   ./firmware/sender/test/run.sh
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bank.h"
#include "player.h"

static uint8_t *load(const char *dir, const char *name, uint32_t *size) {
    char p[512];
    snprintf(p, sizeof p, "%s/%s", dir, name);
    FILE *f = fopen(p, "rb");
    assert(f);
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *d = malloc(n);
    assert(fread(d, 1, n, f) == (size_t)n);
    fclose(f);
    *size = (uint32_t)n;
    return d;
}

static void test_span(const char *dir) {
    uint32_t size, esize;
    uint8_t *d = load(dir, "span.lwb", &size);
    static bank_t b;
    const char *err = bank_open(&b, d, size);
    if (err) printf("Fehler: %s\n", err);
    assert(!err);
    assert(b.width == 128 && b.height == 48 && b.bpp == 3 && b.fpb == 15 && b.count == 2);
    assert(!strcmp(b.patterns[0].name, "Verlauf") && b.patterns[0].loop_beats == 4 && b.patterns[0].frame_count == 60);
    assert(b.patterns[1].loop_beats == 1 && b.patterns[1].frame_count == 15);
    assert(b.mode == 1 && b.wall_count == 2 && !b.broadcast);
    assert(b.walls[0].address == 1 && b.walls[0].channel == 0 && !strcmp(b.walls[0].name, "Links"));
    assert(b.walls[1].address == 7 && b.walls[1].channel == 1 && b.walls[1].rx == 64 * 16 && b.walls[1].rw == 64 * 16);
    // Frame-Index aus der Beat-Position (loopt)
    assert(bank_frame_index(&b, 0, 0.0) == 0);
    assert(bank_frame_index(&b, 0, 7.0 / 15 + 1e-9) == 7);
    assert(bank_frame_index(&b, 0, 4.0 + 7.0 / 15 + 1e-9) == 7);
    assert(bank_frame_index(&b, 1, 2.5) == 7);
    // rechte Wand bei Frame 7 = Vorschau der App
    uint8_t *expect = load(dir, "span_right_f7.bin", &esize);
    assert(esize == 64 * 48 * 3);
    static uint8_t out[64 * 48 * 3];
    bank_sample_wall(&b, bank_frame(&b, 0, 7), &b.walls[1], out);
    int maxd = 0;
    for (uint32_t i = 0; i < esize; i++) { int dd = abs(out[i] - expect[i]); if (dd > maxd) maxd = dd; }
    assert(maxd <= 1);
    // CRC32-Prüfwert
    assert(crc32_update(0, (const uint8_t *)"123456789", 9) == 0xCBF43926u);
    // kaputte Größe wird erkannt
    assert(bank_open(&b, d, size - 1) != NULL);
    free(d);
    free(expect);
    puts("bank (verteilt) ok");
}

static void test_plain(const char *dir) {
    uint32_t size;
    uint8_t *d = load(dir, "plain.lwb", &size);
    static bank_t b;
    assert(!bank_open(&b, d, size));
    assert(b.bpp == 2 && b.wall_count == 0 && b.broadcast && fabsf(b.ref_bpm - 128) < 0.01f);
    assert(b.fpb == 14); // round(30 * 60 / 128)
    // Strobe: Frame 0 weiß, Frame in der Aus-Phase schwarz
    const uint8_t *f0 = bank_frame(&b, 0, 0), *f6 = bank_frame(&b, 0, 6);
    assert(f0[0] == 0xFF && f0[1] == 0xFF && f6[0] == 0 && f6[1] == 0);
    free(d);
    puts("bank (ohne Setup) ok");
}

static void test_player(void) {
    player_t p;
    player_init(&p, 120);
    // 120 BPM: nach 1 s sind 2 Beats vergangen
    assert(fabs(player_beat(&p, 1000000) - 2.0) < 1e-9);
    player_set_bpm(&p, 60, 1000000);
    assert(fabs(player_beat(&p, 2000000) - 3.0) < 1e-9);
    // Tap-Tempo: Abstand 0,5 s -> 120 BPM, Schlag auf dem Tap
    player_t t;
    player_init(&t, 90);
    for (int i = 0; i < 4; i++) player_tap(&t, 10000000 + i * 500000ull);
    assert(fabs(t.bpm - 120) < 1e-6);
    assert(fabs(player_beat(&t, 11500000) - round(player_beat(&t, 11500000))) < 1e-9);
    // Wechsel erst am nächsten Takt
    player_init(&p, 120);
    player_update(&p, 0, 3);
    player_select(&p, 2, false, 3);
    assert(!player_update(&p, 1000000, 3) && p.pattern == 0); // Beat 2
    assert(player_update(&p, 2000000, 3) && p.pattern == 2);  // Beat 4 = Takt 2
    // Auto-Wechsel alle 2 Takte
    p.auto_bars = 2;
    assert(!player_update(&p, 4000000, 3));                    // Takt 3 (1 Takt seit Wechsel)
    assert(player_update(&p, 6000000, 3) && p.pattern == 0);   // Takt 4
    // Sync: jetzt ist der Taktanfang
    player_sync(&p, 6900000);
    assert(fmod(player_beat(&p, 6900000), 4.0) < 1e-9);
    // Pause hält die Position
    player_set_playing(&p, false, 7000000);
    double b = player_beat(&p, 7000000);
    assert(player_beat(&p, 9000000) == b);
    // Ableton Link: großer Versatz springt, kleiner wird sanft nachgezogen
    player_t l;
    player_init(&l, 120);
    player_link(&l, 128, 100.0, 1000000);
    assert(fabs(player_beat(&l, 1000000) - 100.0) < 1e-9 && fabs(l.bpm - 128) < 1e-9);
    player_link(&l, 128, 100.0 + 128.0 / 60 * 0.5 + 0.1, 1500000); // 0,1 Beat voraus
    double after = player_beat(&l, 1500000), target = 100.0 + 128.0 / 60 * 0.5 + 0.1;
    assert(after < target && after > target - 0.1);                 // nur ein Teil korrigiert
    for (int i = 0; i < 20; i++) player_link(&l, 128, target + 128.0 / 60 * 0.25 * (i + 1), 1500000 + 250000ull * (i + 1));
    assert(fabs(player_beat(&l, 1500000 + 250000ull * 20) - (target + 128.0 / 60 * 5)) < 0.001); // eingerastet
    puts("player ok");
}

int main(int argc, char **argv) {
    assert(argc > 1);
    test_span(argv[1]);
    test_plain(argv[1]);
    test_player();
    puts("alle Sender-Host-Tests bestanden");
    return 0;
}
