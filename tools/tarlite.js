'use strict';
/**
 * tarlite.js - just enough tar (ustar) + gzip for the Store's packages, no modules.
 *
 *   read(buf)            -> [{ name, mode, data, type }]  (a .tgz or .tar)
 *   write(entries, mtime) -> Buffer (.tgz): members owned 0:0, sorted as given
 */
const zlib = require('zlib');

function read(buf) {
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    const out = [];
    let off = 0, longName = null;
    while (off + 512 <= buf.length) {
        const h = buf.slice(off, off + 512);
        if (h.every((b) => b === 0)) break;
        const str = (a, n) => h.slice(a, a + n).toString('utf8').replace(/\0.*$/s, '');
        let name = str(0, 100);
        const prefix = str(345, 155);
        if (prefix) name = prefix + '/' + name;
        const mode = parseInt(str(100, 8).trim() || '0', 8);
        const size = parseInt(str(124, 12).trim() || '0', 8);
        const type = String.fromCharCode(h[156] || 48);
        const data = buf.slice(off + 512, off + 512 + size);
        off += 512 + Math.ceil(size / 512) * 512;
        if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
        if (longName) { name = longName; longName = null; }
        if (type === 'x' || type === 'g') continue;          // pax headers: not needed here
        out.push({ name, mode, data, type: type === '5' ? 'dir' : 'file' });
    }
    return out;
}

function header(name, mode, size, mtime, type) {
    const h = Buffer.alloc(512);
    const put = (s, a, n) => h.write(s, a, Math.min(Buffer.byteLength(s), n), 'utf8');
    const oct = (v, n) => v.toString(8).padStart(n - 1, '0') + '\0';
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
        const i = name.lastIndexOf('/', 154);
        prefix = name.slice(0, i); name = name.slice(i + 1);
        if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error('name too long: ' + prefix + '/' + name);
    }
    put(name, 0, 100); put(oct(mode, 8), 100, 8); put(oct(0, 8), 108, 8); put(oct(0, 8), 116, 8);
    put(oct(size, 12), 124, 12); put(oct(mtime, 12), 136, 12); h.fill(0x20, 148, 156);
    h[156] = type === 'dir' ? 53 : 48; put('ustar\0', 257, 6); put('00', 263, 2);
    put('root', 265, 32); put('root', 297, 32); if (prefix) put(prefix, 345, 155);
    let sum = 0; for (const b of h) sum += b;
    put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    return h;
}

function write(entries, mtime) {
    const parts = [];
    for (const e of entries) {
        const data = e.type === 'dir' ? Buffer.alloc(0) : e.data;
        parts.push(header(e.name, e.mode, data.length, mtime || 1767225600, e.type));
        parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    parts.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}

module.exports = { read, write };
