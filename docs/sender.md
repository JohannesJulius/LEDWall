# Sender: Pico 2W

Der Pico 2W ist die Zentrale. Er hält alle Patterns (die **Bank**) im Flash, rechnet aus der
BPM die Beat-Position aus und schickt jeder Wand ihr Bild. Danach folgt ein `SHOW` an alle,
und alle Wände schalten gleichzeitig um. Der Mac wird dafür nicht gebraucht.

## Anschlüsse

| Pico 2W | Funktion |
|---|---|
| GP0 (UART0 TX) | **Ausgang 1**, an GP1 der Empfänger |
| GP4 (UART1 TX) | **Ausgang 2**, an GP1 weiterer Empfänger |
| GND | gemeinsame Masse mit allen Empfängern |
| GP15 | Taster gegen GND: **tippen = Tempo (Tap)**, **halten = Sync** (jetzt ist „1“) |
| GP14 | Taster gegen GND: nächstes Pattern (wechselt am nächsten Takt) |

Ein Ausgang kann mehrere Empfänger versorgen, die TX-Leitung geht dann an alle. Welche Wand an
welchem Ausgang hängt, stellst du in der App im Tab **Raum** ein. Die eingebaute LED blinkt im Takt.

## Einrichten mit der App

1. Pico 2W mit gedrückter **BOOTSEL**-Taste an den Mac stecken → **Geräte** →
   „Pico 2W im BOOTSEL-Modus“ → **Sender-Firmware installieren**.
2. Danach erscheint er als **Sender**. Unter **Pattern-Bank** auf **„Aktuelles Projekt auf den
   Sender laden“** klicken. Alle Patterns werden auf die Referenz-BPM gerendert und zusammen mit
   dem Raum-Setup (Adressen, Ausgänge, Verteilung) übertragen. Der Platz reicht für etwa 3 MB.
   Die App zeigt vorher an, ob die Bank passt (sonst Bildrate senken oder RGB565 wählen).
3. Fertig: Der Sender spielt ab dem nächsten Einschalten selbstständig ab.

## Steuern

**Per Handy (WLAN):** Der Sender öffnet ein eigenes Netz **„LEDWall“**
(Passwort `ledwall123`). Mit dem Handy verbinden und **http://192.168.4.1** öffnen. Alternativ
lässt er sich in der App mit einem vorhandenen WLAN verbinden. Dann ist er unter
**http://ledwall.local** erreichbar, die IP zeigt die App. Klappt die Verbindung nicht,
öffnet er nach 20 s wieder sein eigenes Netz.

Die Weboberfläche bietet:
- BPM ±1 / ±0,1, ½ / ×2, früher/später schieben
- großer **TAP**-Knopf und **SYNC** (setzt den Taktanfang)
- Pattern wählen, sofort oder am nächsten Takt, Auto-Wechsel alle 4–64 Takte
- Pause, Blackout, Helligkeit für alle Wände, „Wände zeigen“ (blendet die Adressen ein)

**Per App (USB):** Im Tab **Geräte** gibt es dieselben Funktionen, dazu WLAN-Einstellungen und
Baudrate.

**Per Taster:** Tap/Sync an GP15, nächstes Pattern an GP14.

## Ablauf intern

- Beat-Uhr: `beat = beat0 + (t − t0) · BPM / 60`. Tap-Tempo mittelt bis zu 8 Schläge und legt
  den Schlag auf den Tap.
- Pro Durchgang wird das Frame zur aktuellen Beat-Position gewählt. Dabei rechnet der Sender
  die Sendezeit mit ein, damit das Bild beim `SHOW` genau zur Musik passt.
- **Jede Wand zeigt das ganze Bild** (alle gleich groß): Ein Paket an alle (Adresse `0xFF`)
  pro Ausgang, direkt aus dem Flash per DMA.
- **Verteilt / verschiedene Größen:** Für jede Wand schneidet der Sender ihren Ausschnitt aus
  der Leinwand und schickt ihn an ihre Adresse.
- Erst wenn alle Ausgänge fertig sind, kommt `SHOW` an alle. Dann schalten alle Wände
  gleichzeitig um.
- Pattern-Wechsel passieren am Taktanfang. Weil alle Loops ganze Beats lang sind, bleibt alles
  im Takt.

## USB-Befehle

Textzeilen wie beim Empfänger (siehe [protocol.md](protocol.md)):

| Befehl | Wirkung |
|---|---|
| `INFO` | `INFO {json}`: BPM, Beat, Pattern, Bank, WLAN, fps |
| `PATTERNS` | `STATE {json}` wie INFO, plus Patternliste |
| `BPM 140` · `TAP` · `SYNC` · `NUDGE 0.05` | Tempo und Phase |
| `PATTERN 3 [now]` · `NEXT` · `PREV` · `AUTO 16` | Patterns |
| `PLAY` · `STOP` · `BLACKOUT 1` · `BRIGHT 200` · `IDENT 5` | Wiedergabe |
| `WIFI mode=ap\|sta ssid=… pass=… apssid=… appass=…` | WLAN (URL-kodiert, gilt nach Neustart) |
| `BAUD 2000000` · `SAVE` | Baudrate, Startwerte speichern |
| `UPLOAD <bytes> <crc32>` | Bank übertragen: Antwort `READY`, dann Blöcke à 4096 Byte, je `ACK <n>`, am Ende `OK` |
| `BOOTSEL` · `REBOOT` | Firmware-Update, Neustart |

Die Weboberfläche nutzt dieselben Befehle über `GET /api/cmd?c=…`, den Zustand liefert
`GET /api/state`.

## Speicher (4 MB Flash)

| Bereich | Inhalt |
|---|---|
| 0 – 1 MB | Firmware (≈ 400 KB inkl. WLAN) |
| 1 MB – 4 MB − 4 KB | Pattern-Bank (max. ≈ 2,99 MB) |
| letzte 4 KB | Einstellungen (WLAN, Start-BPM, Auto-Wechsel, Helligkeit, Baudrate) |

Bauen: wie beim Empfänger, aber im Ordner `firmware/sender`. Das Pico SDK braucht zusätzlich
die Submodule `lib/cyw43-driver` und `lib/lwip`.
