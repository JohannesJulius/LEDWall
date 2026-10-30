#!/bin/bash
# Host-Tests der Sender-Firmware (gcc + node)
set -euo pipefail
cd "$(dirname "$0")"
OUT="${TMPDIR:-/tmp}/ledwall-tx-test"
mkdir -p "$OUT"
node gen_bank.js "$OUT"
gcc -std=c11 -Wall -Wextra -Wno-unused-parameter -fsanitize=address,undefined -g -I../src \
  test_host.c ../src/bank.c ../src/player.c -lm -o "$OUT/test_host"
"$OUT/test_host" "$OUT"
