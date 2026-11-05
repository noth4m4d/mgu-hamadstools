'use strict';
/**
 * wazecard - Waze's turn and arrival cards, or Waze's map with them, on the instrument cluster.
 *
 * Grabs the central screen with winston-grabber a few times a second, finds Waze's cards (card.js)
 * and draws them on the cluster through cluster-render. Two modes, picked in the Waze Cards app:
 *   cards  the cards over the cluster (cluster-render's `panel` target). The cluster hides the right
 *          gauge's inner info while this target is shown.
 *   map    Waze's map in the cluster's map area (the `map` target, instead of BMW's map), the turn
 *          card top-left and the arrival card top-right on it. Shown only in the cluster's map view.
 * Nothing is sent to CarPlay, the navigation service or the HMI: it only reads the screen and draws.
 * Node 8, runs as root (winston-grabber needs the compositor's socket).
 *
 *   node wazecard.js [--once]      --once: one frame, print what was found, exit
 *
 * Settings: the Waze Cards app (wzc_wazecards) saves them in its data/settings.json; without the app
 * the defaults below apply. /var/opt/wazecard/wazecard.json can change the timing (DEFAULTS).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const card = require('./card');

const DEFAULTS = {
    fps: 4,                         // frames grabbed per second
    showAfter: 2,                   // frames with the cards before they show
    hideAfter: 6,                   // frames without them before they hide (rides through Waze's animations)
    dropAfterMs: 10000,             // hidden this long: give the cluster area back
    clientPath: '/var/opt/cluster-render/current/cluster_render_client.js',
    frameFile: '/tmp/wazecard/frame.rgb',
    appsDir: '/var/opt/public/oap',
};
const CONFIG = Object.assign({}, DEFAULTS, readJson('/var/opt/wazecard/wazecard.json'));

const APP_ID = 'wzc_wazecards';
const APP_DEFAULTS = { enabled: true, mode: 'cards', turnSize: 'medium', etaSize: 'medium', arrival: true };

/*
 * Each card's size (scale, relative to the central screen) and place, per mode and app size setting.
 * cards: on the 1920x720 panel, centred; the arrival card between the cursor and the road name.
 * map: on the 1088x480 map area, 12 px in from its top corners.
 */
const PRESETS = {
    cards: {
        turn: { small: { scale: 0.6, y: 205 }, medium: { scale: 0.7, y: 205 }, large: { scale: 0.8, y: 200 } },
        arrival: { small: { scale: 0.53, y: 563 }, medium: { scale: 0.62, y: 549 }, large: { scale: 0.7, y: 540 } },
        dashTurn: { small: { scale: 0.55, y: 205 }, medium: { scale: 0.63, y: 205 }, large: { scale: 0.72, y: 200 } },
        dashEta: { small: { scale: 0.5, y: 577 }, medium: { scale: 0.6, y: 575 }, large: { scale: 0.7, y: 570 } },
    },
    map: {
        turn: { small: { scale: 0.5 }, medium: { scale: 0.6 }, large: { scale: 0.7 } },
        arrival: { small: { scale: 0.42 }, medium: { scale: 0.5 }, large: { scale: 0.58 } },
        dashTurn: { small: { scale: 0.47 }, medium: { scale: 0.55 }, large: { scale: 0.63 } },
        dashEta: { small: { scale: 0.42 }, medium: { scale: 0.5 }, large: { scale: 0.58 } },
    },
};
const PANEL_W = 1920, MAP_MARGIN = 12;

const ENV = Object.assign({}, process.env, { WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/wayland' });
const LOG_FILE = '/var/opt/wazecard/wazecard.log';
const LOG_MAX = 256 * 1024;      // then it becomes wazecard.log.1 and a new one starts

/* stdout (the journal, where the unit has one) and LOG_FILE, which this unit's journal doesn't reach */
function log(s) {
    const line = `${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${s}\n`;
    process.stdout.write(line);
    try {
        if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
        fs.appendFileSync(LOG_FILE, line);
    } catch (e) { /* logging must never stop the cards */ }
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}

/* ---------------- the Waze Cards app's settings ---------------- */

/**
 * The app's settings, read again when its settings.json changes. The app's folder is found by its
 * package name (the app manager picks the folder's uid), looked for again every 30 s while missing.
 */
function appSettings() {
    let file = null, lookedAt = 0, mtime = -1, current = Object.assign({}, APP_DEFAULTS);
    const find = () => {
        lookedAt = Date.now();
        let dirs = [];
        try { dirs = fs.readdirSync(CONFIG.appsDir).filter((d) => d.indexOf('oap_') === 0); } catch (e) { return null; }
        for (const d of dirs) {
            // installed apps keep package.json in source/ (oap_<uid>/source/package.json)
            const pkg = readJson(path.join(CONFIG.appsDir, d, 'source', 'package.json'));
            const top = readJson(path.join(CONFIG.appsDir, d, 'package.json'));
            if (pkg.name === APP_ID || top.name === APP_ID) return path.join(CONFIG.appsDir, d, 'data', 'settings.json');
        }
        return null;
    };
    return () => {
        if (!file && Date.now() - lookedAt > 30000) {
            file = find();
            if (file) log(`app settings: ${file}`);
        }
        if (!file) return current;
        let m = 0;
        try { m = fs.statSync(file).mtimeMs; } catch (e) { m = 0; }      // not saved yet: the defaults
        if (m !== mtime) {
            mtime = m;
            const s = Object.assign({}, APP_DEFAULTS, m ? readJson(file) : {});
            if (JSON.stringify(s) !== JSON.stringify(current)) log(`settings: ${JSON.stringify(s)}`);
            current = s;
        }
        return current;
    };
}

/* ---------------- the frame ---------------- */

/* the frame's folder (Node 8 has no recursive mkdir; its parent, /tmp, always exists) */
function frameDir() {
    try { fs.mkdirSync(path.dirname(CONFIG.frameFile)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

const FRAME_BYTES = card.SCREEN.w * card.SCREEN.h * 4;
const FRAME = Buffer.alloc(FRAME_BYTES);     // every frame is read into this one buffer: a new 5.5 MB
                                             // buffer per frame left Node 8 holding over 100 MB

/**
 * One frame of the central screen (BGRA) through file, or null when the grab fails. The frame is
 * FRAME, overwritten by the next grab: copy it to keep it.
 */
function grab(file) {
    return new Promise((resolve) => {
        execFile('winston-grabber', ['-s', 'center', file], { env: ENV, timeout: 3000 }, (err) => {
            if (err) return resolve(null);
            fs.open(file, 'r', (e, fd) => {
                if (e) return resolve(null);
                fs.read(fd, FRAME, 0, FRAME_BYTES, 0, (re, n) => {
                    fs.close(fd, () => {});
                    resolve(re || n !== FRAME_BYTES ? null : FRAME);
                });
            });
        });
    });
}

async function once() {
    frameDir();
    // a file of its own: the running service writes CONFIG.frameFile all the time
    const file = CONFIG.frameFile.replace(/\.rgb$/, '-once.rgb');
    const buf = await grab(file);
    if (!buf) { log('grab failed'); process.exit(1); }
    const t = card.hasTurn(buf), a = card.hasArrival(buf), d = card.hasDashboard(buf);
    log(`full screen: turn ${t.found}${t.rect ? ` at y ${t.rect.y}, ${t.rect.h} high` : ''} (black ${(t.black * 100).toFixed(0)}%, white ${(t.white * 100).toFixed(0)}%), ` +
        `arrival ${a.found} (panel ${(a.panel * 100).toFixed(0)}%, edges ${(a.edges * 100).toFixed(0)}%)`);
    log(`Dashboard: ${d.found}${d.found ? (d.then ? ', with then' : ', without then') : ''} ` +
        `(gap ${(d.gap * 100).toFixed(0)}%, card ${(d.panel * 100).toFixed(0)}%, pill ${(d.pill * 100).toFixed(0)}%)`);
    log(`app settings: ${JSON.stringify(appSettings()())}`);
    process.exit(0);
}

/* ---------------- layers ---------------- */

/**
 * One card's image layer: made when first shown, hidden when the card goes, dropped (the cluster
 * area given back) when it has stayed hidden for dropAfterMs. show(img, place) puts it at place
 * ({target, x, y}); a different size, place or target makes the layer again. Pixels go only when the
 * picture changed.
 */
function cardLayer(cr, name) {
    let ref = null, shown = false, hash = '', last = null, hiddenAt = 0, geom = '';
    const drop = () => { if (ref) cr.drop(ref); ref = null; hash = ''; last = null; shown = false; hiddenAt = 0; };
    return {
        show(img, place) {
            const g = `${place.target} ${img.w}x${img.h}@${place.x},${place.y}`;
            if (ref && g !== geom) { drop(); log(`${name} card now ${g}`); }
            const h = crypto.createHash('md5').update(img.rgba).digest('hex');
            if (!ref) {
                ref = cr.image({ target: place.target, klass: 'overlay', x: place.x, y: place.y, w: img.w, h: img.h, iw: img.w, ih: img.h });
                geom = g;
            } else if (!shown) {
                cr.set(ref, { visible: true });
            }
            if (h !== hash) { cr.pixels(ref, null, img.rgba); hash = h; last = img.rgba; }
            if (!shown) log(`${name} card shown (${g})`);
            shown = true; hiddenAt = 0;
        },
        hide() {
            if (shown && ref) { cr.set(ref, { visible: false }); log(`${name} card hidden`); hiddenAt = Date.now(); }
            shown = false;
            if (ref && hiddenAt && Date.now() - hiddenAt > CONFIG.dropAfterMs) drop();
        },
        resend() { if (ref && last) cr.pixels(ref, null, last); },
        drop,
        get shown() { return shown; },
    };
}

/**
 * Waze's map in the cluster's map area: a video layer on the `map` target that takes the slot from
 * BMW's map (contend) while shown, and gives it back when dropped.
 */
function mapLayer(cr) {
    let ref = null, shown = false, hiddenAt = 0, id = 0;
    const atlas = Buffer.alloc(card.MAP_ATLAS_BYTES);
    const drop = () => { if (ref) cr.drop(ref); ref = null; shown = false; hiddenAt = 0; };
    return {
        show(buf, rect) {
            if (!ref) {
                ref = cr.video({ target: 'map', klass: 'content', contend: 1, vw: card.MAP.w, vh: card.MAP.h, fps: 6 });
            } else if (!shown) {
                cr.set(ref, { visible: true });
            }
            cr.frame(ref, card.composeMap(buf, rect, atlas), ++id);
            if (!shown) log('map shown');
            shown = true; hiddenAt = 0;
        },
        hide() {
            if (shown && ref) { cr.set(ref, { visible: false }); log('map hidden'); hiddenAt = Date.now(); }
            shown = false;
            if (ref && hiddenAt && Date.now() - hiddenAt > CONFIG.dropAfterMs) drop();
        },
        drop,
    };
}

/* where a card goes: cards mode centred on the panel; map mode in a top corner of the map area */
function placeFor(mode, preset, img, corner) {
    if (mode === 'map') {
        return { target: 'map', y: MAP_MARGIN, x: corner === 'right' ? card.MAP.w - img.w - MAP_MARGIN : MAP_MARGIN };
    }
    return { target: 'panel', y: preset.y, x: Math.round((PANEL_W - img.w) / 2) };
}

/* ---------------- the loop ---------------- */

/**
 * The service. opts (tests only): grab(file) for frames, ClusterRender for the client class, app() for
 * the settings, loops to stop after that many turns of the loop, sleep(ms).
 */
async function run(opts) {
    opts = opts || {};
    if (!opts.grab) frameDir();
    const grabFrame = opts.grab || grab;
    const ClusterRender = opts.ClusterRender || require(CONFIG.clientPath).ClusterRender;
    const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const cr = new ClusterRender('wazecard');
    const turnLayer = cardLayer(cr, 'turn');
    const arrivalLayer = cardLayer(cr, 'arrival');
    const map = mapLayer(cr);
    const app = opts.app || appSettings();
    let seen = 0, missed = 0, stopping = false, failures = 0, view = '', mode = '', enabled = true, loops = 0;

    cr.on('layer', (ref, state, reason) => { if (state !== 'shown' && state !== 'hidden') log(`layer ${ref}: ${state}${reason ? ` (${reason})` : ''}`); });
    cr.on('target', (name, state, holder, reason) => { if (name === 'map') log(`map area: ${state}${holder ? `, held by ${holder}` : ''}${reason ? ` (${reason})` : ''}`); });
    cr.on('ready', () => { turnLayer.resend(); arrivalLayer.resend(); });
    cr.on('error', (e) => log(`cluster-render: ${e && e.message || e}`));
    cr.connect();

    const dropAll = () => { turnLayer.drop(); arrivalLayer.drop(); map.drop(); };
    const hideAll = () => { turnLayer.hide(); arrivalLayer.hide(); map.hide(); };
    const stop = () => {
        if (stopping) return;
        stopping = true;
        dropAll();
        if (!opts.loops) setTimeout(() => { cr.close(); process.exit(0); }, 300);
    };
    if (!opts.loops) {
        process.on('SIGTERM', stop);
        process.on('SIGINT', stop);
    }

    const period = 1000 / CONFIG.fps;
    log(`running: ${CONFIG.fps} fps`);
    while (!stopping) {
        if (opts.loops && ++loops > opts.loops) { stop(); break; }
        const t0 = Date.now();
        const s = app();

        // switched off in the app: nothing on the cluster, no grabs, look at the setting again in a second
        if (s.enabled === false) {
            if (enabled) { log('switched off in the app'); dropAll(); enabled = false; seen = 0; }
            await sleep(1000);
            continue;
        }
        if (!enabled) { log('switched on in the app'); enabled = true; }
        const m = s.mode === 'map' ? 'map' : 'cards';
        if (m !== mode) {
            if (mode) { log(`mode: ${m}`); dropAll(); }       // the two modes use different cluster slots
            mode = m; seen = 0;
        }
        const P = PRESETS[mode];
        const size = (k, key) => P[k][s[key]] || P[k].medium;

        const buf = await grabFrame(CONFIG.frameFile);
        if (!buf) {
            // no grab (screen off, compositor restarting): treat as no card, back off a little
            failures++;
            if (failures === 1 || failures % 60 === 0) log(`grab failed (${failures} in a row)`);
            missed++;
        } else {
            failures = 0;
            // Waze's full-screen map first, then CarPlay's Dashboard view
            const t = card.hasTurn(buf);
            const d = t.found ? null : card.hasDashboard(buf);
            const now = t.found ? 'full screen' : (d.found ? 'Dashboard' : '');
            if (now) {
                if (now !== view) { log(`view: ${now}`); view = now; }
                seen++; missed = 0;
                if (seen >= CONFIG.showAfter) {
                    let turnImg, turnPre, arrImg = null, arrPre;
                    if (t.found) {
                        turnPre = size('turn', 'turnSize');
                        turnImg = card.composeTurn(buf, t.rect, turnPre.scale);
                        arrPre = size('arrival', 'etaSize');
                        if (s.arrival !== false && card.hasArrival(buf).found) arrImg = card.composeArrival(buf, arrPre.scale);
                    } else {
                        turnPre = size('dashTurn', 'turnSize');
                        turnImg = card.composeDashCard(buf, d, turnPre.scale);
                        arrPre = size('dashEta', 'etaSize');
                        if (s.arrival !== false) arrImg = card.composeDashEta(buf, d, arrPre.scale);
                    }
                    if (mode === 'map') {
                        // map mode is the map alone: the user found the cards over it too much
                        map.show(buf, t.found ? card.MAP.full : card.MAP.dash);
                        turnLayer.hide(); arrivalLayer.hide();
                    } else {
                        turnLayer.show(turnImg, placeFor(mode, turnPre, turnImg, 'left'));
                        if (arrImg) arrivalLayer.show(arrImg, placeFor(mode, arrPre, arrImg, 'right'));
                        else arrivalLayer.hide();
                    }
                }
            } else {
                // the first frame of each gap while the cards were showing: say why, keep the frame
                if (turnLayer.shown && missed === 0) {
                    log(`cards lost (${view}): turn black ${(t.black * 100).toFixed(1)}%; dashboard gap ${(d.gap * 100).toFixed(0)}%, ` +
                        `card ${(d.panel * 100).toFixed(0)}%, pill ${(d.pill * 100).toFixed(0)}%`);
                    if (!opts.grab) fs.writeFile(CONFIG.frameFile.replace(/\.rgb$/, '-lost.rgb'), Buffer.from(buf), () => {});
                }
                missed++; seen = 0;
            }
        }
        if (missed >= CONFIG.hideAfter) hideAll();
        const wait = Math.max(20, period - (Date.now() - t0)) + (failures ? Math.min(failures, 10) * 100 : 0);
        await sleep(wait);
    }
}

if (require.main === module) {
    (process.argv.includes('--once') ? once() : run()).catch((e) => { log(`fatal: ${e && e.stack || e}`); process.exit(1); });
}

module.exports = { run, PRESETS, APP_DEFAULTS };
