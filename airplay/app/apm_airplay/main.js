'use strict';
/**
 * AirPlay - an iPhone's screen on the central display (AirPlay screen mirroring), parked only.
 *
 * The receiver is airplay-rx, a root service on the head unit (../../src/airplay-rx.c). This app:
 *   - keeps it on while one of its screens is up: it touches data/mirror.json about once a second;
 *     the service advertises "Car AirPlay" and opens its firewall ports while that file is fresh,
 *     and goes quiet (and drops the phone) a few seconds after the app closes;
 *   - shows the phone's picture: the service writes the decoded frames to a video file
 *     (/dev/shm/mgu-video-airplay, kit/renderd PROTOCOL.md "Video") and the kit renderer draws it
 *     on the GPU, newest frame each time, in the rectangle of this app's VIDEO op;
 *   - reads the service's status (/dev/shm/mgu-airplay-status.json) for the menu text.
 *
 * Screens: MAIN (menu: how to connect, the state, settings), SCREEN (the phone's picture).
 * While the car drives (setting "Parked only", on by default) SCREEN shows a notice instead.
 *
 * Author: h4m4d.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const Parked = require('./kit/parked');

const W = 1600, H = 520, VIDEO_ID = 1;
const STATUS = '/dev/shm/mgu-airplay-status.json';
const M_VIDEO = 13, OP_VIDEO = 19;        // kit/renderd PROTOCOL.md: message VIDEO, draw op 19

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const parked = Parked.watch(ctx, log);
        const driving = () => settings.get('parkedOnly') !== false && parked.moving();

        /* ---------- keep the receiver on while a screen of ours is up ---------- */
        const ctl = path.join(ctx.dataDir, 'mirror.json');
        const up = () => ui.isVisible('MAIN') || ui.isVisible('SCREEN');
        setInterval(() => {
            if (!up()) return;
            try { fs.writeFileSync(ctl, JSON.stringify({ t: Date.now() })); } catch (e) { log.warn('mirror.json: ' + e.message); }
        }, 1000);

        /* ---------- the receiver's state ---------- */
        let st = null, stT = 0;
        function status() {
            try {
                const s = fs.statSync(STATUS);
                st = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
                stT = s.mtime.getTime();
            } catch (e) { st = null; }
            if (st && Date.now() - stT > 5000) st = Object.assign({}, st, { stale: true });
            return st;
        }

        /* ---------- menu ---------- */
        let wasMirroring = false, mirrorT = 0, shownName = null;
        function menu() {
            const s = status();
            let info;
            // one short status line; the steps are their own rows below it (app.json STEP_1..3)
            if (!s || s.stale) info = 'Status: receiver not running';
            else if (s.mirroring) info = 'Status: mirroring ' + (s.client || 'the iPhone') + (s.fps ? ' · ' + Math.round(s.fps) + ' fps' : '') +
                (driving() ? ' · paused while driving' : '');
            else if (s.on) info = 'Status: ready, waiting for the iPhone';
            else info = 'Status: starting...';
            ui.text('MENU_INFO', info);
            // the name the phone lists (the service's -n: the car's Bluetooth name)
            if (s && s.name && s.name !== shownName) { shownName = s.name; ui.text('STEP_3', '3. Control Centre > Screen Mirroring > ' + s.name); }
            const m = !!(s && !s.stale && s.mirroring);
            if (m && !wasMirroring) mirrorT = Date.now();
            if (m && !wasMirroring && settings.get('autoShow') !== false && ui.isVisible('MAIN') && !driving()) ui.open('SCREEN');
            wasMirroring = m;
        }
        ui.onClick('BTN_SHOW', () => ui.open('SCREEN'));
        menu();
        setInterval(() => { if (up()) menu(); }, 1000);

        /* ---------- the video file, named to the renderer (again after a reconnect / new size) ---------- */
        let sentOn = null;
        function ensureVideo() {
            const gpu = ctx.display && ctx.display.gpu;
            if (!gpu || !gpu.ready || !gpu.native) return false;
            const file = (st && st.file) || '/dev/shm/mgu-video-airplay';
            // the renderer opens the file when told: tell it again once the file is there (or a new one)
            let ino = 0;
            try { ino = fs.statSync(file).ino; } catch (e) { return false; }
            const key = [gpu.sock && gpu.sock._handle && gpu.sock._handle.fd, gpu.connected, gpu.placement && gpu.placement.w, gpu.placement && gpu.placement.h, ino].join();
            if (sentOn !== key) {
                const id = Buffer.alloc(4); id.writeUInt32LE(VIDEO_ID, 0);
                const p = Buffer.concat([id, Buffer.from(file), Buffer.from([0])]);
                const b = Buffer.alloc(8 + p.length + ((4 - (p.length & 3)) & 3));
                b.writeUInt32LE(M_VIDEO, 0); b.writeUInt32LE(b.length - 8, 4); p.copy(b, 8);
                gpu._write(b);
                sentOn = key;
                log.info('video file ' + file + ' named to the renderer');
            }
            return true;
        }
        /* a VIDEO op in a kit Recorder: the newest frame fitted into x, y, w, h (aspect kept, centred) */
        function videoOp(r, x, y, w, h) {
            r._grow(7);
            const i = r.n;
            r.u[i] = OP_VIDEO; r.f[i + 1] = x; r.f[i + 2] = y; r.f[i + 3] = w; r.f[i + 4] = h; r.f[i + 5] = 0; r.u[i + 6] = VIDEO_ID;
            r.n += 7;
        }

        /* ---------- the phone's picture ---------- */
        function render() {
            const cv = ctx.canvas(W, H).clear('#000000');
            const s = st;
            const say = (t) => cv.text(t, W / 2, H / 2 + 10, 28, '#ffffff', { align: 'center', font: 'bold' });
            if (driving()) say('Parked only - the phone\'s screen shows again when you stop');
            else if (!s || s.stale) say('AirPlay receiver not running');
            else if (!s.mirroring) say('Waiting for the iPhone: Screen Mirroring > "' + s.name + '"');
            else if (!s.w) say('Connected to ' + (s.client || 'the iPhone') + ' - waiting for the picture');
            else if (typeof cv._grow === 'function' && ensureVideo()) {
                videoOp(cv, 0, 0, W, H);
                // for the first seconds of mirroring: where the sound goes (the receiver takes none,
                // so the iPhone plays it on its own output: Bluetooth to the car when chosen)
                if (Date.now() - mirrorT < 12000) {
                    const bw = 900, bh = 64, bx = (W - bw) / 2, by = H - bh - 16;
                    cv.roundRect(bx, by, bw, bh, 14, '#000000c8');
                    cv.text('Sound: on the iPhone choose BMW (Bluetooth) as the audio output', W / 2, by + 41, 24, '#ffffff', { align: 'center' });
                }
            } else say('The phone\'s picture needs the kit renderer (idrive7-renderd)');
            return ui.image('SCREEN_GFX', cv);
        }
        // the renderer redraws the picture itself for each new frame: 2 app frames a second keep it shown
        ctx.loop('SCREEN', 2, render);
        log.info('airplay app started');
    },
});
