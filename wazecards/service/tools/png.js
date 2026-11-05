'use strict';
/** png.js - write an 8-bit RGBA PNG (development tools only; no dependencies). */
const fs = require('fs');
const zlib = require('zlib');

const CRC = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
});

function crc32(buf) {
    let c = -1;
    for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}

/** rgba: w*h*4 bytes, RGBA order */
function writePng(file, w, h, rgba) {
    const raw = Buffer.alloc(h * (w * 4 + 1));     // a filter byte (0 = none) before each row
    for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    fs.writeFileSync(file, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]));
}

/** a BGRA frame as RGBA */
function bgraToRgba(px) {
    const out = Buffer.alloc(px.length);
    for (let i = 0; i < px.length; i += 4) { out[i] = px[i + 2]; out[i + 1] = px[i + 1]; out[i + 2] = px[i]; out[i + 3] = 255; }
    return out;
}

module.exports = { writePng, bgraToRgba };
