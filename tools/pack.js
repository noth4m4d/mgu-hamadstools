'use strict';
/**
 * pack.js - the Store packages of this repository into dist/.
 *
 *   node tools/pack.js tool airplay/tool     -> dist/airplay-rx@<v>.tgz   (a tool kit)
 *   node tools/pack.js app <built .tgz>       -> dist/<id>@<v>.tgz        (an app, without BMW's SDK)
 *
 * A tool kit is what mgu-store's deploy tool installs (its deploy/README.md, "Artifacts"):
 * component.json at the root ({id, kind, version, ..., files[{path, mode, sha256}], units[{name}],
 * enable, restart}), files/<path> and units/<name>, members owned 0:0, one mtime.
 *
 * An app is the package the idrive7-apps kit builds, with node_modules/oap-sdk taken out: BMW's
 * SDK is not redistributable, and the head unit makes the module from its own BMW apps
 * (mgu-store docs/PUBLISHING.md, "Releases").
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tar = require('./tarlite');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const MTIME = Number(process.env.SOURCE_DATE_EPOCH) || 1767225600;   // 2026-01-01: same tree, same bytes

function packTool(dir) {
    dir = path.resolve(dir);
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'component.json'), 'utf8'));
    const entries = [];
    const files = (c.files || []).map((f) => {
        const data = fs.readFileSync(path.resolve(dir, f.from));
        const mode = parseInt(f.mode || '0644', 8);
        entries.push({ name: 'files/' + f.path, mode, data, type: 'file' });
        return { path: f.path, mode: f.mode || '0644', sha256: sha(data) };
    });
    const units = (c.units || []).map((u) => {
        const data = Buffer.from(fs.readFileSync(path.resolve(dir, u.from), 'utf8').replace(/\r\n/g, '\n'));
        entries.push({ name: 'units/' + u.name, mode: 0o644, data, type: 'file' });
        return { name: u.name };
    });
    const out = Object.assign({}, c, { files, units });
    const manifest = Buffer.from(JSON.stringify(out, null, 2) + '\n');
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    entries.unshift({ name: 'component.json', mode: 0o644, data: manifest, type: 'file' });
    fs.mkdirSync(DIST, { recursive: true });
    const name = c.id + '@' + c.version + '.tgz';
    fs.writeFileSync(path.join(DIST, name), tar.write(entries, MTIME));
    return name;
}

function packApp(tgz) {
    const all = tar.read(fs.readFileSync(tgz));
    const keep = all.filter((e) => !/(^|\/)node_modules\/oap-sdk(\/|$)/.test(e.name));
    const pj = keep.find((e) => /^(package\/)?package\.json$/.test(e.name));
    if (!pj) throw new Error(tgz + ': no package.json');
    const p = JSON.parse(pj.data.toString('utf8'));
    const name = p.name + '@' + p.version + '.tgz';
    fs.mkdirSync(DIST, { recursive: true });
    fs.writeFileSync(path.join(DIST, name), tar.write(keep, MTIME));
    return name + ' (' + (all.length - keep.length) + ' SDK files left out)';
}

const [kind, arg] = process.argv.slice(2);
if (kind === 'tool' && arg) console.log('dist/' + packTool(arg));
else if (kind === 'app' && arg) console.log('dist/' + packApp(arg));
else { console.error('usage: node tools/pack.js tool <dir> | app <built.tgz>'); process.exit(2); }
