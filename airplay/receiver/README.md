# airplay-rx: building

The binary runs on the MGU (x86-64, glibc 2.27, loader `/lib/ld-linux-x86-64.so.2`) and links the
head unit's own libcrypto 1.1, libdns_sd and libva. It is built in WSL (Ubuntu) with Zig, no root
needed. One-time setup, in `~/airplay`:

1. Zig 0.13.0 (`zig-linux-x86_64-0.13.0`, sha256 `d45312e6…230ea`), and the wrappers
   `tools/zcc`, `tools/zar`, `tools/zranlib` copied to `~/airplay/` (they target glibc 2.27).
2. Sources in `~/airplay/src`: UxPlay (`git clone https://github.com/FDH2/UxPlay`), libplist 2.6.0,
   ffmpeg-3.4.7, openssl-1.1.1g (headers only), libva 2.0.0 (headers; `va_version.h` written for
   VA-API 0.99, the head unit's).
3. `~/airplay/sysroot/lib`: the head unit's `libssl.so.1.1`, `libcrypto.so.1.1`, `libdns_sd.so.765*`,
   `libva.so.1*`, `libva-drm.so.1*` (copied from `/usr/lib` on the car), and `dns_sd.h` from
   mDNSResponder-765.20.4 in `sysroot/include`.
4. `tools/ffcfg.sh` (FFmpeg: h264/hevc decoders, VA-API, static) and `tools/libbuild.sh` (libplist,
   UxPlay's lib) once.

Then `bash build.sh` builds `dist/airplay-rx`.

Notes from the car: CarPlay's own AirPlay server holds TCP 7000, so the receiver uses 7100/7101 and
UDP 7111/6101/6100; the head unit's nft input chain drops the car Wi-Fi's other ports, so the
receiver adds its rules (comment `airplay-rx`) while on; the i965 VA-API driver decodes but cannot
hand the frames back, so the service runs with `-s` (software decoding: ~2 % of a core for a portrait
iPhone).

`tools/vf2png.py` turns the video file into a PNG; `tools/mdnsq.js` asks mDNS what is advertised.
