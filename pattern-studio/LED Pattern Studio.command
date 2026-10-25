#!/bin/bash
# Startet das LED Pattern Studio auf dem Mac.
# Bevorzugt Chrome/Edge/Brave im App-Fenster (ohne Tabs, mit Datei-Speichern-Dialog),
# sonst den Standardbrowser (z. B. Safari).
cd "$(dirname "$0")"
URL="file://$PWD/index.html"
for APP in "Google Chrome" "Microsoft Edge" "Brave Browser" "Chromium"; do
  if open -Ra "$APP" 2>/dev/null; then
    open -na "$APP" --args --app="$URL" --window-size=1440,900
    exit 0
  fi
done
open "index.html"
