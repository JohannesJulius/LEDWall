# Empfänger: RP2040 Zero in der LED-Wand

Der Zero steuert die HUB75-Panels seiner 64 × 48-Wand. Er empfängt nur Bilder vom Sender
(Pico 2W) und zeigt sie an. Alles andere passiert in der App.

## Verkabelung

| HUB75 | RP2040 Zero | | HUB75 | RP2040 Zero |
|---|---|---|---|---|
| R1 | GP2 | | A | GP8 |
| G1 | GP3 | | B | GP9 |
| B1 | GP4 | | C | GP10 |
| R2 | GP5 | | D | GP11 |
| G2 | GP6 | | E | GP12 |
| B2 | GP7 | | CLK | GP13 |
| GND | GND | | LAT / STB | GP14 |
| | | | OE | GP15 |

Vom Sender: **TX des Pico 2W → GP1** und GND ↔ GND.

- Panels über ein eigenes 5-V-Netzteil versorgen und GND von Netzteil, Zero und Sender
  verbinden. Den Zero nicht über die Panels speisen, solange er am Mac hängt.
- Panels, die nur 16 Pixel hoch sind (Adressen A–D), lassen E frei.
- Die eingebaute RGB-LED zeigt den Zustand: **blau blinkend** = wartet auf Signal,
  **grün** = Bilder kommen an, **lila** = Identifizieren, **orange** = Testbild.

## Einrichten mit der App

1. Zero an den Mac anschließen. Neuer Zero: **BOOT-Taste gedrückt halten und einstecken**.
   Die App zeigt „RP2040 im BOOTSEL-Modus“ → **Empfänger-Firmware installieren**.
2. Der Zero startet neu, erscheint als Empfänger und zeigt seine Adresse groß auf der Wand.
3. Unter **Geräte** Adresse, Name und Panel-Aufteilung einstellen (Vorlagen für 3 × 64×16 und
   6 × 32×16). Mit **Testbild → Panels** prüfen: Jede Zahl muss lesbar sein, der Pfeil nach
   rechts zeigen. Sonst Panel spiegeln oder die Reihenfolge ändern.
4. **Auf Gerät speichern**. Die Einstellungen bleiben im Flash des Zero.
5. Optional die **Live-Vorschau** einschalten: Die App schickt das aktuelle Pattern über USB
   direkt an die Wand, ganz ohne Sender.
6. Unter **Im Raum** den Empfänger einer Wand zuordnen und im Tab **Raum** platzieren.

Firmware-Updates kommen mit App-Updates. Ist die Firmware auf dem Zero älter, zeigt die App
**Update** an und spielt sie mit einem Klick ein (kein Knopfdrücken nötig).

## Technik

- C mit Pico SDK 2.1, Quellcode in `firmware/receiver/`
- Core 1: HUB75-Bildwiederholung über PIO (10 Bit pro Farbe, Gamma-Tabelle, ≈ 800 Hz bei
  3 × 64×16), Core 0: UART-Empfang per DMA-Ringpuffer, USB, Umrechnung in Bitebenen
- Doppelpuffer, synchrones Umschalten per `SHOW` (siehe [protocol.md](protocol.md))
- Einstellungen im letzten Flash-Sektor, Prüfsumme, bei Fehlern Werkseinstellungen

Bauen (Linux/macOS):

```bash
export PICO_SDK_PATH=/pfad/zum/pico-sdk   # Version 2.1.x
cmake -S firmware/receiver -B firmware/receiver/build -G Ninja
cmake --build firmware/receiver/build     # -> ledwall-receiver.uf2
./firmware/receiver/test/run.sh           # Host-Tests (gcc + node)
```
