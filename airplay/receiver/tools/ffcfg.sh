#!/bin/bash
# configure + build a minimal static FFmpeg 3.4.7 (h264/hevc + vaapi) for the head unit
set -e
A=$HOME/airplay
mkdir -p $A/build/ffmpeg && cd $A/build/ffmpeg
$A/src/ffmpeg-3.4.7/configure --prefix=$A/sysroot/ff --cc=$A/zcc --ar=$A/zar --ranlib=$A/zranlib \
 --enable-cross-compile --target-os=linux --arch=x86_64 --disable-x86asm --disable-inline-asm \
 --disable-everything --disable-programs --disable-doc --enable-static --disable-shared --enable-pic \
 --enable-avcodec --enable-avutil --disable-avformat --disable-avfilter --disable-swresample --disable-swscale --disable-avdevice --disable-postproc \
 --enable-decoder=h264,hevc --enable-parser=h264,hevc --enable-vaapi --enable-hwaccel=h264_vaapi,hevc_vaapi \
 --disable-vdpau --disable-xlib --disable-libxcb --disable-zlib --disable-iconv --disable-lzma --disable-bzlib \
 --extra-cflags="-I$A/sysroot/include -O2" --extra-ldflags="-L$A/sysroot/lib" > cfg.log 2>&1 || { tail -5 cfg.log; tail -20 ffbuild/config.log; exit 1; }
# zig's glibc headers have no sys/sysctl.h (removed from glibc), but configure finds it via the host
sed -i 's/^#define HAVE_SYSCTL 1/#define HAVE_SYSCTL 0/' config.h
grep -E "CONFIG_H264_VAAPI_HWACCEL |CONFIG_HEVC_VAAPI_HWACCEL |HAVE_VAAPI_DRM |CONFIG_VAAPI " config.h
make -j8 > make.log 2>&1 || { tail -30 make.log; exit 1; }
make install > /dev/null
ls -la $A/sysroot/ff/lib
