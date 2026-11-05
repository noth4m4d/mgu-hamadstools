#!/bin/bash
# build.sh - build airplay-rx for the head unit, in WSL (see README for the one-time setup of ~/airplay:
# Zig 0.13, UxPlay lib, libplist, minimal FFmpeg 3.4.7 with VA-API, the car's shared libraries).
#
#   wsl -d Ubuntu -- bash <path to this folder>/build.sh
set -e
A=$HOME/airplay
HERE=$(dirname "$(readlink -f "$0")")
U=$A/src/UxPlay/lib
S=$A/sysroot
mkdir -p "$HERE/dist"
$A/zcc -O2 -Wall -D_GNU_SOURCE \
  -I$S/ff/include -I$S/include -I$A/src/openssl-1.1.1g/include -I$U \
  "$HERE/src/airplay-rx.c" -o "$HERE/dist/airplay-rx" \
  $S/lib/libairplay.a $S/lib/libplist-2.0.a $S/ff/lib/libavcodec.a $S/ff/lib/libavutil.a \
  -L$S/lib -lcrypto -ldns_sd -lva -lva-drm -lpthread -lm -ldl \
  -Wl,--allow-shlib-undefined -Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2   # the MGU has no /lib64
file "$HERE/dist/airplay-rx"
ls -la "$HERE/dist/airplay-rx"
