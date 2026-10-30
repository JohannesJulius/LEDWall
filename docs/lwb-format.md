# `.lwb`: LEDWall-Bank-Format

Das Pattern Studio exportiert alle Patterns eines Projekts in **eine** Binärdatei. Jedes
Pattern liegt darin als fertig gerenderte Frame-Folge über seine Loop-Länge. Die Frames
sind nach **Beat-Position** indiziert, nicht nach Zeit. Deshalb kann der Pico 2W die
Geschwindigkeit frei über die BPM steuern.

Alle Zahlen sind Little Endian.

## Header (32 Byte)

| Offset | Typ | Inhalt |
|---|---|---|
| 0 | `char[4]` | Magic `"LWB1"` |
| 4 | `u16` | Breite (64) |
| 6 | `u16` | Höhe (48) |
| 8 | `u16` | Referenz-BPM × 10 (z. B. 1200 = 120 BPM) |
| 10 | `u8` | `framesPerBeat` |
| 11 | `u8` | Pixelformat: 0 = RGB888, 1 = RGB565 |
| 12 | `u16` | Anzahl Patterns |
| 14 | `u16` | reserviert |
| 16 | `u32` | Offset der Pattern-Tabelle (= 32) |
| 20 | `u32` | Offset des Raum-Setups (0 = keins, Bild an alle Wände) |
| 24 | `u32` | Gesamtgröße der Datei in Byte |
| 28 | 4 Byte | reserviert (0) |

## Pattern-Tabelle (32 Byte je Pattern)

| Offset | Typ | Inhalt |
|---|---|---|
| 0 | `char[20]` | Name, UTF-8, mit 0 aufgefüllt |
| 20 | `u16` | Loop-Länge in Beats |
| 22 | `u16` | Flags: Bit 0 = Loop nahtlos |
| 24 | `u32` | `frameCount` (= Loop-Beats × framesPerBeat) |
| 28 | `u32` | Offset der Frame-Daten ab Dateianfang |

## Raum-Setup (optional)

Liegt direkt hinter der Pattern-Tabelle, wenn im Projekt Wände angelegt sind. Die Frames haben
dann die Größe der **Leinwand**:
- Modus „gleiches Bild“: Leinwand = Größe der ersten Wand
- Modus „verteilt“: alle Wände von vorne gesehen

| Offset | Typ | Inhalt |
|---|---|---|
| 0 | `char[4]` | `"LWS1"` |
| 4 | `u16` | Anzahl Wände (max. 8) |
| 6 | `u8` | Modus: 0 = jede Wand zeigt das ganze Bild, 1 = verteilt |
| 7 | `u8` | reserviert |
| 8 | je 32 Byte | Wände |

Wand (32 Byte): `u8` Adresse, `u8` Sender-Ausgang (0 = GP0, 1 = GP4), `u16` Breite,
`u16` Höhe, `u16 x, y, w, h` Ausschnitt der Leinwand in 1/16 Pixel, `char[18]` Name.

## Frame-Daten

Jedes Frame besteht aus Breite × Höhe Pixeln, **zeilenweise von oben links**, also
logische Koordinaten. Die Umsetzung auf die echte Verkabelung der Panels
(Serpentine/Zickzack, Panel-Reihenfolge) und die Gamma-Korrektur übernimmt die Firmware.

- RGB888: 3 Byte pro Pixel (R, G, B) → 9216 Byte pro Frame
- RGB565: 2 Byte pro Pixel (`RRRRRGGG GGGBBBBB` als u16) → 6144 Byte pro Frame

## Abspielen (Pico 2W)

Die Firmware dazu steht in `firmware/sender/`, siehe [sender.md](sender.md).

```c
// beat läuft kontinuierlich weiter und wird nur durch die BPM bestimmt
beat += dt_seconds * bpm / 60.0f;

uint32_t frame = (uint32_t)floorf(beat * framesPerBeat) % frameCount;
const uint8_t *pixels = bank + dataOffset + frame * frameBytes;
// -> an den/die RP2040 Zero schicken
```

Ein Beispiel: 120 BPM Referenz bei 30 fps ergibt `framesPerBeat = 15`. Spielt der 2W mit
140 BPM, werden pro Sekunde 35 Frames gezeigt. Bei 90 BPM sind es 22,5. Das Pattern
bleibt dasselbe, es läuft nur schneller oder langsamer.

Patternwechsel auf dem Taktanfang (`beat % 4 == 0`) wirken am saubersten, weil die
Loop-Längen Vielfache von Beats sind.

## Größen (64 × 48, RGB888, 15 Frames/Beat)

| Loop | Frames | Größe |
|---|---|---|
| 1 Takt (4 Beats) | 60 | 540 KB |
| 2 Takte (8 Beats) | 120 | 1,05 MB |

Bei großen Banken helfen weniger FPS, RGB565 oder kürzere Loops. Das Export-Fenster
zeigt die Gesamtgröße an und warnt beim Flash-Limit (Pico 2W: 4 MB, RP2040 Zero: 2 MB).
