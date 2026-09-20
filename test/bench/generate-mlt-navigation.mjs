import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {rolldown} from 'rolldown';

const output = resolve(process.argv[2] || '');
assert.ok(process.argv[2], 'Pass a new output directory');
mkdirSync(output);
const database = resolve('../maplibre-tile-spec/test/omt-ref.mbtiles');
const jar = resolve('../maplibre-tile-spec/java/mlt-cli/build/libs/encode.jar');
const db = new DatabaseSync(database, {readOnly: true});
const bundle = await rolldown({input: '../maplibre-tile-spec/ts/dist/index.js'});
const compiled = await bundle.generate({format: 'esm'});
const {decodeTile, scanTilePhysicalTechniques} = await import(`data:text/javascript;base64,${Buffer.from(compiled.output[0].code).toString('base64')}`);
await bundle.close();
const manifest = {status: 'running', createdAt: new Date().toISOString(), database: {path: database, ...digest(readFileSync(database))},
    encoder: {path: jar, snapshot: `${output}/encoder.jar`, ...digest(readFileSync(jar)),
        sourceCommit: execFileSync('git', ['-C', '../maplibre-tile-spec', 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()},
    arguments: ['--tessellate', '--outlines', 'ALL', '--nomorton'],
    coordinates: 'MBTiles tile_row is TMS; filenames and browser URLs use XYZ y = 2**z - 1 - tile_row',
    selectionSQL: 'SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles WHERE zoom_level BETWEEN 10 AND 13 ORDER BY zoom_level, tile_column, tile_row',
    tiles: [], failures: []};
writeFileSync(manifest.encoder.snapshot, readFileSync(jar), {flag: 'wx'});
function save() { writeFileSync(`${output}/manifest.json`, JSON.stringify(manifest, null, 2)); }
for (const row of db.prepare(manifest.selectionSQL).all()) {
    const z = row.zoom_level; const x = row.tile_column; const y = 2 ** z - 1 - row.tile_row;
    const name = `${z}-${x}-${y}`; const original = Buffer.from(row.tile_data);
    const input = `${output}/${name}.mvt`; const target = `${output}/${name}.mlt`;
    writeFileSync(input, original, {flag: 'wx'});
    const tile = {name, z, x, y, tmsY: row.tile_row, mvt: {path: input, ...digest(original)}, layers: []};
    manifest.tiles.push(tile);
    try {
        if (process.argv[3]) {
            const prior = JSON.parse(readFileSync(`${process.argv[3]}/manifest.json`, 'utf8'));
            assert.equal(prior.encoder.sha256, manifest.encoder.sha256);
            assert.deepEqual(prior.arguments, manifest.arguments);
            const previous = prior.tiles.find(tile => tile.name === name);
            assert.equal(previous.mvt.sha256, tile.mvt.sha256);
            const bytes = readFileSync(previous.mlt.path); assert.equal(digest(bytes).sha256, previous.mlt.sha256);
            writeFileSync(target, bytes, {flag: 'wx'});
        } else execFileSync('java', ['-jar', jar, '--mvt', input, '--mlt', target, ...manifest.arguments], {stdio: 'pipe'});
        const encoded = readFileSync(target); tile.mlt = {path: target, ...digest(encoded)};
        const streams = scanTilePhysicalTechniques(encoded);
        assert.ok(!streams.some(stream => stream.technique === 'FAST_PFOR'));
        tile.streams = Object.fromEntries(['NONE', 'VARINT', 'FAST_PFOR'].map(technique => [technique, streams.filter(stream => stream.technique === technique).length]));
        const reference = new VectorTile(new PbfReader(original));
        const tables = decodeTile(encoded);
        assert.deepEqual(tables.map(table => table.name).sort(), Object.keys(reference.layers).sort());
        for (const table of tables) {
            const layer = reference.layers[table.name];
            assert.equal(table.extent, layer.extent); assert.equal(table.numFeatures, layer.length);
            table.materializePropertyVectors();
            const expected = Array.from({length: layer.length}, (_,index) => normalizedMvt(layer.feature(index)));
            const actual = table.getFeatures().map(feature => ({id: publicId(feature.id),
                type: feature.geometry.type % 3 + 1, properties: {...feature.properties}, geometry: points(feature.geometry.coordinates)}));
            const idDifferences = actual.flatMap((feature, index) => feature.id === expected[index].id ? [] : [{index, mvt: expected[index].id, mlt: feature.id}]);
            assert.deepEqual(actual.map(({id, ...rest}) => rest), expected.map(({id, ...rest}) => rest), `${name}/${table.name}: ordered properties and tile coordinates`);
            const geometry = table.geometryVector;
            tile.layers.push({name: table.name, features: layer.length, triangles: (geometry.indexBuffer?.length || 0) / 3,
                signature: digest(Buffer.from(JSON.stringify(actual))).sha256, geometryPropertiesParity: true,
                idDifferences: idDifferences.length, idExamples: idDifferences.slice(0, 3)});
        }
        tile.status = tile.layers.some(layer => layer.idDifferences) ? 'id-mismatch' : 'passed';
        if (tile.status !== 'passed') manifest.failures.push({name, error: 'Feature ID mismatch', features: tile.layers.reduce((sum, layer) => sum + layer.idDifferences, 0)});
    } catch (error) {
        tile.status = 'failed';
        tile.error = String(error).slice(0, 2000).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '<decoder>');
        manifest.failures.push({name, error: tile.error});
    }
    save(); console.log(`${name}: ${tile.status} (${tile.layers.length} layers)`);
}
db.close();
manifest.status = manifest.failures.length ? 'failed' : 'passed'; save();
if (manifest.failures.length) process.exitCode = 1;

/** Normalizes only object prototypes, leaving feature order and all coordinates unchanged. */
function normalizedMvt(feature) {
    return {id: feature.id, type: feature.type, properties: {...feature.properties}, geometry: points(feature.loadGeometry())};
}

/** Keeps the MVT ring/line/point array structure exactly. */
function points(geometry) { return geometry.map(part => part.map(point => [point.x, point.y])); }

/** Matches MapLibre's public unsigned-ID conversion; signed BigInt64 storage retains the original 64 wire bits. */
function publicId(value) {
    if (typeof value === 'bigint') return Number(BigInt.asUintN(64, value));
    if (typeof value === 'number' && value < 0) return Number(BigInt.asUintN(64, BigInt(value)));
    return value;
}

/** Hashes original bytes and computes equally configured HTTP gzip payload sizes. */
function digest(bytes) {
    return {sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, gzip: gzipSync(bytes).length};
}
