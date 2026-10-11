import {describe, expect, test, vi} from 'vitest';
import {createSyntheticPointFeatureTable, signedMltFeatureId} from '../../../../test/unit/lib/mlt_synthetic.ts';
import {ColumnarEvaluationFeature} from './evaluation_feature.ts';
import {encodeTile} from '@maplibre/mlt';
import {getMltFeatureTable, MLTVectorTile} from '../../../source/vector_tile_mlt.ts';

describe('ColumnarEvaluationFeature', () => {
    test('resolves deferred columns on demand without freezing an incomplete property view', () => {
        const raw = encodeTile([{name: 'points', features: [
            {geometry: {type: 'Point', coordinates: [10, 10]}, properties: {rank: 2, other: 3}},
            {geometry: {type: 'Point', coordinates: [20, 20]}, properties: {rank: 7, other: 8}},
        ]}]).buffer as ArrayBuffer;
        const table = getMltFeatureTable(new MLTVectorTile(raw, {deferPropertyColumns: true}).layers.points);
        const feature = new ColumnarEvaluationFeature(table).setIndex(0);
        expect(table.propertyVectors).toHaveLength(0);
        expect(feature.properties.rank).toBe(2);
        expect(table.propertyVectors.map(vector => vector.name)).toEqual(['rank']);
        table.getPropertyVector('other');
        expect('other' in feature.properties).toBe(true);
        expect(feature.setIndex(1).properties.rank).toBe(7);
        expect({...feature.properties}).toEqual({rank: 7, other: 8});
    });

    test('reuses one property view across feature indices', () => {
        const feature = new ColumnarEvaluationFeature(createSyntheticPointFeatureTable());
        const properties = feature.setIndex(0).properties;
        expect(properties.category).toBe('poi');
        expect(properties.radius).toBe(5);
        expect(Object.keys(properties).sort()).toEqual(['category', 'icon', 'label', 'radius', 'sort']);
        expect(feature.setIndex(0)).toBe(feature);
        expect(feature.properties).toBe(properties);

        expect(feature.setIndex(1).properties).toBe(properties);
        expect(properties.category).toBe('label');
        expect(properties.radius).toBe(8);

        feature.setIndex(2);
        expect(feature.id).toBe(Number(BigInt.asUintN(64, BigInt(signedMltFeatureId))));
    });

    test('keeps index switches O(1) until type or id are consumed', () => {
        const featureTable = createSyntheticPointFeatureTable();
        const geometryType = vi.spyOn(featureTable.geometryVector, 'geometryType');
        const idValue = vi.spyOn(featureTable.idVector, 'getValue');
        const feature = new ColumnarEvaluationFeature(featureTable);

        feature.setIndex(1);
        expect(geometryType).not.toHaveBeenCalled();
        expect(idValue).not.toHaveBeenCalled();

        expect(feature.type).toBe(1);
        expect(feature.type).toBe(1);
        expect(geometryType).toHaveBeenCalledTimes(1);
        // The second point has no id: like a vector tile feature, it has none rather than its index.
        expect(feature.id).toBeUndefined();
        expect(feature.id).toBeUndefined();
        expect(idValue).not.toHaveBeenCalled();

        feature.setIndex(2);
        expect(geometryType).toHaveBeenCalledTimes(1);
        expect(feature.type).toBe(1);
        expect(feature.id).toBe(Number(BigInt.asUintN(64, BigInt(signedMltFeatureId))));
        expect(feature.id).toBe(Number(BigInt.asUintN(64, BigInt(signedMltFeatureId))));
        expect(geometryType).toHaveBeenCalledTimes(2);
        expect(idValue).toHaveBeenCalledTimes(1);
    });
});
