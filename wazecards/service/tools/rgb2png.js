'use strict';
/**
 * rgb2png.js - turn a raw winston-grabber frame into a PNG to look at (development only).
 *
 *   node rgb2png.js <frame.rgb> <out.png> [width=1920] [height=720]
 *
 * winston-grabber's *.rgb pipeline writes 4 bytes per pixel, BGRA, with no header.
 */
const fs = require('fs');
const { writePng, bgraToRgba } = require('./png');

const [src, out, w = '1920', h = '720'] = process.argv.slice(2);
if (!src || !out) {
    console.error('usage: node rgb2png.js <frame.rgb> <out.png> [width] [height]');
    process.exit(2);
}
const W = Number(w), H = Number(h);
const px = fs.readFileSync(src);
if (px.length !== W * H * 4) throw new Error(`expected ${W * H * 4} bytes for ${W}x${H}, got ${px.length}`);
writePng(out, W, H, bgraToRgba(px));
console.log(`wrote ${out} (${W}x${H})`);
