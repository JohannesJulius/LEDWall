# Tab „Licht“: 64×48-Wand, Relais-Rig und HUB75-Wand per WLAN

Der Tab **Licht** in der Mac-App bündelt alles, was im Takt von Ableton Link läuft. Er ersetzt die
frühere Python-App „DJ Light Bridge“.

## Takt (Ableton Link über Carabiner)

- Carabiner wird automatisch verbunden, sobald **Link** (für die 64×48-Wand) oder die
  **Licht-Brücke** eingeschaltet ist.
- Antwortet auf `127.0.0.1:17000` nichts, startet die App selbst ein `Carabiner`-Programm oder eine
  `Carabiner.app`, die **im selben Ordner wie „LED Pattern Studio.app“** liegt (z. B. beide in
  `/Applications`). Nur dieses selbst gestartete Carabiner wird beim Beenden der App wieder
  beendet. Ein von Hand gestartetes Carabiner bleibt unangetastet.
- Für Play/Stop schickt die App `enable-start-stop-sync` (Carabiner ab 1.1). Bei älteren
  Versionen gilt Link immer als „läuft“.
- Rekordbox braucht nichts Eigenes: Link einschalten, dann kommen Tempo und Beat über Link an.

## LED-Wand 64×48 (Pico 2W + RP2040 Zero)

Der Pico 2W läuft hier mit der normalen **Sender-Firmware** (`ledwall-sender.uf2`), jede Wand hat
einen RP2040 Zero mit der Empfänger-Firmware. Zurück vom Direktbetrieb geht es über
**Geräte → Pico im BOOTSEL-Modus → „Sender-Firmware installieren“**.

- **+ Pico 2W im WLAN hinzufügen**: Im eigenen WLAN `LEDWall` (Passwort `ledwall123`) ist er unter
  `192.168.4.1` erreichbar, im Heimnetz unter `ledwall.local`. Über USB angeschlossene Pico 2W
  erscheinen von selbst.
- Pattern aus der hochgeladenen Bank wählen (zum nächsten Takt, oder „sofort wechseln“),
  Play/Stop, Blackout, Helligkeit.
- **Ableton Link** schickt dem Pico alle 0,5 s `LINK <bpm> <beat>` (wie der Link-Knopf oben).
- **Play/Stop folgen**: Bei laufendem Link wird das aktive Pattern gewählt, bei gestopptem das
  Idle-Pattern.
- Bank hochladen und WLAN-Einstellungen: Knopf **„Bank & Einstellungen …“** (Tab Geräte).

## Relais-Rig und HUB75-Wand 128×96 (Licht-Brücke)

Bei eingeschalteter Licht-Brücke schickt die App **30-mal pro Sekunde** per UDP an jedes
eingetragene Ziel (Standard-Port 5005) diese Zeile, an beide Gerätearten gleich:

```
BPM=<bpm:.2f>,BEAT=<beat:.4f>,PHASE=<phase:.4f>,PLAYING=<0|1>,APAT=<n>,IPAT=<n>,WAPAT=<n>,WIPAT=<n>
```

| Feld | Bedeutung |
|---|---|
| `BPM` | Link-Tempo × Tempo-Faktor |
| `BEAT` | geglättete Beat-Position × Tempo-Faktor |
| `PHASE` | `BEAT mod 4` |
| `PLAYING` | 1 = Link läuft, 0 = gestoppt |
| `APAT` / `IPAT` | Relais-Pattern bei laufendem / gestopptem Link (1–16) |
| `WAPAT` / `WIPAT` | HUB75-Pattern bei laufendem / gestopptem Link (1–16) |

- **Tempo-Faktor** 1×, 2×, 4× oder 8× (gilt für Relais und HUB75, nicht für die 64×48-Wand).
- **Glättung:** Die hochgerechnete Beat-Position wird gegen eine Vorhersage geprüft. Weicht sie
  um höchstens 0,05 Beat ab, wird die Vorhersage gesendet, sonst neu verankert. Das verhindert
  Ruckeln, besonders bei hohem Tempo-Faktor.
- Die Sende-Schleife läuft in der App auf einem eigenen Thread. Sie wartet nie auf den
  HTTP-Weg zur 64×48-Wand und nicht auf den Carabiner-Start.
- „erreichbar“ heißt: Der Name wird aufgelöst und die Pakete gehen ohne Fehler raus. Ob das
  Gerät sie auswertet, kann UDP nicht melden.
- Gespeichert werden Ziele, aktive/Idle-Patterns, Tempo-Faktor und An/Aus.

Relais-Patterns: 1 Alternate, 2 Together, 3 Chase, 4 All On, 5 All Off, 6 Fast Chase, 7 Reverse
Chase, 8 Bounce, 9 Cross Alternate, 10 Random, 11 Build Up, 12 Build Down, 13 Quarter Chase,
14 Double Chase, 15 Flicker, 16 Random Chase.

HUB75-Patterns: 1 Strobe, 2 Color Flash, 3 Scanner, 4 All On, 5 All Off, 6 Fast Scanner, 7 Bounce
Scanner, 8 Strobe Noise, 9 Build Up, 10 Beat Flash, 11 Noise, 12 Color Noise, 13 Scanner Pair,
14 Slow Pulse, 15 Build Up 16, 16 Build Up 32.
