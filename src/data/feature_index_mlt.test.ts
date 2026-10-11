import {describe, expect, test} from 'vitest';
import {FeatureIndex} from './feature_index.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {encodeMltFeatureTable} from '../../test/unit/lib/mlt_synthetic.ts';

import type {FeatureInput} from '@maplibre/mlt';

const tileID = new OverscaledTileID(0, 0, 0, 0, 0);

function point(id: number | bigint | undefined, properties: FeatureInput['properties'] = {}): FeatureInput {
    return {id, geometry: {type: 'Point', coordinates: [0, 0]}, properties};
}

describe('FeatureIndex.createMltIdResolver', () => {
    test('reads the id column as vector tiles read feature ids', () => {
        const largeId = BigInt.asUintN(64, -1814668313n);
        const featureTable = encodeMltFeatureTable({name: 'layer', features: [point(7), point(largeId), point(undefined)]});
        const resolveId = new FeatureIndex(tileID).createMltIdResolver(featureTable, 'layer');

        expect(resolveId(0)).toBe(7);
        expect(resolveId(1)).toBe(Number(largeId));
        expect(resolveId(2)).toBeUndefined();
    });

    test('reads the promoted id column, falling back to the cluster id of clusters', () => {
        const featureTable = encodeMltFeatureTable({name: 'layer', features: [
            point(11, {promoted: 'road-a', cluster: false}),
            point(12, {promoted: null, cluster: false}),
            point(13, {promoted: null, cluster: true, cluster_id: '123'}),
        ]});
        const resolveId = new FeatureIndex(tileID, {layer: 'promoted'}).createMltIdResolver(featureTable, 'layer');

        expect(resolveId(0)).toBe('road-a');
        expect(resolveId(1)).toBeUndefined();
        expect(resolveId(2)).toBe(123);
    });

    test('reads a boolean promoted id as a number', () => {
        const featureTable = encodeMltFeatureTable({name: 'layer', features: [point(1, {promoted: true}), point(2, {promoted: false})]});
        const resolveId = new FeatureIndex(tileID, 'promoted').createMltIdResolver(featureTable, 'layer');

        expect(resolveId(0)).toBe(1);
        expect(resolveId(1)).toBe(0);
    });
});
