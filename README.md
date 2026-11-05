# mgu-airplay

Two apps for the BMW iDrive 7 head unit (MGU), installed from the
[Store](https://github.com/robertnisipeanu/mgu-store):

- **AirPlay**: your iPhone's screen on the central display, by AirPlay screen
  mirroring, while parked. The sound stays on Bluetooth to the car. Found in
  **Apps** and **Communication**.
- **Waze Cards**: Waze's turn and arrival cards, or Waze's map, on the
  instrument cluster while Waze guides in CarPlay.

By **h4m4d**. iDrive 7 only.

## Install

1. In the car: **Store → Settings → Add source**, enter `noth4m4d/mgu-airplay`,
   choose **Releases**.
2. Install **AirPlay** and/or **Waze Cards**. Each brings its background
   service (AirPlay receiver, Waze Cards service) with it.

You need the Store with root access already set up (mgu-store's README).
AirPlay draws the phone's picture through the GPU renderer of the
[idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) kit, which
the Store installs with those apps.

## Using AirPlay

1. Open **AirPlay** on the iDrive (Apps or Communication).
2. On the iPhone, disconnect CarPlay and join the car's Wi-Fi.
3. iPhone: **Control Centre → Screen Mirroring →** your car's Bluetooth name
   (`BMW 12345`).
4. Sound: keep the iPhone's audio output on **BMW (Bluetooth)**.

The receiver advertises the car and opens its firewall ports only while the
app is open, and closes them a few seconds after you leave it. *Parked only*
(on by default) hides the picture while driving.

## How it works

| | |
|---|---|
| `airplay/receiver/` | `airplay-rx`: UxPlay's AirPlay library, H.264/HEVC decoding with a minimal FFmpeg, each frame written as I420 into a video file the kit's renderer draws (`/dev/shm/mgu-video-airplay`). Built for the head unit's glibc 2.27 with Zig in WSL. |
| `airplay/app/apm_airplay/` | the iDrive app (kit app): menu, status, the full-screen picture (renderer video op), the receiver's on/off file. |
| `airplay/tool/` | the Store tool kit: the binary and its systemd unit. |
| `wazecards/service/` | `wazecard.js`: grabs the central screen, finds Waze's cards, draws them on the cluster through cluster-render. |
| `wazecards/app/`, `wazecards/tool/` | its iDrive app and tool kit. |
| `kit-patches/` | changes to the idrive7-apps build tool: app credits, extra menu entries (`entryPoints`), the AirPlay icon. |
| `tools/` | `pack.js` (tool kits; apps without BMW's SDK), `release.js` (the Store catalog release). |

## Build

```sh
KIT=../idrive7-apps sh build.sh      # every package into dist/
node tools/release.js                # the "catalog" release on GitHub
```

The kit needs `kit-patches/idrive7-apps-build.patch` applied (based on the
commit in `kit-patches/BASE_COMMIT`) and BMW's oap-sdk extracted from your own
head unit (its README). The receiver's one-time WSL setup is in
`airplay/receiver/README.md`.

## Licence

AirPlay: GPL-3.0-or-later (`LICENSE`). Waze Cards: MIT (`LICENSE.MIT`). Third-party
parts and their licences: `NOTICE.md`. Not affiliated with Apple or BMW.
