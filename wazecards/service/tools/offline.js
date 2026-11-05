'use strict';
/**
 * offline.js - check card.js against saved frames on the PC (development only).
 *
 *   node offline.js <out-dir> <frame.rgb> [...] [--skip <frame.rgb> ...] [--dash <frame.rgb> ...]
 *
 *   frames         Waze's full-screen map: both cards found, no Dashboard
 *   --skip frames  full screen, turn card in the middle of Waze's slide: arrival found, no turn card
 *   --dash frames  CarPlay's Dashboard view, navigating: the Dashboard card and ETA found (with the
 *                  "then" strip), no full-screen cards
 *
 * Detection must also refuse frames that can't match: black, white, and the first full-screen frame
 * with both cards painted over with map colour. Writes the cluster images of each frame that has
 * them (turn-1.png, arrival-1.png, dash-turn-1.png, dash-eta-1.png, ...). Exits 1 on any failure.
 */
const fs = require('fs');
const path = require('path');
const card = require('../src/card');
const { writePng } = require('./png');

const [outDir, ...args] = process.argv.slice(2);
const groups = { full: [], skip: [], dash: [] };
let into = 'full';
for (const a of args) {
    if (a === '--skip') into = 'skip';
    else if (a === '--dash') into = 'dash';
    else groups[into].push(a);
}
if (!outDir || !groups.full.length) {
    console.error('usage: node offline.js <out-dir> <frame.rgb> [...] [--skip <frame.rgb> ...] [--dash <frame.rgb> ...]');
    process.exit(2);
}
const { w: SW, h: SH } = card.SCREEN;
const load = (f) => {
    const b = fs.readFileSync(f);
    if (b.length !== SW * SH * 4) throw new Error(`${f}: not a 1920x720 BGRA frame`);
    return { name: path.basename(f), buf: b };
};

const fill = (bgr) => { const b = Buffer.alloc(SW * SH * 4); for (let i = 0; i < b.length; i += 4) { b[i] = bgr[0]; b[i + 1] = bgr[1]; b[i + 2] = bgr[2]; b[i + 3] = 255; } return b; };
const paintOver = (buf, r, bgr) => {
    const b = Buffer.from(buf);
    for (let y = Math.max(0, r.y - 2); y < Math.min(SH, r.y + r.h + 2); y++) for (let x = r.x - 2; x < r.x + r.w + 2; x++) {
        const i = (y * SW + x) * 4; b[i] = bgr[0]; b[i + 1] = bgr[1]; b[i + 2] = bgr[2];
    }
    return b;
};
const map = [45, 38, 33];   // the dark map colour, BGR
const first = load(groups.full[0]).buf;
const firstTurn = card.hasTurn(first).rect || card.DEFAULTS.turn;
const noCards = paintOver(paintOver(first, firstTurn, map), card.DEFAULTS.arrival, map);

const cases = []
    .concat(groups.full.map(load).map((f) => ({ name: f.name, buf: f.buf, turn: true, arrival: true, dash: false })))
    .concat(groups.skip.map(load).map((f) => ({ name: `${f.name} (mid-slide)`, buf: f.buf, turn: false, arrival: true, dash: false })))
    // arrival null: not checked. The full-screen arrival test can match the ETA pill here, which is
    // harmless: the service only asks for the full-screen arrival card when it found the full-screen turn card
    .concat(groups.dash.map(load).map((f) => ({ name: `${f.name} (Dashboard)`, buf: f.buf, turn: false, arrival: null, dash: true, then: true })))
    .concat([
        { name: 'black screen', buf: fill([0, 0, 0]), turn: false, arrival: false, dash: false },
        { name: 'white screen', buf: fill([255, 255, 255]), turn: false, arrival: false, dash: false },
        { name: 'cards painted out', buf: noCards, turn: false, arrival: false, dash: false },
    ]);

const pct = (v) => `${(v * 100).toFixed(1)}%`;
let failed = 0, n = 0;
for (const c of cases) {
    const t = card.hasTurn(c.buf), a = card.hasArrival(c.buf), d = card.hasDashboard(c.buf);
    const ok = t.found === c.turn && (c.arrival === null || a.found === c.arrival) && d.found === c.dash && (!c.dash || d.then === c.then);
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}: turn ${t.found}${t.rect ? ` at y ${t.rect.y}` : ''} (black ${pct(t.black)}); ` +
        `arrival ${a.found} (panel ${pct(a.panel)}); dashboard ${d.found}${d.found ? (d.then ? ' with then' : ' without then') : ''} ` +
        `(gap ${pct(d.gap)}, card ${pct(d.panel)}, pill ${pct(d.pill)}, eta text ${pct(d.etaText)})`);
    if (t.found || d.found) n++;
    if (t.found) {
        const turn = card.composeTurn(c.buf, t.rect, 0.7);
        writePng(path.join(outDir, `turn-${n}.png`), turn.w, turn.h, turn.rgba);
        const arr = card.composeArrival(c.buf, 0.45);
        writePng(path.join(outDir, `arrival-${n}.png`), arr.w, arr.h, arr.rgba);
        console.log(`      wrote turn-${n}.png (${turn.w}x${turn.h}), arrival-${n}.png (${arr.w}x${arr.h})`);
    }
    if (d.found) {
        const turn = card.composeRect(c.buf, d.card, 0.63, d.card.radius);
        writePng(path.join(outDir, `dash-turn-${n}.png`), turn.w, turn.h, turn.rgba);
        const eta = card.composeRect(c.buf, d.eta, 0.6, d.eta.radius);
        writePng(path.join(outDir, `dash-eta-${n}.png`), eta.w, eta.h, eta.rgba);
        console.log(`      wrote dash-turn-${n}.png (${turn.w}x${turn.h}), dash-eta-${n}.png (${eta.w}x${eta.h})`);
    }
}
process.exit(failed ? 1 : 0);
