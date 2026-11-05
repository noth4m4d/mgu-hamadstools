'use strict';
/**
 * cards.js - write the cluster images of a saved frame's cards (development only).
 *
 *   node cards.js <frame.rgb> <out-dir> [turnScale=0.7] [arrivalScale=0.62]
 *
 * Full-screen Waze: turn.png and arrival.png. CarPlay's Dashboard view: dash-turn.png and
 * dash-eta.png. These are the images the service would send to the cluster.
 */
const fs = require('fs');
const path = require('path');
const card = require('../src/card');
const { writePng } = require('./png');

const [src, outDir, ts = '0.7', as = '0.62'] = process.argv.slice(2);
if (!src || !outDir) { console.error('usage: node cards.js <frame.rgb> <out-dir> [turnScale] [arrivalScale]'); process.exit(2); }
const buf = fs.readFileSync(src);
const out = (name, img) => { writePng(path.join(outDir, name), img.w, img.h, img.rgba); console.log(`${name} ${img.w}x${img.h}`); };

const t = card.hasTurn(buf);
if (t.found) {
    out('turn.png', card.composeTurn(buf, t.rect, Number(ts)));
    out('arrival.png', card.composeArrival(buf, Number(as)));
} else {
    const d = card.hasDashboard(buf);
    if (!d.found) { console.error('no cards in this frame'); process.exit(1); }
    out('dash-turn.png', card.composeDashCard(buf, d, Number(ts)));
    out('dash-eta.png', card.composeDashEta(buf, d, Number(as)));
}
