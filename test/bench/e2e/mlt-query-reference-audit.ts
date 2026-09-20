import assert from 'node:assert/strict';
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import Point from '@mapbox/point-geometry';
import {fromVectorTileJs, type VectorTileLayerLike} from '@maplibre/vt-pbf';
import {sliceVectorTileLayer} from '../../../src/source/vector_tile_overzoomed.ts';
import {clipGeometry} from '../../../src/symbol/clip_line.ts';
import type {CanonicalTileID} from '../../../src/tile/tile_id.ts';

/** Reproduces the former float-delta encoding solely to audit historical query references, never as a production fallback. */
function legacyLayer(layer: VectorTileLayerLike, scale: number, x: number, y: number): VectorTileLayerLike {
    const features = [];
    for (let index = 0; index < layer.length; index++) {
        const feature = layer.feature(index);
        const transformed = feature.loadGeometry().map(part => part.map(point =>
            new Point(point.x * scale - x * layer.extent, point.y * scale - y * layer.extent)));
        const geometry = clipGeometry(transformed, feature.type, -128, -128, layer.extent + 128, layer.extent + 128);
        if (geometry.length) features.push({id: feature.id, properties: feature.properties, type: feature.type,
            extent: layer.extent, loadGeometry: () => geometry});
    }
    return {name: layer.name, version: 2, extent: layer.extent, length: features.length, feature: index => features[index]};
}

/** Ignores only projection floating-point noise below 1e-9 degrees, not integer clipping differences. */
function signature(feature: GeoJSON.Feature): string {
    return JSON.stringify({id: feature.id, geometry: feature.geometry, properties: feature.properties}, (_key, value) => {
        if (typeof value === 'number') return Math.round(value * 1e9) / 1e9;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
        }
        return value;
    });
}

const directory = process.argv[2];
assert.ok(directory, 'Pass a QUERY_TEST_OUTPUT directory');
const tile = new VectorTile(new PbfReader(readFileSync('test/integration/assets/tiles/counties-7-37-48.mvt')));
const parent = {z: 7, x: 37, y: 48} as CanonicalTileID;
const geometrySets = {legacy: new Set<string>(), rounded: new Set<string>()};
for (const dz of [1, 2]) {
    const scale = 2 ** dz;
    for (let x = 0; x < scale; x++) for (let y = 0; y < scale; y++) {
        const child = {z: parent.z + dz, x: parent.x * scale + x, y: parent.y * scale + y} as CanonicalTileID;
        const layers = {legacy: legacyLayer(tile.layers.counties, scale, x, y),
            rounded: sliceVectorTileLayer(tile.layers.counties, parent, child)};
        for (const [mode, layer] of Object.entries(layers)) {
            const encoded = new VectorTile(new PbfReader(fromVectorTileJs({layers: {counties: layer}}))).layers.counties;
            if (!encoded) continue;
            for (let index = 0; index < encoded.length; index++) {
                geometrySets[mode].add(signature(encoded.feature(index).toGeoJSON(child.x, child.y, child.z)));
            }
        }
    }
}
const cases = [];
for (const name of readdirSync(directory).filter(name => name.endsWith('.json') && name !== 'audit.json')) {
    const {caseName, expected, actual} = JSON.parse(readFileSync(`${directory}/${name}`, 'utf8'));
    for (const feature of expected) assert.ok(geometrySets.legacy.has(signature(feature)), `Unexplained legacy geometry: ${caseName}/${feature.id}`);
    for (const feature of actual) assert.ok(geometrySets.rounded.has(signature(feature)), `Unexplained rounded geometry: ${caseName}/${feature.id}`);
    cases.push({caseName, expectedIDs: expected.map(feature => feature.id), actualIDs: actual.map(feature => feature.id),
        legacyGeometriesVerified: expected.length, roundedGeometriesVerified: actual.length});
}
const result = {cases, note: 'References and actual results matched independent tile decoding plus the respective clipping/encoding policy; intersection result counts can change at rounding boundaries.'};
writeFileSync(`${directory}/audit.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
