#!/bin/sh
# build.sh - build every Store package of this repository into dist/ (from the PC, Git Bash).
#
#   KIT=<idrive7-apps checkout, kit-patches applied, SDK extracted> sh build.sh [--no-receiver]
#
# - the AirPlay receiver (airplay-rx) in WSL with Zig, for the head unit's glibc 2.27
#   (airplay/receiver/build.sh; one-time setup in airplay/receiver/README.md)
# - the two iDrive apps with the idrive7-apps kit, BMW's SDK then taken out (tools/pack.js app)
# - the two tool kits (tools/pack.js tool)
set -eu
cd "$(dirname "$0")"
KIT=${KIT:-../idrive7-apps}
[ -d "$KIT/kit/tools" ] || { echo "no kit at $KIT (set KIT)"; exit 2; }
grep -q "'credits'" "$KIT/kit/tools/build.py" || { echo "apply kit-patches/idrive7-apps-build.patch to $KIT first"; exit 2; }
rm -rf dist; mkdir -p dist

if [ "${1:-}" != "--no-receiver" ]; then
    echo "== airplay-rx (WSL)"
    W=$(wsl -d Ubuntu -- wslpath -a "$(pwd -W)/airplay/receiver/build.sh" | tr -d '\r')
    MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash "$W" | tail -1
fi
[ -f airplay/receiver/dist/airplay-rx ] || { echo "no airplay/receiver/dist/airplay-rx"; exit 1; }

app() {   # app <folder> <id>
    rm -rf "$KIT/apps/$2"; cp -r "$1/$2" "$KIT/apps/$2"
    ( cd "$KIT" && python kit/tools/build.py "$2" ) | tail -1
    V=$(node -p "require('./$1/$2/app.json').version")
    node tools/pack.js app "$KIT/dist/$2@$V.tgz"
    rm -rf "$KIT/apps/$2"
}
echo "== apps"
app airplay/app apm_airplay
app wazecards/app wzc_wazecards
echo "== tools"
node tools/pack.js tool airplay/tool
node tools/pack.js tool wazecards/tool
ls -la dist
