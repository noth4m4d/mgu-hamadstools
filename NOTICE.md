# Notices

**AirPlay** (`airplay/`) is GPL-3.0-or-later (`LICENSE`), because the receiver links UxPlay's
AirPlay library. **Waze Cards** (`wazecards/`) is MIT (`LICENSE.MIT`). Both © 2026 h4m4d.

The AirPlay receiver (`airplay-rx`) is built from, and its binary contains:

| Part | Licence | Source |
|---|---|---|
| UxPlay `lib/` (AirPlay protocol, FairPlay handshake, pairing) | GPL-3.0 (parts LGPL-2.1) | https://github.com/FDH2/UxPlay |
| playfair (in UxPlay) | GPL-3.0 | https://github.com/FDH2/UxPlay/tree/master/lib/playfair |
| llhttp (in UxPlay) | MIT | https://github.com/nodejs/llhttp |
| FFmpeg 3.4.7 (libavcodec, libavutil: H.264/HEVC decoding only, built without GPL parts) | LGPL-2.1-or-later | https://ffmpeg.org/releases/ffmpeg-3.4.7.tar.xz |
| libplist 2.6.0 | LGPL-2.1-or-later | https://github.com/libimobiledevice/libplist |

It uses, from the head unit, without shipping them: OpenSSL 1.1.1g (libcrypto), Apple's
mDNSResponder client library (libdns_sd), libva. `airplay/receiver/` has the source and the
script that builds the binary from these exact versions.

The iDrive apps are built with the [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
kit (MIT, © cauliflowermossgrape and contributors), whose runtime (`kit/`) is inside each app
package. `kit-patches/` holds the changes this repository makes to its build tool. BMW's
oap-sdk is not included: the head unit supplies it.

AirPlay and iPhone are trademarks of Apple Inc.; BMW and iDrive of BMW AG. This project is not
affiliated with or endorsed by either.
