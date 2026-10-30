#include "player.h"

#include <math.h>
#include <string.h>

void player_init(player_t *p, double bpm) {
    memset(p, 0, sizeof *p);
    p->bpm = bpm;
    p->playing = true;
    p->next = -1;
}

double player_beat(const player_t *p, uint64_t now) {
    if (!p->playing) return p->beat0;
    return p->beat0 + (double)(int64_t)(now - p->t0) * p->bpm / 60e6;
}

static void anchor(player_t *p, uint64_t now) {
    p->beat0 = player_beat(p, now);
    p->t0 = now;
}

void player_set_bpm(player_t *p, double bpm, uint64_t now) {
    if (bpm < 20) bpm = 20;
    if (bpm > 300) bpm = 300;
    anchor(p, now);
    p->bpm = bpm;
}

void player_set_playing(player_t *p, bool on, uint64_t now) {
    anchor(p, now);
    p->playing = on;
}

void player_tap(player_t *p, uint64_t now) {
    if (p->tap_count && now - p->taps[p->tap_count - 1] > 2000000) p->tap_count = 0;
    if (p->tap_count == 8) { memmove(p->taps, p->taps + 1, 7 * sizeof p->taps[0]); p->tap_count = 7; }
    p->taps[p->tap_count++] = now;
    if (p->tap_count >= 2) {
        const double avg = (double)(p->taps[p->tap_count - 1] - p->taps[0]) / (p->tap_count - 1);
        player_set_bpm(p, 60e6 / avg, now);
        p->beat0 = round(p->beat0); // Schlag liegt auf dem Tap
    }
}

void player_sync(player_t *p, uint64_t now) {
    // auf den nächsten Taktanfang springen, ohne den Takt-Zähler zurückzusetzen
    const double b = player_beat(p, now);
    p->beat0 = floor(b / 4.0 + 0.5) * 4.0;
    if (p->beat0 < b - 2) p->beat0 += 4;
    p->t0 = now;
}

void player_nudge(player_t *p, double beats, uint64_t now) {
    anchor(p, now);
    p->beat0 += beats;
}

void player_select(player_t *p, int index, bool immediately, int count) {
    if (count <= 0) return;
    index = ((index % count) + count) % count;
    if (immediately) { p->pattern = index; p->next = -1; p->switch_bar = p->last_bar; }
    else p->next = index;
}

bool player_update(player_t *p, uint64_t now, int count) {
    if (count <= 0) return false;
    if (p->pattern >= count) p->pattern = 0;
    const int64_t bar = (int64_t)floor(player_beat(p, now) / 4.0);
    if (bar == p->last_bar) return false;
    p->last_bar = bar;
    if (p->next >= 0) {
        p->pattern = p->next < count ? p->next : 0;
        p->next = -1;
        p->switch_bar = bar;
        return true;
    }
    if (p->auto_bars > 0 && bar - p->switch_bar >= p->auto_bars) {
        p->pattern = (p->pattern + 1) % count;
        p->switch_bar = bar;
        return true;
    }
    return false;
}
