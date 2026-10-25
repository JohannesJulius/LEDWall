# LED Pattern Studio (macOS)

Editor mit Live-Vorschau für die 64 × 48 LED-Wände. Damit baust du Patterns aus Ebenen
zusammen, stellst Bewegungen und Farben ein, prüfst alles bei beliebiger BPM und
exportierst am Ende alle Patterns für den Pico 2W.

## Starten

Am einfachsten installierst du die **Mac-App** (DMG unter Releases, siehe
[Haupt-README](../README.md)). Sie bringt diese Oberfläche mit und aktualisiert sich selbst.

Ohne Installation geht es auch im Browser: Doppelklick auf `LED Pattern Studio.command` oder
`index.html` öffnen. Dann speichert der Browser das Projekt zwischen. Mit **Speichern** (⌘S)
bekommst du eine richtige Datei (`*.ledproj.json`).

## Aufbau

| Bereich | Funktion |
|---|---|
| **Oben** | Datei-Funktionen, Transport: Play/Pause, BPM, ½ / ×2, **Tap**-Tempo, Metronom-Klick, Beat-Anzeige |
| **Links** | Pattern-Bibliothek mit animierten Mini-Vorschauen, neue Patterns leer oder aus 16 Vorlagen |
| **Mitte** | Vorschau in LED-Optik (oder flach, optional mit Raster), Loop-Länge, Zeitleiste zum Scrubben (⇧ = einrasten) |
| **Rechts** | Ebenen (oben = vorne) und Inspektor für die gewählte Ebene |

### Ebenentypen
Vollfarbe · Verlauf (linear, Kreise, Quadrate, Rauten, Strahlen, Spirale) · Streifen/Ringe ·
Plasma · Rauschen/Feuer · Schachbrett · Funkeln · Regen/Matrix · Welle · Form (Kreis, Quadrat,
Raute, Dreieck, Kreuz, Herz) · Scanner · **Zeichnung** (Pixel selbst malen)

### Werkzeuge pro Ebene
- **Farben:** Palette mit beliebig vielen Farben, Vorlagen, weiche oder harte Übergänge,
  Farbrotation pro Beat
- **Bewegung:** Scrollen X/Y (px/Beat), Drehen (Umdrehungen/Beat), Winkel, Zoom,
  Kaleidoskop, Spiegeln, Mittelpunkt
- **Beat-Hüllkurve:** Puls (wie eine Kick), Strobo, Atmen, Rampen, Zufall, jeweils mit
  Rate pro Beat, Versatz und Minimum. Die Kurve wird als kleiner Graph angezeigt.
- **Mischen:** Normal, Addieren, Multiplizieren, Aufhellen … plus Deckkraft und
  „Schwarz = transparent“
- **Zeichnen** (nur auf Zeichnungs-Ebenen): Stift, Radierer, Linie, Rechteck, Ellipse,
  Füllen, Pipette, Pinselgröße, Spiegeln. Du malst immer genau da, wo du es siehst, auch
  wenn sich die Ebene gerade bewegt.

Doppelklick auf einen Regler-Namen setzt den Wert zurück. ⌘Z / ⇧⌘Z macht rückgängig bzw.
wiederholt.

### Tastenkürzel
Leertaste Play/Pause · T Tap-Tempo · M Metronom · ⌘S Speichern (⇧⌘S unter neuem Namen) ·
⌘O Öffnen · Zeichnen: P Stift, E Radierer, L Linie, R Rechteck, O Ellipse, F Füllen,
I Pipette

## BPM-Konzept

Alle Zeitangaben sind **in Beats**, nicht in Sekunden. Eine Geschwindigkeit von „1/4“
heißt also z. B. „eine Runde in 4 Beats“. Die BPM oben im Fenster ist nur zur Vorschau
da. Das Pattern ist dasselbe, es läuft nur schneller oder langsamer.

Jedes Pattern hat eine **Loop-Länge** (1 Beat bis 8 Takte). Die Anzeige
„✓ Loop nahtlos“ / „⚠ Sprung am Loop-Ende“ prüft, ob das Ende sauber in den Anfang
übergeht. Faustregel: *Geschwindigkeit × Loop-Länge* sollte eine ganze Zahl ergeben. Bei
Farbwechseln und Streifen sollte es sogar ein Vielfaches der Farbanzahl sein.

## Export für die Wand

**Export für Wand** rendert alle Patterns auf eine **Referenz-BPM** (Standard 120)
mit einer wählbaren Bildrate und speichert sie als **`.lwb`-Bank**. Die Frames sind nach
Beat-Position abgelegt. Der Pico 2W rechnet aus seiner aktuellen BPM die Beat-Position
aus und wählt damit den passenden Frame, so steuert er die Geschwindigkeit. Wie die Datei
genau aufgebaut ist, steht in [`../docs/lwb-format.md`](../docs/lwb-format.md).

Zusätzlich lässt sich das Projekt als parametrische JSON-Datei exportieren (wenige KB).
Das passt, falls die Effekte später direkt auf den Mikrocontrollern berechnet werden
sollen.

## Entwicklung

- `js/renderer.js`: komplette Render-Logik ohne DOM, damit sie nach C/MicroPython portierbar ist
- `js/presets.js`: Vorlagen und Paletten
- `js/app.js`: Oberfläche
- Tests: `node --test tests/*.test.js`
