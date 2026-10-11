import {describe, expect, test} from 'vitest';
import {encodeTile} from '@maplibre/mlt';
import {getMltFeatureTable, MLTVectorTile} from './vector_tile_mlt.ts';

function encodeRoadsAndWater(): ArrayBuffer {
    const bytes = encodeTile([
        {name: 'roads', features: [{id: 1, geometry: {type: 'LineString', coordinates: [[0, 0], [10, 10]]}, properties: {class: 'street', name: 'Main'}}]},
        {name: 'water', features: [{id: 2, geometry: {type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10]]]}, properties: {kind: 'lake'}}]},
    ]);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('MLTVectorTile', () => {
    test('reads features as vector tile features', () => {
        const feature = new MLTVectorTile(encodeRoadsAndWater()).layers.roads.feature(0);

        expect(feature.id).toBe(1);
        expect(feature.type).toBe(2);
        expect(feature.properties).toEqual({class: 'street', name: 'Main'});
        expect(feature.loadGeometry().map(ring => ring.map(({x, y}) => [x, y]))).toEqual([[[0, 0], [10, 10]]]);
    });

    test('decodes only the listed layers, and the columns it does not list when they are first read', () => {
        const tile = new MLTVectorTile(encodeRoadsAndWater(), {layerNames: ['roads'], propertyColumnNamesByLayer: new Map([['roads', new Set(['class'])]])});

        expect(Object.keys(tile.layers)).toEqual(['roads']);
        expect(getMltFeatureTable(tile.layers.roads).getPropertyVector('class')).toBeDefined();
        expect(tile.layers.roads.feature(0).properties).toEqual({class: 'street', name: 'Main'});
    });
});
