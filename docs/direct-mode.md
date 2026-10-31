# Direktbetrieb: Panels direkt am Pico 2W

Ein **vorübergehender Testmodus** ohne RP2040 Zero. Die HUB75-Panels hängen über das
**Seengreat RGB Matrix Adapter Board** direkt am Pico 2W. Der Pico spielt die Patterns selbst ab
und wird über WLAN von der App und vom Handy gesteuert.

## Firmware aufspielen

1. Pico 2W mit gedrückter **BOOTSEL**-Taste an den Mac stecken.
2. App → **Geräte** → „Pico 2W im BOOTSEL-Modus“ → **Direktbetrieb installieren**.
3. Zurück zum normalen Sender: genauso, nur mit **Sender-Firmware installieren**.

## Adapter-Board

Die Firmware kennt beide Belegungen des Seengreat-Adapters. Umschalten in der App unter
**Direktbetrieb → Adapter-Board**, danach startet der Pico neu.

| Signal | Seengreat **bis V3.8** (Standard) | Seengreat **ab V3.9** / Standard |
|---|---|---|
| R1 G1 B1 | GP2 GP3 GP4 | GP2 GP3 GP4 |
| R2 G2 B2 | GP5 **GP8 GP9** | GP5 GP6 GP7 |
| A B C D E | GP10 GP16 GP18 GP20 GP22 | GP8 GP9 GP10 GP11 GP12 |
| CLK / LAT / OE | GP11 / GP12 / GP13 | GP13 / GP14 / GP15 |
| Taster Tap / Nächstes (gegen GND) | GP15 / GP14 | GP26 / GP27 |

Die Belegung für V3.8 stammt aus der Pico-Demo von Seengreat
(github.com/seengreat/RGB-Matrix-P3.0-64x64-GBR). Sind Rot/Grün/Blau vertauscht, stellst du in der
App die **Farbreihenfolge** um. Manche Panels sind intern GBR.

## Über WLAN verbinden

1. Den Pico ins eigene WLAN bringen: App → Geräte → Pico (per USB) → **WLAN** → „Vorhandenes
   WLAN“. Oder das Mac mit dem WLAN **„LEDWall“** des Pico verbinden (Passwort `ledwall123`).
2. App → **Geräte** → **„+ Pico 2W per WLAN verbinden“** → `ledwall.local` (bzw. `192.168.4.1`
   im LEDWall-Netz).
3. macOS fragt einmal nach Zugriff auf das **lokale Netzwerk**. Das bitte erlauben.

Danach geht alles über WLAN:
- **Live-Steuerung:** BPM, Tap, Sync, Patterns, Auto-Wechsel, Helligkeit, Blackout
- **Panels:** Wand- und Panelgröße, Kettenreihenfolge, Spiegeln, Farbreihenfolge, Gamma,
  Panel-Takt, Testbilder, „Auf Gerät speichern“
- **Live-Vorschau:** das aktuelle Pattern der App direkt auf den Panels (UDP, Port 4210)
- **Bank hochladen:** „Aktuelles Projekt auf den Sender laden“ (HTTP-POST, mit Fortschritt)

Die Handy-Oberfläche unter `http://ledwall.local` funktioniert wie beim normalen Sender.

## Technik

- Gleicher Code wie der Sender (`firmware/sender`), gebaut mit `LEDWALL_DIRECT=1` →
  `ledwall-direct.uf2`. Bildumrechnung und Panel-Einstellungen kommen vom Empfänger
  (`firmware/receiver/src/display.c`, `config.c`).
- `src/direct/hub75d.c`: PIO für Farbdaten, Latch und OE. Die Adressleitungen setzt die CPU, weil
  sie beim V3.8-Adapter nicht nebeneinander liegen. Die Bildwiederholung läuft auf Core 1.
- Bildausschnitt: die erste Wand des Raum-Setups (sonst die ganze Leinwand), skaliert auf die
  eingestellte Wandgröße.
- Panel-Einstellungen im vorletzten Flash-Sektor. Die Bank darf deshalb 4 KB weniger groß sein
  als vorher.
- Live-Vorschau: Paket `FRAME_PART` (0x09) mit Zeilenblöcken in RGB565 ≤ 1400 Byte, danach
  `SHOW`. Solange Vorschau-Bilder kommen (1,5 s), pausiert die eigene Wiedergabe.
