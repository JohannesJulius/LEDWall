// Beat-Uhr und Pattern-Ablauf
#pragma once
#include <stdbool.h>
#include <stdint.h>

typedef struct {
    double bpm;
    uint64_t t0;        // Zeitpunkt (µs), an dem beat0 galt
    double beat0;
    bool playing;
    int pattern;        // aktuelles Pattern
    int next;           // wartet auf den nächsten Takt (-1 = nichts)
    int auto_bars;      // automatisch weiterschalten alle n Takte (0 = aus)
    int64_t last_bar;
    int64_t switch_bar; // Takt des letzten Wechsels
    uint64_t taps[8];
    int tap_count;
} player_t;

void player_init(player_t *p, double bpm);
double player_beat(const player_t *p, uint64_t now);
void player_set_bpm(player_t *p, double bpm, uint64_t now);
void player_set_playing(player_t *p, bool on, uint64_t now);
void player_tap(player_t *p, uint64_t now);
void player_sync(player_t *p, uint64_t now);           // jetzt ist "1" (Taktanfang)
void player_nudge(player_t *p, double beats, uint64_t now);
// Tempo und Beat von außen (Ableton Link über die App): großer Versatz -> springen, sonst sanft nachziehen
void player_link(player_t *p, double bpm, double beat, uint64_t now);
void player_select(player_t *p, int index, bool now_, int count);
// Wechsel am Taktanfang und Auto-Wechsel ausführen. true = Pattern hat gewechselt.
bool player_update(player_t *p, uint64_t now, int count);
