'use strict';
/**
 * release.js - publish dist/ as a Store source: the GitHub release "catalog" with every package
 * and a catalog.json (mgu-store docs/PUBLISHING.md, "Catalog"). Needs gh, logged in.
 *
 *   node tools/release.js [owner/repo]        (default noth4m4d/mgu-hamadstools)
 *
 * In the car: Store > Settings > Add source > owner/repo > Releases.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const tar = require('./tarlite');

const REPO = process.argv[2] || 'noth4m4d/mgu-hamadstools';
const TAG = 'catalog';
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// what the Store lists (titles, who needs what); versions and files come from dist/
const COMPONENTS = {
    'airplay-rx': { kind: 'tool', title: 'AirPlay receiver', optional: true,
        description: 'Needed by the AirPlay app: receives the iPhone\'s screen (AirPlay screen mirroring).' },
    apm_airplay: { kind: 'app', title: 'AirPlay', requires: { 'airplay-rx': '1.0.0' },
        description: 'Your iPhone\'s screen on the central display by AirPlay screen mirroring, parked only. Sound stays on Bluetooth. In Apps and Communication.' },
    wazecard: { kind: 'tool', title: 'Waze Cards service', optional: true,
        description: 'Needed by the Waze Cards app: draws Waze\'s cards or map on the instrument cluster.' },
    wzc_wazecards: { kind: 'app', title: 'Waze Cards', requires: { wazecard: '1.0.0' },
        description: 'Waze\'s turn and arrival cards, or Waze\'s map, on the instrument cluster while Waze guides in CarPlay.' },
};

// the release, made once
try { gh('release', 'view', TAG, '-R', REPO, '--json', 'tagName'); } catch (e) {
    gh('release', 'create', TAG, '-R', REPO, '--title', 'Store catalog', '--notes',
        'Add this repository as a source in the Store (Settings > Add source). The packages and catalog.json here are what it installs.');
}

const pkgs = fs.readdirSync(DIST).filter((n) => /@\d+\.\d+\.\d+\.tgz$/.test(n));
const icons = [];
for (const n of pkgs) {
    // an app's tile icon, for the Store's list
    const id = n.split('@')[0];
    if (COMPONENTS[id] && COMPONENTS[id].kind === 'app') {
        const icon = tar.read(fs.readFileSync(path.join(DIST, n))).find((e) => /rhmiData\/.*_icon\.png$/.test(e.name));
        if (icon) { fs.writeFileSync(path.join(DIST, id + '.png'), icon.data); icons.push(id + '.png'); }
    }
}
// old versions out of the release, then the new files up
const have = JSON.parse(gh('release', 'view', TAG, '-R', REPO, '--json', 'assets')).assets;
for (const a of have) if (/\.tgz$/.test(a.name) && !pkgs.includes(a.name)) gh('release', 'delete-asset', TAG, a.name, '-R', REPO, '-y');
gh('release', 'upload', TAG, '-R', REPO, '--clobber', ...pkgs.concat(icons).map((n) => path.join(DIST, n)));

// the assets' API addresses: a private repository's downloads go through the API with the car's token
const assets = JSON.parse(gh('api', `repos/${REPO}/releases/tags/${TAG}`)).assets;
const url = (name) => { const a = assets.find((x) => x.name === name); if (!a) throw new Error('not uploaded: ' + name); return a.url; };

const components = pkgs.map((n) => {
    const [id, ver] = n.replace(/\.tgz$/, '').split('@');
    const c = COMPONENTS[id];
    if (!c) throw new Error('unknown package ' + n + ' (add it to COMPONENTS)');
    const b = fs.readFileSync(path.join(DIST, n));
    const e = { id, kind: c.kind, title: c.title, description: c.description, author: 'h4m4d', version: ver,
        artifact: { name: n, size: b.length, sha256: sha(b), url: url(n) },
        requires: Object.assign({ 'mgu-deploy': '0.7.0' }, c.requires || {}), uninstallable: true, mguHmi: ['ID7'] };
    if (c.optional) e.optional = true;
    if (icons.includes(id + '.png')) { e.icon = id + '.png'; e.iconSha256 = sha(fs.readFileSync(path.join(DIST, id + '.png'))); }
    return e;
});
fs.writeFileSync(path.join(DIST, 'catalog.json'), JSON.stringify({ schema: 2, components }, null, 2) + '\n');
gh('release', 'upload', TAG, '-R', REPO, '--clobber', path.join(DIST, 'catalog.json'));
console.log(components.map((c) => c.id + ' ' + c.version).join('\n'));
console.log('published: https://github.com/' + REPO + '/releases/tag/' + TAG);
