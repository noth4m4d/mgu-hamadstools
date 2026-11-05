'use strict';
/**
 * maptest.js - check the map conversion on a saved frame (development only).
 *
 *   node maptest.js <frame.rgb> <out.png> <full|dash>
 *
 * Converts the map crop to cluster-render's 4:2:0 atlas as the service does, times it, and decodes the
 * atlas back to RGB (BT.601 full range) into out.png, to see what the cluster's map area would get.
 */
const fs = require('fs');
const card = require('../src/card');
const { writePng } = require('./png');

const [src, out, view = 'full'] = process.argv.slice(2);
if (!src || !out) { console.error('usage: node maptest.js <frame.rgb> <out.png> <full|dash>'); process.exit(2); }
const buf = fs.readFileSync(src);
const rect = card.MAP[view];
const atlas = Buffer.alloc(card.MAP_ATLAS_BYTES);

card.composeMap(buf, rect, atlas);                  // the first run builds the tables
const N = 20, t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) card.composeMap(buf, rect, atlas);
console.log(`composeMap (${view}): ${(Number(process.hrtime.bigint() - t0) / 1e6 / N).toFixed(1)} ms per frame on this PC`);

const W = card.MAP.w, H = card.MAP.h, C = W * H, half = W >> 1;
const rgba = Buffer.alloc(W * H * 4);
const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const Y = atlas[y * W + x];
        const co = C + (y >> 1) * W + (x >> 1);
        const U = atlas[co] - 128, V = atlas[co + half] - 128;
        const o = (y * W + x) * 4;
        rgba[o] = clamp(Math.round(Y + 1.402 * V));
        rgba[o + 1] = clamp(Math.round(Y - 0.344136 * U - 0.714136 * V));
        rgba[o + 2] = clamp(Math.round(Y + 1.772 * U));
        rgba[o + 3] = 255;
    }
}
writePng(out, W, H, rgba);
console.log(`wrote ${out} (${W}x${H}), atlas ${atlas.length} bytes`);
