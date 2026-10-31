# Ableton Link (über Carabiner)

Der Pico 2W kann Tempo und Beat-Position einer Ableton-Link-Session übernehmen, z. B. von
Ableton Live, Traktor, Rekordbox oder einer anderen Link-App. Dann laufen alle Patterns und
Pattern-Wechsel im Takt der Musik.

## So funktioniert es

```
Ableton Live / DJ-Software ──Link──► Carabiner-Fenster (Mac) ──TCP 127.0.0.1:17000──► LED Pattern Studio
                                                                                        │
                                                       „LINK <bpm> <beat>“ alle 0,5 s    ▼
                                                                         Pico 2W (WLAN oder USB)
```

[Carabiner](https://github.com/Deep-Symmetry/carabiner) ist die Brücke zu Ableton Link. Es nimmt
**nur Verbindungen vom eigenen Mac an** (127.0.0.1). Deshalb liest die App die Werte aus Carabiner
und gibt sie an den Pico weiter. Der Pico braucht dafür keine eigene Link-Software.

## Einrichten

1. **Carabiner** starten (Fenster offen lassen, Standard-Port 17000).
2. Im **LED Pattern Studio** oben rechts auf **Link** klicken. Er zeigt dann „Link · 2“, also die
   Anzahl der Link-Teilnehmer, und die Vorschau der App läuft im Ableton-Takt.
3. Den Pico 2W unter **Geräte** verbinden, per USB oder mit **„+ Pico 2W per WLAN verbinden“**.
   Ab dann bekommt er laufend Tempo und Beat.

Die Handy-Oberfläche des Pico zeigt „· Ableton Link“ neben der BPM. Ändert man dort das
Tempo, überschreibt die nächste Link-Meldung es wieder. Ohne Link-Meldungen (App zu, Link
aus) läuft der Pico nach 3 s mit seiner eigenen Uhr im zuletzt bekannten Tempo weiter.

## Technik

- App: `mac-app/Sources/CarabinerClient.swift` fragt alle 250 ms `status` ab
  (`status { :peers 1 :bpm 128.0 :start … :beat 597.73 }`, Beat mit Quantum 4) und verbindet
  sich nach einem Abbruch selbst neu. `pattern-studio/js/link.js` lässt die Vorschau mitlaufen
  und schickt `LINK <bpm> <beat>` an alle Sender. Die Laufzeit wird eingerechnet: USB ≈ 4 ms,
  WLAN = halbe gemessene Antwortzeit.
- Pico: `player_link()`. Beim ersten Mal oder bei mehr als ½ Beat Versatz springt er auf die
  Link-Position, kleinere Abweichungen zieht er sanft nach (30 % je Meldung). Takte
  (`beat / 4`) entsprechen den Ableton-Takten, Pattern-Wechsel am Taktanfang liegen also auf
  der „1“.
