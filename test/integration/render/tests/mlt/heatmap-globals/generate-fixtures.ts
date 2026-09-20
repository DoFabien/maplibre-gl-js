import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createConstGeometryVector, createStringFlatVector, encodeFeatureTables, FeatureTable, GEOMETRY_TYPE, IntFlatVector, TopologyVector} from '@maplibre/mlt';
import {fromVectorTileJs} from '@maplibre/vt-pbf';
import Point from '@mapbox/point-geometry';

import type {LayerSpecification, StyleSpecification} from '@maplibre/maplibre-gl-style-spec';

/** Independent MVT reference rows and equivalent MLT columns, with stable positive feature IDs. */
const rows = [
    {id: 1, x: 3800, y: 3900, radius: 18, weight: 1, label: 'Paris'},
    {id: 2, x: 4250, y: 4150, radius: 35, weight: 3, label: 'مرحبا'},
    {id: 3, x: 4450, y: 4200, radius: 25, weight: 2, label: 'नमस्ते'},
];
const table = new FeatureTable('points', createConstGeometryVector(
    rows.length, GEOMETRY_TYPE.POINT, new TopologyVector(null, null, null), null,
    new Int32Array(rows.flatMap(row => [row.x, row.y]))),
new IntFlatVector('id', new Int32Array(rows.map(row => row.id)), rows.length), [
    new IntFlatVector('radius', new Int32Array(rows.map(row => row.radius)), rows.length),
    new IntFlatVector('weight', new Int32Array(rows.map(row => row.weight)), rows.length),
    createStringFlatVector(rows.map(row => row.label), 'label'),
], 8192);
const mvt = fromVectorTileJs({layers: {points: {
    version: 2, name: 'points', extent: 8192, length: rows.length,
    feature(index: number) {
        const row = rows[index];
        return {id: row.id, type: 1, extent: 8192, properties: {radius: row.radius, weight: row.weight, label: row.label}, loadGeometry: () => [[new Point(row.x, row.y)]]};
    },
}}});
const assetDirectory = resolve('test/integration/assets/tiles/mlt/heatmap-globals');
mkdirSync(assetDirectory, {recursive: true});
writeFileSync(resolve(assetDirectory, 'points.mlt'), new Uint8Array(encodeFeatureTables([table])));
writeFileSync(resolve(assetDirectory, 'points.mvt'), mvt);

for (const encoding of ['mvt', 'mlt'] as const) {
    for (const name of ['basic', 'data-driven', 'feature-state', 'globe', 'zoom-filter', 'script-filter']) {
        const source = {type: 'vector' as const, encoding, minzoom: 0, maxzoom: 0, tiles: [`local://tiles/mlt/heatmap-globals/points.${encoding}`]};
        const layer: LayerSpecification = name === 'script-filter' ? {
            id: 'layer', type: 'circle', source: 'points', 'source-layer': 'points',
            filter: ['is-supported-script', ['get', 'label']],
            paint: {'circle-radius': 10, 'circle-color': '#008060'},
        } : {
            id: 'layer', type: 'heatmap', source: 'points', 'source-layer': 'points',
            ...(name === 'zoom-filter' ? {filter: ['==', ['zoom'], 2]} : {}),
            paint: {
                'heatmap-radius': name === 'basic' ? 25 : name === 'globe' ? 60 : ['get', 'radius'],
                'heatmap-weight': name === 'feature-state' ? ['case', ['boolean', ['feature-state', 'active'], false], ['get', 'weight'], 0] : ['/', ['get', 'weight'], 3],
            },
        };
        const style: StyleSpecification = {
            version: 8, center: [0, 0], zoom: name === 'zoom-filter' ? 2 : 0,
            ...(name === 'globe' ? {projection: {type: 'globe'}, pitch: 35} : {}),
            metadata: {test: {width: 256, height: 256,
                ...(name === 'feature-state' ? {operations: [['wait'], ['setFeatureState', {source: 'points', sourceLayer: 'points', id: 2}, {active: true}], ['wait']]} : {}),
            }},
            sources: {points: source},
            layers: [{id: 'background', type: 'background', paint: {'background-color': '#f5f3ed'}}, layer],
        };
        const directory = resolve('test/integration/render/tests/mlt/heatmap-globals', `${encoding}-${name}`);
        mkdirSync(directory, {recursive: true});
        writeFileSync(resolve(directory, 'style.json'), `${JSON.stringify(style, null, 2)}\n`);
    }
}
