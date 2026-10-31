# LEDWall

Modulare LED-Wand aus kleinen 64 × 48-Pixel-Wänden.

![Pattern Studio](docs/pattern-studio.png)

```
   Mac: Pattern Studio  ──(.lwb-Bank)──►  Pico 2W  ──(Frames)──►  RP2040 Zero ─► Wand 1 (64×48)
                                         Takt/BPM              ├─► RP2040 Zero ─► Wand 2
                                                                └─► …
```

- **Pico 2W:** Zentrale. Er hält die Pattern-Bank, bestimmt BPM und Beat-Position und
  schickt jeder Wand, was sie zeigen soll. Gesteuert wird er per Handy (eigenes WLAN mit
  Weboberfläche), über die App oder per Tap-Taster, siehe [docs/sender.md](docs/sender.md).
- **RP2040 Zero** (einer pro Wand): steuert die HUB75-Panels seiner 64 × 48-Wand an und
  versteht die Pakete vom Sender. Eingerichtet wird er in der App (Tab **Geräte**), siehe
  [docs/receiver.md](docs/receiver.md).

Die App hat drei Bereiche: **Patterns** (erstellen mit BPM-Vorschau), **Geräte** (Empfänger
erkennen, Firmware aufspielen, Adresse und Panels einstellen, Live-Vorschau über USB) und
**Raum** (das Setup in 3D nachbauen und im Projekt speichern).

## LED Pattern Studio installieren (Mac)

1. Unter **Releases** die neueste `LED-Pattern-Studio.dmg` herunterladen und öffnen.
2. **LED Pattern Studio** auf den Ordner **Applications** ziehen.
3. Beim **ersten** Start meldet macOS, dass der Entwickler nicht überprüft werden kann (die App
   ist nicht bei Apple notarisiert). Dann einmalig:
   **Systemeinstellungen → Datenschutz & Sicherheit → ganz unten „Trotzdem öffnen“**.
   Alternativ im Terminal: `xattr -dr com.apple.quarantine "/Applications/LED Pattern Studio.app"`

Danach aktualisiert sich die App selbst. Sie sucht beim Start und alle 6 Stunden nach einer neuen
Version. Du kannst auch über **LED Pattern Studio → Nach Updates suchen …** oder den
Update-Knopf oben rechts suchen. Ein Klick auf „Jetzt installieren“ lädt das Update, prüft die
Prüfsumme, tauscht die App aus und startet sie neu.

Benötigt macOS 12 oder neuer. Läuft nativ auf Apple Silicon und Intel.

## Neue Version veröffentlichen

1. Versionsnummer in der Datei `VERSION` erhöhen (z. B. `1.1.0`).
2. Optional: eine Beschreibung in `release-notes/v1.1.0.md` anlegen. Sie erscheint in der App im
   Update-Fenster.
3. Committen und auf `main` pushen.

GitHub baut daraufhin die App (`.github/workflows/release.yml`), legt den Tag `v1.1.0` an und
veröffentlicht `LED-Pattern-Studio.dmg`, `LED-Pattern-Studio-mac.zip` (für den Updater),
`ledwall-receiver.uf2`, `ledwall-sender.uf2` und `SHA256SUMS.txt`. Beide Firmwares werden
dabei mitgebaut und in die App eingebettet. Ihre Versionen stehen in `firmware/*/VERSION`. Installierte Apps finden das Update automatisch.

> Wie bei MakerDash muss das Repository **öffentlich** sein, damit die App Updates ohne
> Anmeldung abrufen kann.

Zum Testen baut `.github/workflows/mac-build.yml` die App bei jedem Push. Das DMG findest du
dann unter **Actions → Lauf → Artifacts**. Lokal auf dem Mac geht es mit
`./mac-app/build.sh` (benötigt die Xcode Command Line Tools: `xcode-select --install`).

## Inhalt

| Ordner | Inhalt |
|---|---|
| [`pattern-studio/`](pattern-studio/) | Editor zum Erstellen von Patterns mit Live-Vorschau und BPM-Vorschau (Web-Oberfläche) |
| [`mac-app/`](mac-app/) | Mac-App um den Editor (Swift + WebKit) mit eingebautem Updater, Build-Skript |
| [`release-notes/`](release-notes/) | Beschreibungen der einzelnen Versionen |
| [`firmware/receiver/`](firmware/receiver/) | Empfänger-Firmware für den RP2040 Zero (C, Pico SDK), wird in die App eingebettet |
| [`firmware/sender/`](firmware/sender/) | Sender-Firmware für den Pico 2W (C, Pico SDK, WLAN + Weboberfläche) |
| [`firmware/common/`](firmware/common/) | Gemeinsamer Protokoll-Code |
| [`docs/sender.md`](docs/sender.md) | Anschlüsse, Bedienung und Ablauf des Senders |
| [`docs/direct-mode.md`](docs/direct-mode.md) | Testmodus: Panels direkt am Pico 2W (Seengreat-Adapter), alles über WLAN |
| [`docs/receiver.md`](docs/receiver.md) | Verkabelung und Einrichtung des Empfängers |
| [`docs/protocol.md`](docs/protocol.md) | Protokoll Sender → Empfänger und USB-Befehle |
| [`docs/lwb-format.md`](docs/lwb-format.md) | Dateiformat der exportierten Pattern-Bank und wie der 2W sie abspielt |

