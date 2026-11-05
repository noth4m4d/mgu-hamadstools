// mdnsq.js - ask mDNS on the car's Wi-Fi what is advertised for AirPlay, and which addresses
// the SRV target resolves to (Node 8, no modules). node mdnsq.js [iface-ip] [name]
'use strict';
const dgram = require('dgram');
const IFACE = process.argv[2] || '172.16.222.97';
const NAMES = [process.argv[3] || '_airplay._tcp.local', '_raop._tcp.local'];
const T = { 1: 'A', 12: 'PTR', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 47: 'NSEC' };

function enc(name, type) {
    const parts = name.split('.').filter(Boolean);
    const b = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for (const p of parts) { b.push(p.length); for (const ch of Buffer.from(p)) b.push(ch); }
    b.push(0, 0, type, 0x00, 1);
    return Buffer.from(b);
}
function readName(buf, off) {
    const labels = []; let jumped = false, end = off;
    for (let guard = 0; guard < 64; guard++) {
        const len = buf[off];
        if (len === 0) { if (!jumped) end = off + 1; break; }
        if ((len & 0xc0) === 0xc0) { if (!jumped) end = off + 2; off = ((len & 0x3f) << 8) | buf[off + 1]; jumped = true; continue; }
        labels.push(buf.toString('utf8', off + 1, off + 1 + len)); off += 1 + len;
    }
    return [labels.join('.'), end];
}
function parse(buf, from) {
    const qd = buf.readUInt16BE(4), n = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
    let off = 12;
    for (let i = 0; i < qd; i++) { off = readName(buf, off)[1] + 4; }
    for (let i = 0; i < n && off < buf.length; i++) {
        const [name, o2] = readName(buf, off); off = o2;
        const type = buf.readUInt16BE(off), rdlen = buf.readUInt16BE(off + 8); off += 10;
        const rd = buf.slice(off, off + rdlen); let val = '';
        if (type === 1) val = Array.from(rd).join('.');
        else if (type === 28) val = rd.toString('hex').replace(/(.{4})/g, '$1:').slice(0, -1);
        else if (type === 12) val = readName(buf, off)[0];
        else if (type === 33) val = 'port ' + rd.readUInt16BE(4) + ' -> ' + readName(buf, off + 6)[0];
        else if (type === 16) { const t = []; let p = 0; while (p < rd.length) { t.push(rd.toString('utf8', p + 1, p + 1 + rd[p])); p += 1 + rd[p]; } val = t.join(' | '); }
        console.log(`${from}  ${T[type] || type}  ${name}  ${val}`);
        off += rdlen;
    }
}
const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
s.on('message', (m, r) => { try { parse(m, r.address); } catch (e) { } });
// listen on 5353 for the multicast answers too (mdnsd answers its own host's queries by multicast)
s.bind(5353, () => {
    try { s.addMembership('224.0.0.251', IFACE); } catch (e) { console.log('membership: ' + e.message); }
    s.setMulticastInterface(IFACE);
    s.setMulticastLoopback(true);
    for (const n of NAMES) s.send(enc(n, 12), 5353, '224.0.0.251');
    setTimeout(() => s.send(enc('mgu.local', 1), 5353, '224.0.0.251'), 300);
    setTimeout(() => s.send(enc('mgu.local', 28), 5353, '224.0.0.251'), 400);
    setTimeout(() => process.exit(0), 2500);
});
