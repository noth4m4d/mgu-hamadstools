'use strict';
/**
 * crop.js - cut a rect out of a saved frame, scaled, as the cluster would get it (development only).
 *
 *   node crop.js <frame.rgb> <out.png> <x> <y> <w> <h> <scale> [radius=0]
 */
const fs = require('fs');
const card = require('../src/card');
const { writePng } = require('./png');

const a = process.argv.slice(2);
if (a.length < 7) { console.error('usage: node crop.js <frame.rgb> <out.png> <x> <y> <w> <h> <scale> [radius]'); process.exit(2); }
const [src, out] = a;
const [x, y, w, h, scale, radius = 0] = a.slice(2).map(Number);
const img = card.composeRect(fs.readFileSync(src), { x, y, w, h }, scale, radius);
writePng(out, img.w, img.h, img.rgba);
console.log(`${out}: ${img.w}x${img.h}`);
