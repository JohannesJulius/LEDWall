#!/bin/bash
# Baut "LED Pattern Studio.app" (Universal: Apple Silicon + Intel), das DMG und das
# Update-ZIP. Läuft auf macOS mit Xcode bzw. den Command Line Tools.
#
#   ./mac-app/build.sh [VERSION] [OWNER/REPO]
set -euo pipefail
cd "$(dirname "$0")"

VERSION="${1:-$(tr -d ' \r\n' < ../VERSION)}"
REPO="${2:-JohannesJulius/LEDWall}"
NAME="LED Pattern Studio"
OUT=build
APP="$OUT/$NAME.app"

rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"

echo "== Kompilieren ($VERSION)"
for ARCH in arm64 x86_64; do
  xcrun swiftc -O -swift-version 5 -target "$ARCH-apple-macos12.0" \
    -framework Cocoa -framework WebKit -framework CryptoKit -framework IOKit \
    Sources/*.swift -o "$OUT/LEDPatternStudio-$ARCH"
done
lipo -create -output "$APP/Contents/MacOS/LEDPatternStudio" "$OUT"/LEDPatternStudio-*

echo "== Bundle"
sed -e "s/__VERSION__/$VERSION/g" -e "s#__REPO__#$REPO#g" Info.plist > "$APP/Contents/Info.plist"
cp -R ../pattern-studio/index.html ../pattern-studio/css ../pattern-studio/js "$APP/Contents/Resources/web/"

# Empfänger-Firmware einbetten (FIRMWARE_UF2=Pfad zur .uf2, z. B. aus dem Firmware-Build)
FW_UF2="${FIRMWARE_UF2:-../firmware/receiver/build/ledwall-receiver.uf2}"
if [ -f "$FW_UF2" ]; then
  mkdir -p "$APP/Contents/Resources/firmware"
  cp "$FW_UF2" "$APP/Contents/Resources/firmware/ledwall-receiver.uf2"
  tr -d ' \r\n' < ../firmware/receiver/VERSION > "$APP/Contents/Resources/firmware/version.txt"
  echo "Firmware $(cat "$APP/Contents/Resources/firmware/version.txt") eingebettet"
else
  echo "WARNUNG: keine Empfänger-Firmware gefunden ($FW_UF2) – Aufspielen in der App nicht möglich"
fi

# Sender-Firmware (Pico 2W) einbetten
FW_SENDER="${SENDER_UF2:-../firmware/sender/build/ledwall-sender.uf2}"
if [ -f "$FW_SENDER" ]; then
  mkdir -p "$APP/Contents/Resources/firmware"
  cp "$FW_SENDER" "$APP/Contents/Resources/firmware/ledwall-sender.uf2"
  tr -d ' \r\n' < ../firmware/sender/VERSION > "$APP/Contents/Resources/firmware/sender-version.txt"
  echo "Sender-Firmware $(cat "$APP/Contents/Resources/firmware/sender-version.txt") eingebettet"
else
  echo "WARNUNG: keine Sender-Firmware gefunden ($FW_SENDER)"
fi

ICONSET="$OUT/AppIcon.iconset"
mkdir -p "$ICONSET"
for S in 16 32 128 256 512; do
  sips -z $S $S icon/AppIcon.png --out "$ICONSET/icon_${S}x${S}.png" >/dev/null
  sips -z $((S * 2)) $((S * 2)) icon/AppIcon.png --out "$ICONSET/icon_${S}x${S}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# Ad-hoc-Signatur (kein Apple-Entwicklerkonto nötig)
codesign --force --deep --sign - "$APP"
codesign --verify --deep "$APP"

echo "== Update-ZIP"
ditto -c -k --keepParent "$APP" "$OUT/LED-Pattern-Studio-mac.zip"

echo "== DMG"
STAGE="$OUT/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "$NAME" -srcfolder "$STAGE" -ov -format UDZO "$OUT/LED-Pattern-Studio.dmg" >/dev/null

ls -lh "$OUT"/*.dmg "$OUT"/*.zip
