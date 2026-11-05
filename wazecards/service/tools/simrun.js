'use strict';
/**
 * simrun.js - run the real service loop on the PC against saved frames and a fake cluster-render
 * client, through a script of app settings, and check the layers it makes (development only).
 *
 *   node simrun.js <full-screen frame.rgb> <Dashboard frame.rgb>
 *
 * Exits 1 when any check fails.
 */
const fs = require('fs');
const svc = require('../src/wazecard');

const [fullFile, dashFile] = process.argv.slice(2);
if (!fullFile || !dashFile) { console.error('usage: node simrun.js <full.rgb> <dash.rgb>'); process.exit(2); }
const FULL = fs.readFileSync(fullFile), DASH = fs.readFileSync(dashFile), BLANK = Buffer.alloc(FULL.length);

/* a cluster-render client that only remembers what it was asked */
const layers = new Map();
let nextRef = 1, frames = 0, pixelWrites = 0;
class FakeClusterRender {
    constructor() { this.handlers = {}; }
    on(ev, fn) { this.handlers[ev] = fn; }
    connect() {}
    close() {}
    _add(kind, o) { const ref = nextRef++; layers.set(ref, Object.assign({ kind, visible: 1 }, o)); return ref; }
    image(o) { return this._add('image', o); }
    video(o) { return this._add('video', o); }
    set(ref, o) { Object.assign(layers.get(ref), o); }
    drop(ref) { layers.delete(ref); }
    pixels(ref, rects, px) { pixelWrites++; layers.get(ref).bytes = px.length; return true; }
    frame(ref, atlas) { frames++; layers.get(ref).frameBytes = atlas.length; return true; }
}

/* the script: each step is some turns of the loop with these settings and this frame */
const S = (o) => Object.assign({}, svc.APP_DEFAULTS, o);
const steps = [
    { name: 'cards, full screen', loops: 4, s: S({}), f: FULL },
    { name: 'cards, Dashboard', loops: 4, s: S({}), f: DASH },
    { name: 'map, full screen', loops: 4, s: S({ mode: 'map' }), f: FULL },
    { name: 'map, Dashboard', loops: 4, s: S({ mode: 'map' }), f: DASH },
    { name: 'map, turn small, ETA large', loops: 4, s: S({ mode: 'map', turnSize: 'small', etaSize: 'large' }), f: FULL },
    { name: 'map, arrival off', loops: 4, s: S({ mode: 'map', arrival: false }), f: FULL },
    { name: 'switched off', loops: 3, s: S({ mode: 'map', enabled: false }), f: FULL },
    { name: 'on again, cards', loops: 4, s: S({}), f: FULL },
    { name: 'Waze gone', loops: 8, s: S({}), f: BLANK },
];

/* the service calls app() once at the start of each turn of its loop: that moves the script on, and
 * a step is checked when the next one begins (or when the run ends) */
let step = 0, turn = 0, grabs = 0;
const ends = steps.reduce((a, s) => a.concat((a.length ? a[a.length - 1] : 0) + s.loops), []);
const tick = () => {
    turn++;
    let i = 0;
    while (i < steps.length - 1 && turn > ends[i]) i++;
    if (i !== step) { checks(steps[step]); step = i; }
    return steps[step].s;
};
const visible = () => [...layers.values()].filter((l) => l.visible !== false && l.visible !== 0);
const failures = [];
const expect = (cond, what) => { if (!cond) failures.push(`${steps[step].name}: ${what}`); };

function checks(st) {
    const v = visible();
    const imgs = v.filter((l) => l.kind === 'image'), vids = v.filter((l) => l.kind === 'video');
    const desc = v.map((l) => `${l.kind} ${l.target} ${l.w}x${l.h}@${l.x},${l.y}`).join('; ');
    console.log(`${st.name.padEnd(28)} -> ${desc || '(nothing shown)'}`);
    const P = svc.PRESETS;
    switch (st.name) {
        case 'cards, full screen':
            expect(vids.length === 0, 'no map in cards mode');
            expect(imgs.length === 2 && imgs.every((l) => l.target === 'panel'), 'two cards on the panel');
            expect(imgs.some((l) => l.w === Math.round(654 * P.cards.turn.medium.scale) && l.y === 205), 'medium turn card at y 205');
            expect(imgs.some((l) => l.y === P.cards.arrival.medium.y), 'arrival card at its medium place');
            break;
        case 'cards, Dashboard':
            expect(imgs.length === 2 && imgs.every((l) => l.target === 'panel'), 'Dashboard cards on the panel');
            expect(imgs.some((l) => l.h === Math.round(343 * P.cards.dashTurn.medium.scale)), 'Dashboard card with its then strip');
            break;
        case 'map, full screen':
        case 'map, Dashboard':
            expect(vids.length === 1 && vids[0].target === 'map' && vids[0].contend === 1, 'one map video on the map area, contending');
            expect(imgs.length === 2 && imgs.every((l) => l.target === 'map' && l.y === 12), 'two cards along the top of the map area');
            expect(imgs.some((l) => l.x === 12), 'a card at the left');
            expect(imgs.some((l) => l.x + l.w === 1088 - 12), 'a card at the right');
            expect(![...layers.values()].some((l) => l.target === 'panel'), 'nothing left on the panel');
            break;
        case 'map, turn small, ETA large':
            expect(imgs.some((l) => l.x === 12 && l.w === Math.round(654 * P.map.turn.small.scale)), 'small turn card');
            expect(imgs.some((l) => l.w === Math.round(652 * P.map.arrival.large.scale)), 'large arrival card');
            break;
        case 'map, arrival off':
            expect(imgs.length === 1 && imgs[0].x === 12, 'only the turn card');
            expect(vids.length === 1, 'map still shown');
            break;
        case 'switched off':
            expect(layers.size === 0, 'every layer dropped');
            break;
        case 'on again, cards':
            expect(imgs.length === 2 && imgs.every((l) => l.target === 'panel') && vids.length === 0, 'cards back on the panel');
            break;
        case 'Waze gone':
            expect(v.length === 0, 'nothing shown once Waze has gone');
            break;
        default:
    }
}

svc.run({
    loops: ends[ends.length - 1],
    ClusterRender: FakeClusterRender,
    sleep: () => Promise.resolve(),
    app: tick,
    grab: () => { grabs++; return Promise.resolve(steps[step].f); },
}).then(() => {
    checks(steps[step]);                         // the last step
    console.log(`\nframes grabbed ${grabs}, map frames sent ${frames}, card image writes ${pixelWrites}`);
    if (failures.length) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
    console.log('all checks passed');
    process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
