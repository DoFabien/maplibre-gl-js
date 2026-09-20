import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, writeFileSync, existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {rolldown} from 'rolldown';

const output = process.argv[2];
assert.ok(output, 'Pass a new output directory for the encoding audit');
assert.ok(!existsSync(output), 'Use a new fixture directory; existing evidence must not be overwritten');
mkdirSync(output, {recursive: true});
const jar = '../maplibre-tile-spec/java/mlt-cli/build/libs/encode.jar';
const bundle = await rolldown({input: '../maplibre-tile-spec/ts/dist/index.js'});
const compiled = await bundle.generate({format: 'esm'});
const {decodeTile} = await import(`data:text/javascript;base64,${Buffer.from(compiled.output[0].code).toString('base64')}`);
await bundle.close();
const manifest = {encoder: {path: jar, ...digest(jar)}, arguments: ['--tessellate', '--outlines', 'ALL', '--nomorton'], tiles: []};
for (const name of ['14-8802-5374', '14-8802-5375', '14-8803-5374', '14-8803-5375']) {
    const input = `test/integration/assets/tiles/${name}.mvt`;
    const target = `${output}/${name}.mlt`;
    execFileSync('java', ['-jar', jar, '--mvt', input, '--mlt', target, ...manifest.arguments], {stdio: 'pipe'});
    const layers = decodeTile(new Uint8Array(readFileSync(target))).map(table => {
        const geometry = table.geometryVector;
        return {name: table.name, features: table.numFeatures, triangles: geometry.indexBuffer?.length / 3 || 0,
            vertices: geometry.vertexBuffer.length / 2, mesh: !!geometry.indexBuffer};
    });
    assert.ok(layers.some(layer => layer.mesh && layer.triangles > 0));
    manifest.tiles.push({name, mvt: digest(input), existingMlt: digest(`test/integration/assets/tiles/mlt/gl-js/${name}.mlt`), pretriangulated: digest(target), layers});
}
writeFileSync(`${output}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest.tiles.map(({name, mvt, existingMlt, pretriangulated}) => ({name, mvt, existingMlt, pretriangulated})), null, 2));

/** Records wire-size tradeoffs and immutable fixture/encoder provenance. */
function digest(path) {
    const bytes = readFileSync(path);
    return {sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, gzip: gzipSync(bytes).length};
}
