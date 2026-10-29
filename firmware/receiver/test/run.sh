#!/bin/bash
# Host-Tests der Empfänger-Firmware (gcc + node)
set -euo pipefail
cd "$(dirname "$0")"
OUT="${TMPDIR:-/tmp}/ledwall-rx-test"
mkdir -p "$OUT"
node gen_packets.js > "$OUT/packets.bin"
gcc -std=c11 -Wall -Wextra -Wno-unused-parameter -fsanitize=address,undefined -g -I../src \
  test_host.c ../src/protocol.c ../src/config.c ../src/display.c -lm -o "$OUT/test_host"
"$OUT/test_host" "$OUT/packets.bin"
