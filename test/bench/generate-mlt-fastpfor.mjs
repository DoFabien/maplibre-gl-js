import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';
import {rolldown} from 'rolldown';

assert.ok(process.argv[2], 'Pass a new output directory for the FastPFOR encoding audit');
const output = resolve(process.argv[2]);
mkdirSync(output);
const jar = '../maplibre-tile-spec/java/mlt-cli/build/libs/encode.jar';
const bundle = await rolldown({input: '../maplibre-tile-spec/ts/dist/index.js'});
const compiled = await bundle.generate({format: 'esm'});
const {decodeTileLayer, scanTileLayers, scanTilePhysicalTechniques} = await import(`data:text/javascript;base64,${Buffer.from(compiled.output[0].code).toString('base64')}`);
await bundle.close();
const manifest = {status: 'running', createdAt: new Date().toISOString(), encoder: {path: jar, ...digest(jar)},
    arguments: ['--tessellate', '--outlines', 'ALL', '--nomorton', '--enable-fastpfor'], tiles: []};
for (const name of ['14-8802-5374', '14-8802-5375', '14-8803-5374', '14-8803-5375']) {
    const input = `test/integration/assets/tiles/${name}.mvt`;
    const baseline = `test/integration/assets/tiles/mlt/gl-js/${name}.mlt`;
    const target = `${output}/${name}.mlt`;
    execFileSync('java', ['-jar', jar, '--mvt', input, '--mlt', target, ...manifest.arguments], {stdio: 'pipe'});
    const previous = new Uint8Array(readFileSync(baseline));
    const encoded = new Uint8Array(readFileSync(target));
    const beforeStreams = scanTilePhysicalTechniques(previous);
    const afterStreams = scanTilePhysicalTechniques(encoded);
    assert.ok(!beforeStreams.some(stream => stream.technique === 'FAST_PFOR'));
    assert.ok(afterStreams.some(stream => stream.technique === 'FAST_PFOR'));
    const reference = scanTileLayers(previous);
    const tables = scanTileLayers(encoded);
    assert.equal(tables.length, reference.length);
    const layers = tables.map((entry, index) => {
        try {
            return compareLayer(name, decodeTileLayer(encoded, entry), decodeTileLayer(previous, reference[index]));
        } catch (error) {
            return {status: 'failed', name: entry.name, error: `${error.name}: ${error.message}`,
                stack: error.stack.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '<decoder>')};
        }
    });
    assert.ok(layers.some(layer => layer.triangles > 0));
    const tile = {name, mvt: {path: input, ...digest(input)}, varint: {path: baseline, ...digest(baseline)},
        fastpfor: {path: target, ...digest(target)}, beforeStreams, afterStreams, layers,
        parity: layers.every(layer => layer.status === 'passed') ? 'exact ordered features, properties, IDs, geometry and mesh buffers' : 'failed'};
    manifest.tiles.push(tile);
    writeFileSync(`${output}/manifest.json`, JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({name, fastpforStreams: afterStreams.filter(stream => stream.technique === 'FAST_PFOR').length,
        sizes: {mvt: tile.mvt, varint: tile.varint, fastpfor: tile.fastpfor}, parity: tile.parity,
        errors: layers.filter(layer => layer.status === 'failed')}));
}
manifest.status = manifest.tiles.every(tile => tile.parity !== 'failed') ? 'passed' : 'failed';
writeFileSync(`${output}/manifest.json`, JSON.stringify(manifest, null, 2));
if (manifest.status === 'failed') process.exitCode = 1;

/** Compares every ordered feature and the mesh representation without requiring identical physical encoding. */
function compareLayer(name, table, old) {
    assert.equal(table.name, old.name);
    assert.equal(table.extent, old.extent);
    table.materializePropertyVectors();
    old.materializePropertyVectors();
    assert.deepEqual(table.getFeatures(), old.getFeatures(), `${name}/${table.name}: complete decoded features`);
    const geometry = table.geometryVector;
    for (const key of ['vertexBuffer', 'indexBuffer', 'triangleOffsets', 'topologyVector']) {
        assert.deepEqual(geometry[key], old.geometryVector[key], `${name}/${table.name}: ${key}`);
    }
    return {status: 'passed', name: table.name, features: table.numFeatures, triangles: (geometry.indexBuffer?.length || 0) / 3,
        vertices: geometry.vertexBuffer.length / 2, mesh: !!geometry.indexBuffer};
}

/** Records exact input identity and comparable gzip sizes with the same compressor settings. */
function digest(path) {
    const bytes = readFileSync(path);
    return {sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, gzip: gzipSync(bytes).length};
}
