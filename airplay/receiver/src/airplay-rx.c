/*
 * airplay-rx - AirPlay screen-mirroring receiver for the BMW MGU (iDrive 7) head unit.
 *
 * The AirPlay protocol (pairing, FairPlay, the mirror stream) is UxPlay's lib/ (GPL-3.0,
 * LGPL-2.1 parts). This file replaces UxPlay's GStreamer front end: it decodes the mirror
 * stream (H.264 or HEVC) on the head unit's Intel GPU with VA-API through a minimal FFmpeg
 * built for it, and writes each frame as I420 into a video file the kit renderer
 * (idrive7-renderd, PROTOCOL.md "Video") draws: /dev/shm/mgu-video-<name>.
 *
 * Audio is not played (the phone's sound stays on Bluetooth).
 *
 *   airplay-rx [-n name] [-o /dev/shm/mgu-video-airplay] [-m 02:..:..] [-k keyfile]
 *              [-W 1920 -H 720] [-f 30] [-s] [-d]
 *     -s   software decoding (no VA-API), for testing
 *     -d   debug log
 *
 * Copyright (C) 2026 h4m4d. GPL-3.0-or-later (it links UxPlay's GPL-3.0 code).
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/pixdesc.h>

#include "raop.h"
#include "dnssd.h"
#include "logger.h"

/* ---- options ---- */
static const char *opt_name = "auto";
static const char *opt_out = "/dev/shm/mgu-video-airplay";
static const char *opt_mac = NULL;
static const char *opt_key = "/var/opt/airplay/airplay.pem";
static int opt_w = 1920, opt_h = 720, opt_fps = 30;
static bool opt_sw = false, opt_debug = false;
static const char *opt_app = NULL;           /* -a: on only while this iDrive app is open */
static bool opt_noaudio = false;             /* -A: advertise video only */

/* what the status file reports */
static char client_name[128] = "";
static volatile bool mirroring = false;
static double last_fps = 0;

static volatile sig_atomic_t quit = 0;
static volatile int reset_httpd = 0;

static void logf_(const char *lvl, const char *fmt, ...) {
    struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
    struct tm tm; localtime_r(&ts.tv_sec, &tm);
    char t[32]; strftime(t, sizeof t, "%H:%M:%S", &tm);
    fprintf(stderr, "%s.%03ld %s ", t, ts.tv_nsec / 1000000, lvl);
    va_list ap; va_start(ap, fmt); vfprintf(stderr, fmt, ap); va_end(ap);
    fputc('\n', stderr);
}
#define LOGI(...) logf_("I", __VA_ARGS__)
#define LOGE(...) logf_("E", __VA_ARGS__)
#define LOGD(...) do { if (opt_debug) logf_("D", __VA_ARGS__); } while (0)

/* ---- the renderer's video file (PROTOCOL.md, "Video") ---- */
#define VF_MAGIC 0x4656474d
#define VF_HDR 64
#define VF_SLOTS 3

typedef struct {
    int fd;
    uint8_t *map;
    size_t len;
    int w, h;
} vfile_t;
static vfile_t vf = { -1, NULL, 0, 0, 0 };

static void vf_close(void) {
    if (vf.map) munmap(vf.map, vf.len);
    if (vf.fd >= 0) close(vf.fd);
    vf.map = NULL; vf.fd = -1; vf.len = 0; vf.w = vf.h = 0;
}

/* (re)size the file for w x h frames; the renderer re-reads the header each frame */
static int vf_open(int w, int h) {
    if (vf.map && vf.w == w && vf.h == h) return 0;
    size_t frame = (size_t) w * h * 3 / 2, len = VF_HDR + frame * VF_SLOTS;
    if (vf.fd < 0) {
        vf.fd = open(opt_out, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0644);
        if (vf.fd < 0) { LOGE("open %s: %s", opt_out, strerror(errno)); return -1; }
    }
    if (vf.map) { munmap(vf.map, vf.len); vf.map = NULL; }
    if (ftruncate(vf.fd, (off_t) len) != 0) { LOGE("ftruncate: %s", strerror(errno)); return -1; }
    vf.map = mmap(NULL, len, PROT_READ | PROT_WRITE, MAP_SHARED, vf.fd, 0);
    if (vf.map == MAP_FAILED) { vf.map = NULL; LOGE("mmap: %s", strerror(errno)); return -1; }
    vf.len = len; vf.w = w; vf.h = h;
    uint32_t *hd = (uint32_t *) vf.map;
    memset(hd, 0, VF_HDR);
    hd[0] = VF_MAGIC; hd[1] = 1; hd[2] = w; hd[3] = h; hd[4] = 0; hd[5] = 0; hd[6] = VF_SLOTS;
    LOGI("video file %s: %dx%d", opt_out, w, h);
    return 0;
}

/* write one NV12 / YUV420P frame (w, h already even) */
static void vf_write(const AVFrame *f, int w, int h) {
    if (vf_open(w, h) != 0) return;
    uint32_t *hd = (uint32_t *) vf.map;
    int slot = (hd[5] + 1) % VF_SLOTS;
    uint8_t *y = vf.map + VF_HDR + (size_t) slot * w * h * 3 / 2;
    uint8_t *u = y + (size_t) w * h, *v = u + (size_t) (w / 2) * (h / 2);
    for (int r = 0; r < h; r++) memcpy(y + (size_t) r * w, f->data[0] + (size_t) r * f->linesize[0], w);
    if (f->format == AV_PIX_FMT_NV12) {
        for (int r = 0; r < h / 2; r++) {
            const uint8_t *s = f->data[1] + (size_t) r * f->linesize[1];
            uint8_t *du = u + (size_t) r * (w / 2), *dv = v + (size_t) r * (w / 2);
            for (int c = 0; c < w / 2; c++) { du[c] = s[2 * c]; dv[c] = s[2 * c + 1]; }
        }
    } else { /* YUV420P / YUVJ420P (software decoding) */
        for (int r = 0; r < h / 2; r++) {
            memcpy(u + (size_t) r * (w / 2), f->data[1] + (size_t) r * f->linesize[1], w / 2);
            memcpy(v + (size_t) r * (w / 2), f->data[2] + (size_t) r * f->linesize[2], w / 2);
        }
    }
    hd[7] = (f->colorspace == AVCOL_SPC_BT470BG || f->colorspace == AVCOL_SPC_SMPTE170M) ? 0 : 1;
    hd[8] = (f->color_range == AVCOL_RANGE_JPEG || f->format == AV_PIX_FMT_YUVJ420P) ? 1 : 0;
    __atomic_store_n(&hd[5], (uint32_t) slot, __ATOMIC_RELEASE);
    __atomic_store_n(&hd[4], hd[4] + 1, __ATOMIC_RELEASE);
}

/* ---- decoder ---- */
static pthread_mutex_t dec_lock = PTHREAD_MUTEX_INITIALIZER;
static AVCodecContext *dec = NULL;
static AVBufferRef *hwdev = NULL;
static int dec_h265 = -1;
static AVFrame *frm = NULL, *swf = NULL;
static uint64_t n_frames = 0, n_bytes = 0;
static struct timespec t_stat;

static enum AVPixelFormat get_fmt(AVCodecContext *c, const enum AVPixelFormat *fmts) {
    for (const enum AVPixelFormat *p = fmts; *p != AV_PIX_FMT_NONE; p++)
        if (*p == AV_PIX_FMT_VAAPI && hwdev) return *p;
    LOGI("decoder: no VA-API format offered, software decoding");
    return fmts[0] == AV_PIX_FMT_VAAPI ? fmts[1] : fmts[0];
}

static void dec_close_locked(void) {
    if (dec) avcodec_free_context(&dec);
    dec_h265 = -1;
}

static int dec_open_locked(bool h265) {
    if (dec && dec_h265 == (int) h265) return 0;
    dec_close_locked();
    AVCodec *codec = avcodec_find_decoder(h265 ? AV_CODEC_ID_HEVC : AV_CODEC_ID_H264);
    if (!codec) { LOGE("no %s decoder", h265 ? "HEVC" : "H.264"); return -1; }
    dec = avcodec_alloc_context3(codec);
    if (!opt_sw && !hwdev) {
        int r = av_hwdevice_ctx_create(&hwdev, AV_HWDEVICE_TYPE_VAAPI, "/dev/dri/renderD128", NULL, 0);
        if (r < 0) { LOGE("VA-API device: %s; software decoding", av_err2str(r)); hwdev = NULL; }
        else LOGI("VA-API device ready");
    }
    if (hwdev) { dec->hw_device_ctx = av_buffer_ref(hwdev); dec->get_format = get_fmt; }
    else { dec->thread_count = 4; dec->thread_type = FF_THREAD_SLICE; }
    dec->flags |= AV_CODEC_FLAG_LOW_DELAY;
    if (avcodec_open2(dec, codec, NULL) < 0) { LOGE("avcodec_open2 failed"); avcodec_free_context(&dec); return -1; }
    dec_h265 = h265;
    LOGI("decoder: %s (%s)", codec->name, hwdev ? "VA-API" : "software");
    return 0;
}

/* The phone sends the stream's parameter sets (H.264 SPS/PPS, HEVC VPS/SPS/PPS) once, at the start
 * and after a change. They are kept here and handed to every decoder opened later (after a
 * fallback to software decoding, a flush or a codec change), which otherwise decodes nothing:
 * "non-existing PPS 0 referenced". */
static uint8_t ps_buf[4096];
static int ps_len = 0, ps_h265 = -1;

static void keep_params(const uint8_t *d, int len, bool h265) {
    uint8_t tmp[sizeof ps_buf]; int tl = 0, found = 0;
    for (int i = 0; i + 3 < len; ) {
        int sc = (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1) ? 3 : (i + 4 < len && d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 0 && d[i + 3] == 1) ? 4 : 0;
        if (!sc) { i++; continue; }
        int s = i, p = i + sc, e = p;
        while (e + 3 < len && !(d[e] == 0 && d[e + 1] == 0 && (d[e + 2] == 1 || (d[e + 2] == 0 && d[e + 3] == 1)))) e++;
        if (e + 3 >= len) e = len;
        int t = h265 ? (d[p] >> 1) & 0x3f : d[p] & 0x1f;
        bool param = h265 ? (t >= 32 && t <= 34) : (t == 7 || t == 8);
        if (param && tl + (e - s) <= (int) sizeof tmp) { memcpy(tmp + tl, d + s, e - s); tl += e - s; found = 1; }
        i = e;
    }
    if (found) { memcpy(ps_buf, tmp, tl); ps_len = tl; ps_h265 = h265; }
}

static void decode(const uint8_t *data, int len, bool h265) {
    pthread_mutex_lock(&dec_lock);
    keep_params(data, len, h265);
    bool fresh = !dec || dec_h265 != (int) h265;
    if (dec_open_locked(h265) != 0) { pthread_mutex_unlock(&dec_lock); return; }
    if (fresh && ps_len && ps_h265 == (int) h265) {
        AVPacket cfg; av_init_packet(&cfg);
        cfg.data = ps_buf; cfg.size = ps_len;
        avcodec_send_packet(dec, &cfg);
        LOGI("decoder primed with the stream's parameter sets (%d bytes)", ps_len);
    }
    AVPacket pkt; av_init_packet(&pkt);
    pkt.data = (uint8_t *) data; pkt.size = len;
    int r = avcodec_send_packet(dec, &pkt);
    if (r < 0 && r != AVERROR(EAGAIN)) LOGD("send_packet: %s", av_err2str(r));
    while ((r = avcodec_receive_frame(dec, frm)) == 0) {
        AVFrame *out = frm;
        if (frm->format == AV_PIX_FMT_VAAPI) {
            /* leave swf's format unset: FFmpeg 3.4 picks the surface's own download format (NV12 on i965);
               naming one it does not list gives EINVAL */
            av_frame_unref(swf);
            if ((r = av_hwframe_transfer_data(swf, frm, 0)) < 0) {
                /* seen with the i965 driver (EIO): decode on the CPU from here on */
                LOGE("hwframe transfer: %s - software decoding from now on", av_err2str(r));
                av_frame_unref(frm);
                dec_close_locked(); av_buffer_unref(&hwdev); opt_sw = true;
                pthread_mutex_unlock(&dec_lock);
                return;
            }
            static int fmt_said = 0;
            if (!fmt_said++) LOGI("GPU frames download as %s", av_get_pix_fmt_name((enum AVPixelFormat) swf->format));
            if (swf->format != AV_PIX_FMT_NV12 && swf->format != AV_PIX_FMT_YUV420P) { av_frame_unref(frm); continue; }
            swf->colorspace = frm->colorspace; swf->color_range = frm->color_range;
            out = swf;
        }
        vf_write(out, frm->width & ~1, frm->height & ~1);
        n_frames++;
        av_frame_unref(frm);
    }
    n_bytes += len;
    pthread_mutex_unlock(&dec_lock);
    struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);
    double dt = (now.tv_sec - t_stat.tv_sec) + (now.tv_nsec - t_stat.tv_nsec) / 1e9;
    if (dt >= 10) {
        last_fps = n_frames / dt;
        if (n_frames || n_bytes) LOGI("%.1f fps, %.0f kbit/s, %dx%d", last_fps, n_bytes * 8 / dt / 1000, vf.w, vf.h);
        n_frames = n_bytes = 0; t_stat = now;
    }
}

static void dec_flush(void) {
    pthread_mutex_lock(&dec_lock);
    if (dec) avcodec_flush_buffers(dec);
    pthread_mutex_unlock(&dec_lock);
}

/* ---- AirPlay callbacks ---- */
static int open_connections = 0;

static void cb_video_process(void *cls, raop_ntp_t *ntp, video_decode_struct *d) { decode(d->data, d->data_len, d->is_h265); }
static void cb_audio_process(void *cls, raop_ntp_t *ntp, audio_decode_struct *d) { }
static void cb_video_pause(void *cls) { LOGD("video pause"); }
static void cb_video_resume(void *cls) { LOGD("video resume"); }
static void cb_conn_feedback(void *cls) { }
static void cb_conn_reset(void *cls, int reason) { LOGI("connection reset (%d)", reason); dec_flush(); reset_httpd = 1; }
static void cb_video_reset(void *cls, reset_type_t t) { LOGI("video reset (%d)", (int) t); dec_flush(); }
static int cb_set_codec_and_size(void *cls, video_codec_t codec, unsigned short ws, unsigned short hs,
                                 unsigned short xo, unsigned short yo, unsigned short w, unsigned short h) {
    LOGI("stream: %s source %ux%u, picture %ux%u at %u,%u", codec == VIDEO_CODEC_H265 ? "HEVC" : "H.264", ws, hs, w, h, xo, yo);
    return 0;
}
static void cb_conn_init(void *cls) { open_connections++; LOGI("connections: %d", open_connections); }
static void cb_conn_destroy(void *cls) {
    if (--open_connections <= 0) {
        open_connections = 0;
        pthread_mutex_lock(&dec_lock); dec_close_locked(); pthread_mutex_unlock(&dec_lock);
    }
    LOGI("connections: %d", open_connections);
}
static void cb_audio_flush(void *cls) { }
static void cb_video_flush(void *cls) { dec_flush(); }
static double cb_get_client_volume(void *cls) { return -30.0; }
static void cb_set_volume(void *cls, float v) { }
static void cb_set_metadata(void *cls, const void *b, int n) { }
static void cb_set_coverart(void *cls, const void *b, int n) { }
static void cb_stop_coverart(void *cls) { }
static void cb_remote_control_id(void *cls, const char *a, const char *b) { }
static void cb_set_progress(void *cls, uint32_t *s, uint32_t *c, uint32_t *e) { }
static void cb_audio_get_format(void *cls, unsigned char *ct, unsigned short *spf, bool *scr, bool *media, uint64_t *fmt) { }
static void cb_mirror_running(void *cls, bool on) {
    mirroring = on;
    if (!on) last_fps = 0;
    LOGI("mirroring %s", on ? "started" : "stopped");
}
static void cb_report_client(void *cls, char *id, char *model, char *name, bool *admit) {
    LOGI("client: %s (%s) %s", name, model, id); *admit = true;
    snprintf(client_name, sizeof client_name, "%s", name ? name : "");
}
static void cb_display_pin(void *cls, char *pin) { LOGI("pin %s", pin); }
static void cb_register_client(void *cls, const char *id, const char *pk, const char *name) { }
static bool cb_check_register(void *cls, const char *pk) { return true; }
static const char *cb_passwd(void *cls, int *len) { *len = 0; return NULL; }
static void cb_export_dacp(void *cls, const char *a, const char *b) { }
static void cb_on_video_play(void *cls, const char *loc, const float pos) { }
static void cb_on_video_scrub(void *cls, const float pos) { }
static void cb_on_video_rate(void *cls, const float rate) { }
static void cb_on_video_stop(void *cls) { }
static void cb_on_video_info(void *cls, playback_info_t *pi) { }
static float cb_on_playlist_remove(void *cls) { return 0; }
static void cb_custom_profile(void *cls, const char **p) { *p = NULL; }

static void raop_log(void *cls, int level, const char *msg) {
    if (level <= LOGGER_INFO || opt_debug) logf_(level <= LOGGER_ERR ? "E" : "I", "raop: %s", msg);
}

/* ---- device id ---- */
static int parse_mac(const char *s, char out[6]) {
    unsigned b[6];
    if (sscanf(s, "%x:%x:%x:%x:%x:%x", &b[0], &b[1], &b[2], &b[3], &b[4], &b[5]) != 6) return -1;
    for (int i = 0; i < 6; i++) out[i] = (char) b[i];
    return 0;
}

/* a stable, locally administered id from wlan0's MAC, so it never matches CarPlay's */
static void default_mac(char *buf, size_t n) {
    char m[6] = { 0x02, 0x41, 0x50, 0x00, 0x00, 0x01 };
    FILE *f = fopen("/sys/class/net/wlan0/address", "r");
    char line[32];
    if (f && fgets(line, sizeof line, f) && parse_mac(line, m) == 0) m[0] = (char) ((m[0] | 0x02) ^ 0x40);
    if (f) fclose(f);
    snprintf(buf, n, "%02x:%02x:%02x:%02x:%02x:%02x", (uint8_t) m[0], (uint8_t) m[1], (uint8_t) m[2],
             (uint8_t) m[3], (uint8_t) m[4], (uint8_t) m[5]);
}

static void on_signal(int s) { quit = 1; }

/* -n auto: the name the car's Bluetooth shows ("BMW 12345", the VIN's last five digits), the same
 * name the iPhone already knows the car by; "BMW AirPlay" when it cannot be found */
static const char *car_name(void) {
    static char name[64] = "BMW AirPlay";
    FILE *p = popen("grep -rhoasE 'BMW [0-9]{5}' /var/opt/public/con 2>/dev/null | head -1", "r");
    char line[64];
    if (p && fgets(line, sizeof line, p)) {
        line[strcspn(line, "\r\n")] = 0;
        if (strlen(line) == 9) snprintf(name, sizeof name, "%s", line);
    }
    if (p) pclose(p);
    return name;
}

/* ---- the car's firewall ----
 * On the car's Wi-Fi (wlan_bridge) the head unit's nft input chain lets in a fixed list of ports and
 * drops the rest, so ours are opened while AirPlay is on and closed again when it goes off. Runtime
 * rules only (a restart drops them), found again by their comment. */
static void fw_set(bool open) {
    if (system("nft -a list table ip filter 2>/dev/null | grep -q 'comment \"airplay-rx\"'") == 0) {
        int r = system("for c in input output; do nft -a list chain ip filter $c 2>/dev/null | "
                       "sed -n 's/.*comment \"airplay-rx\".*# handle \\([0-9]*\\).*/\\1/p' | "
                       "while read h; do nft delete rule ip filter $c handle $h; done; done");
        (void) r;
    }
    if (!open) return;
    int r = system("nft insert rule ip filter input iifname \"wlan_bridge\" tcp dport { 7100, 7101 } accept comment \"airplay-rx\" && "
                   "nft insert rule ip filter input iifname \"wlan_bridge\" udp dport { 6100, 6101, 7111 } accept comment \"airplay-rx\" && "
                   "nft insert rule ip filter output oifname \"wlan_bridge\" udp sport { 6100, 6101, 7111 } accept comment \"airplay-rx\"");
    if (r != 0) LOGE("could not open the firewall for AirPlay (nft exit %d)", r);
}

/* ---- the iDrive app ----
 * The app (package name opt_app) touches data/mirror.json in its folder about once a second while
 * one of its screens is up; AirPlay is on while that file is under 5 s old. The folder is found
 * by the package name, as the app's uid (oap_<uid>) is given at install. */
static char ctl_path[512] = "";
static bool app_wants(void) {
    struct stat st;
    if (!ctl_path[0] || stat(ctl_path, &st) != 0) {
        static time_t last_scan = 0;
        time_t t = time(NULL);
        if (t - last_scan < 10) return false;
        last_scan = t;
        ctl_path[0] = 0;
        FILE *p = popen("grep -l '\"name\": *\"' /var/opt/public/oap/oap_*/source/package.json 2>/dev/null", "r");
        char line[512];
        while (p && fgets(line, sizeof line, p)) {
            line[strcspn(line, "\n")] = 0;
            FILE *f = fopen(line, "r");
            char buf[4096]; size_t n = f ? fread(buf, 1, sizeof buf - 1, f) : 0;
            if (f) fclose(f);
            buf[n] = 0;
            char want[160]; snprintf(want, sizeof want, "\"%s\"", opt_app);
            char *k = strstr(buf, "\"name\"");
            if (k && strstr(k, want) && strstr(k, want) < k + 40) {
                char *s = strstr(line, "/source/package.json");
                if (s) { *s = 0; snprintf(ctl_path, sizeof ctl_path, "%s/data/mirror.json", line); LOGI("app control file %s", ctl_path); }
                break;
            }
        }
        if (p) pclose(p);
        if (!ctl_path[0] || stat(ctl_path, &st) != 0) return false;
    }
    return time(NULL) - st.st_mtime < 5;
}

/* ---- status for the app: /dev/shm/mgu-airplay-status.json ---- */
static void write_status(bool on) {
    const char *path = "/dev/shm/mgu-airplay-status.json", *tmp = "/dev/shm/.mgu-airplay-status.tmp";
    FILE *f = fopen(tmp, "w");
    if (!f) return;
    char name[160]; size_t j = 0;
    for (size_t i = 0; client_name[i] && j < sizeof name - 2; i++) if (client_name[i] != '"' && client_name[i] != '\\' && (unsigned char) client_name[i] >= 0x20) name[j++] = client_name[i];
    name[j] = 0;
    fprintf(f, "{\"on\":%s,\"name\":\"%s\",\"client\":\"%s\",\"connections\":%d,\"mirroring\":%s,\"w\":%d,\"h\":%d,\"fps\":%.1f,\"file\":\"%s\"}\n",
            on ? "true" : "false", opt_name, name, open_connections, mirroring ? "true" : "false", vf.w, vf.h, last_fps, opt_out);
    fclose(f);
    chmod(tmp, 0644);
    rename(tmp, path);
}

int main(int argc, char **argv) {
    int c;
    while ((c = getopt(argc, argv, "a:An:o:m:k:W:H:f:sd")) != -1) {
        switch (c) {
        case 'n': opt_name = optarg; break;
        case 'o': opt_out = optarg; break;
        case 'm': opt_mac = optarg; break;
        case 'k': opt_key = optarg; break;
        case 'W': opt_w = atoi(optarg); break;
        case 'H': opt_h = atoi(optarg); break;
        case 'f': opt_fps = atoi(optarg); break;
        case 's': opt_sw = true; break;
        case 'd': opt_debug = true; break;
        case 'a': opt_app = optarg; break;
        case 'A': opt_noaudio = true; break;
        default: fprintf(stderr, "usage: %s [-a app-package] [-n name] [-o file] [-m mac] [-k keyfile] [-W w -H h] [-f fps] [-s] [-d]\n", argv[0]); return 2;
        }
    }
    setvbuf(stderr, NULL, _IOLBF, 0);
    if (strcmp(opt_name, "auto") == 0) opt_name = car_name();
    signal(SIGINT, on_signal); signal(SIGTERM, on_signal); signal(SIGPIPE, SIG_IGN);
    av_log_set_level(opt_debug ? AV_LOG_INFO : AV_LOG_ERROR);
    avcodec_register_all();
    frm = av_frame_alloc(); swf = av_frame_alloc();
    clock_gettime(CLOCK_MONOTONIC, &t_stat);

    char macbuf[24];
    if (!opt_mac) { default_mac(macbuf, sizeof macbuf); opt_mac = macbuf; }
    char hw[6];
    if (parse_mac(opt_mac, hw) != 0) { LOGE("bad device id %s", opt_mac); return 2; }

    int err = 0;
    dnssd_t *dnssd = dnssd_init(opt_name, (int) strlen(opt_name), hw, 6, 0, &err);
    if (err || !dnssd) { LOGE("dnssd_init failed (%d): is mdnsd reachable (/run/mdnsd/mdnsd_uds)?", err); return 1; }
    /* UxPlay's feature set for screen mirroring without HLS video */
    static const int feat[32] = { 0,1,1,0, 0,1,1,1, 0,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,0, 0,1,0,1, 1,0,1,0 };
    for (int i = 0; i < 32; i++) dnssd_set_airplay_features(dnssd, i, feat[i]);
    /* video only (-A, or the file /var/opt/airplay/noaudio): no audio features, no AirTunes service,
       so the phone may keep its sound on its own output (Bluetooth to the car) while it mirrors */
    if (opt_noaudio || access("/var/opt/airplay/noaudio", F_OK) == 0) {
        opt_noaudio = true;
        static const int audio_bits[] = { 9, 10, 11, 17, 18, 19, 20, 21 };
        for (size_t i = 0; i < sizeof audio_bits / sizeof audio_bits[0]; i++) dnssd_set_airplay_features(dnssd, audio_bits[i], 0);
        LOGI("video only: no audio advertised");
    }

    raop_callbacks_t cbs; memset(&cbs, 0, sizeof cbs);
    cbs.video_process = cb_video_process; cbs.audio_process = cb_audio_process;
    cbs.video_pause = cb_video_pause; cbs.video_resume = cb_video_resume;
    cbs.conn_feedback = cb_conn_feedback; cbs.conn_reset = cb_conn_reset; cbs.video_reset = cb_video_reset;
    cbs.video_set_codec_and_size = cb_set_codec_and_size;
    cbs.conn_init = cb_conn_init; cbs.conn_destroy = cb_conn_destroy;
    cbs.audio_flush = cb_audio_flush; cbs.video_flush = cb_video_flush;
    cbs.audio_set_client_volume = cb_get_client_volume; cbs.audio_set_volume = cb_set_volume;
    cbs.audio_set_metadata = cb_set_metadata; cbs.audio_set_coverart = cb_set_coverart;
    cbs.audio_stop_coverart_rendering = cb_stop_coverart; cbs.audio_remote_control_id = cb_remote_control_id;
    cbs.audio_set_progress = cb_set_progress; cbs.audio_get_format = cb_audio_get_format;
    cbs.mirror_video_running = cb_mirror_running; cbs.report_client_request = cb_report_client;
    cbs.display_pin = cb_display_pin; cbs.register_client = cb_register_client;
    cbs.check_register = cb_check_register; cbs.passwd = cb_passwd; cbs.export_dacp = cb_export_dacp;
    cbs.on_video_play = cb_on_video_play; cbs.on_video_scrub = cb_on_video_scrub;
    cbs.on_video_rate = cb_on_video_rate; cbs.on_video_stop = cb_on_video_stop;
    cbs.on_video_acquire_playback_info = cb_on_video_info; cbs.on_video_playlist_remove = cb_on_playlist_remove;
    cbs.get_custom_profile = cb_custom_profile;

    raop_t *raop = raop_init(&cbs);
    if (!raop) { LOGE("raop_init failed"); return 1; }
    raop_set_log_callback(raop, raop_log, NULL);
    raop_set_log_level(raop, opt_debug ? LOGGER_DEBUG : LOGGER_INFO);
    if (raop_init2(raop, 1, opt_mac, opt_key)) { LOGE("raop_init2 failed (keyfile %s)", opt_key); return 1; }
    raop_set_plist(raop, "width", opt_w);
    raop_set_plist(raop, "height", opt_h);
    raop_set_plist(raop, "refreshRate", 60);
    raop_set_plist(raop, "maxFPS", opt_fps);
    /* CarPlay's own AirPlay server holds 7000 on the head unit; the phone finds ours through mDNS */
    unsigned short tcp[2] = { 7100, 7101 }, udp[3] = { 7111, 6101, 6100 };
    raop_set_tcp_ports(raop, tcp);
    raop_set_udp_ports(raop, udp);
    unsigned short port = raop_get_port(raop);
    if (raop_start_httpd(raop, &port) < 0) { LOGE("httpd start failed"); return 1; }
    raop_set_port(raop, port);
    raop_set_dnssd(raop, dnssd);
    LOGI("\"%s\" ready on port %u, device id %s, %dx%d%s", opt_name, port, opt_mac, opt_w, opt_h,
         opt_app ? "; on while the app is open" : "; always on (no -a)");
    fw_set(false);                              /* rules a crash left behind */
    bool on = false;
    struct timespec t_ctl = { 0, 0 };

    while (!quit) {
        /* on while the app says so (its control file fresh), or always without -a */
        struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);
        if (now.tv_sec - t_ctl.tv_sec >= 1) {
            t_ctl = now;
            bool want = opt_app ? app_wants() : true;
            if (want != on) {
                on = want;
                if (on) {
                    fw_set(true);
                    if ((!opt_noaudio && dnssd_register_raop(dnssd, port)) || dnssd_register_airplay(dnssd, port)) LOGE("mDNS registration failed");
                    LOGI("on: advertising \"%s\"", opt_name);
                } else {
                    dnssd_unregister_airplay(dnssd); dnssd_unregister_raop(dnssd);
                    fw_set(false);
                    if (open_connections > 0) reset_httpd = 1;      /* drop the phone */
                    LOGI("off");
                }
            }
            write_status(on);
        }
        struct pollfd pf[2]; int n = 0, svc[2];
        for (int s = 0; s < 2; s++) {
            int fd = dnssd_get_service_fd(dnssd, s);
            if (fd >= 0) { pf[n].fd = fd; pf[n].events = POLLIN; svc[n++] = s; }
        }
        int r = poll(pf, n, 500);
        for (int i = 0; r > 0 && i < n; i++)
            if (pf[i].revents & POLLIN) dnssd_process_service(dnssd, svc[i]);
        if (reset_httpd) {
            reset_httpd = 0;
            LOGI("restarting the AirPlay server");
            raop_stop_httpd(raop);
            raop_remove_known_connections(raop);
            port = raop_get_port(raop);
            raop_start_httpd(raop, &port);
            raop_set_port(raop, port);
        }
    }
    LOGI("stopping");
    dnssd_unregister_airplay(dnssd); dnssd_unregister_raop(dnssd);
    fw_set(false);
    write_status(false);
    raop_destroy(raop); dnssd_destroy(dnssd);
    vf_close(); unlink(opt_out);
    return 0;
}
