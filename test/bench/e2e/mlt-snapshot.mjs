import assert from 'node:assert/strict';
import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';

/** Freezes already-built production artifacts and their source diff for same-campaign version comparisons. */
const directory = process.argv[2];
assert.ok(directory, 'Pass a new snapshot directory after npm run build-prod');
mkdirSync(directory, {recursive: false});
const files = ['maplibre-gl.mjs', 'maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl.css',
    'maplibre-gl.mjs.map', 'maplibre-gl-worker.mjs.map', 'maplibre-gl-shared.mjs.map'];
const manifest = {};
for (const file of files) {
    const source = `dist/${file}`;
    const bytes = readFileSync(source);
    copyFileSync(source, `${directory}/${file}`);
    manifest[file] = {bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex')};
}
writeFileSync(`${directory}/snapshot.json`, `${JSON.stringify({
    createdAt: new Date().toISOString(), git: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
    productDiff: execFileSync('git', ['diff', '--', 'src'], {encoding: 'utf8'}),
    tileSpecGit: execFileSync('git', ['-C', '../maplibre-tile-spec', 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), manifest
}, null, 2)}\n`);
console.log(resolve(directory));
