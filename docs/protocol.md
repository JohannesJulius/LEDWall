# LEDWall-Protokoll (Sender → Empfänger)

So schickt der Pico 2W den RP2040-Zero-Empfängern, was sie zeigen sollen. Die App benutzt
dasselbe Format für die Live-Vorschau über USB.

- **Leitung:** UART 8N1, Standard 2 MBaud (pro Empfänger einstellbar). Der TX des Senders
  geht an GP1 (RX) eines oder mehrerer Zeros (bei kurzen Kabeln, gemeinsame Masse).
- **Adressen:** jeder Empfänger hat eine Adresse von 1 bis 254 und reagiert nur auf Pakete
  mit seiner Adresse oder mit `0xFF` (= an alle). Über USB wird jedes Paket angenommen.

## Paketaufbau

```
0xA5 0x5A | addr u8 | type u8 | len u16 LE | payload[len] | crc16 u16 LE
```

`crc16` = CRC-16/CCITT-FALSE (Polynom 0x1021, Startwert 0xFFFF, keine Umkehrung) über
`addr`, `type`, `len` und `payload`. Prüfwert: `crc16("123456789") = 0x29B1`. Pakete mit
falscher Prüfsumme werden verworfen. Der Empfänger findet nach Störungen über `0xA5 0x5A`
wieder in den Takt.

| type | Name | Payload |
|---|---|---|
| `0x01` | FRAME_RGB888 | `flags`, dann Breite × Höhe × 3 Byte (R, G, B) |
| `0x02` | FRAME_RGB565 | `flags`, dann Breite × Höhe × 2 Byte (u16 LE, `RRRRRGGGGGGBBBBB`) |
| `0x03` | SHOW | – zeigt das zuletzt empfangene Bild an |
| `0x04` | FILL | `flags`, R, G, B: ganze Wand einfarbig |
| `0x05` | BRIGHTNESS | u8 0–255, bis zum Neustart |
| `0x06` | TEST | u8 Testbild: 0 aus, 1 Farben, 2 Verlauf, 3 Panels, 4 Raster, 5 Weiß |
| `0x07` | IDENT | u8 Sekunden: Adresse groß anzeigen |
| `0x08` | BLACKOUT | – alles aus |

`flags` Bit 0 = sofort anzeigen. Ohne dieses Bit wartet das Bild im Puffer auf `SHOW`. So
schickt der Sender zuerst allen Wänden ihr Bild und schaltet dann mit **einem**
`SHOW` an `0xFF` alle gleichzeitig um.

Die Bilder sind immer zeilenweise von oben links im Wandformat (z. B. 64 × 48). Wie die Panels
verkabelt sind, weiß nur der Empfänger. Ein Bild mit falscher Größe wird ignoriert.

## Datenrate

| Format | Bytes pro Bild (64 × 48) | bei 2 MBaud | bei 4 MBaud |
|---|---|---|---|
| RGB565 | 6 153 | ≈ 32 fps | ≈ 65 fps |
| RGB888 | 9 225 | ≈ 21 fps | ≈ 43 fps |

Teilen sich mehrere Wände eine Leitung, teilt sich auch diese Rate auf. Für viele Wände
bekommt jede Wand am besten eine eigene TX-Leitung (der Pico 2W hat genug PIO-UARTs).

## USB-Befehle (App ↔ Empfänger)

Textzeilen, mit `\n` abgeschlossen. Binärpakete (beginnen mit `0xA5`) dürfen dazwischen kommen.

| Befehl | Antwort |
|---|---|
| `INFO` | `INFO {json}`: Firmware, Seriennummer, alle Einstellungen, `saved` |
| `SET key=value …` | `OK` / `ERR Grund` (übernimmt sofort, speichert nicht) |
| `SAVE` | Einstellungen in den Flash schreiben |
| `DEFAULTS` | Werkseinstellungen (nicht gespeichert) |
| `IDENT [s]` | Adresse anzeigen |
| `TEST n` | Testbild wie oben |
| `STATS` | `STATS {json}`: empfangene Bilder, CRC-Fehler, Bildwiederholungen |
| `BOOTSEL` | startet in den BOOTSEL-Modus (für Firmware-Updates) |
| `REBOOT` | Neustart |

Schlüssel für `SET`: `addr`, `name` (URL-kodiert), `w`, `h`, `pw`, `ph`,
`panels=x,y,flags;x,y,flags;…` (flags: 1 = waagrecht gespiegelt, 2 = senkrecht gespiegelt,
3 = um 180° gedreht), `order` (0 RGB … 5 BGR), `bright`, `gamma` (×10), `div`, `baud`.
