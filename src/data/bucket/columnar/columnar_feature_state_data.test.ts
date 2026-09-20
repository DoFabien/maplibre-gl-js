import {describe, expect, test} from 'vitest';
import {
    createConstGeometryVector,
    FeatureTable,
    GEOMETRY_TYPE,
    IntFlatVector,
    Int64FlatVector,
    TopologyVector,
} from '@maplibre/mlt';
import {FeaturePositionMap} from '../../feature_position_map.ts';
import {deserialize, serialize} from '../../../util/web_worker_transfer.ts';
import {normalizeMltFeatureId} from '../../../util/mlt_feature_id.ts';
import {ColumnarFeatureStateData} from './columnar_feature_state_data.ts';

function createFeatureTable(): FeatureTable {
    return new FeatureTable(
        'test',
        createConstGeometryVector(
            2,
            GEOMETRY_TYPE.POINT,
            new TopologyVector(null, null, null),
            null,
            new Int32Array([0, 0, 1, 1]),
        ),
        new IntFlatVector('id', new Int32Array([7, 8]), 2),
        [
            new IntFlatVector('value', new Int32Array([11, 22]), 2),
            new IntFlatVector('unused', new Int32Array([111, 222]), 2),
        ],
    );
}

describe('ColumnarFeatureStateData', () => {
    test('transfers projected columns and a compact multi-occurrence id mapping', () => {
        const featureMap = new FeaturePositionMap();
        featureMap.add(7, 0, 0, 4);
        featureMap.add(7, 0, 4, 8);
        featureMap.add(8, 1, 8, 12);

        const data = ColumnarFeatureStateData.create(
            createFeatureTable(),
            featureMap,
            new Set(['value']),
            () => 'shared',
        );
        const transferred = deserialize(serialize(data)) as ColumnarFeatureStateData;

        expect(Array.from(transferred.featureIndices)).toEqual([0, 1]);
        expect(transferred.ids).toEqual(['shared', 'shared']);
        expect(transferred.propertyNames).toEqual(['value']);
        expect(transferred.propertyValues).toEqual([[11, 22]]);
        expect(transferred.featureMap.getPositions('shared').sort((a, b) => a.start - b.start)).toEqual([
            {index: 0, start: 0, end: 4},
            {index: 0, start: 4, end: 8},
            {index: 1, start: 8, end: 12},
        ]);
        expect(transferred.byteLength).toBeGreaterThan(0);

        const provider = transferred.getFeatureProvider();
        const first = provider(0);
        expect(first).toMatchObject({id: 'shared', type: 1, properties: {value: 11}});
        const second = provider(1);
        expect(second).toBe(first);
        expect(second).toMatchObject({id: 'shared', type: 1, properties: {value: 22}});
        expect('geometry' in second).toBe(false);
        expect('unused' in second.properties).toBe(false);
    });

    test('preserves a signed 64-bit MLT id through transfer and lookup', () => {
        const signedId = -4294967297n;
        const normalizedId = normalizeMltFeatureId(signedId);
        const table = new FeatureTable(
            'test',
            createConstGeometryVector(
                1,
                GEOMETRY_TYPE.POINT,
                new TopologyVector(null, null, null),
                null,
                new Int32Array([0, 0]),
            ),
            new Int64FlatVector('id', new BigInt64Array([signedId]), 1),
            [new IntFlatVector('value', new Int32Array([33]), 1)],
        );
        const featureMap = new FeaturePositionMap();
        featureMap.add(normalizedId, 0, 0, 4);

        const transferred = deserialize(serialize(ColumnarFeatureStateData.create(
            table,
            featureMap,
            new Set(['value']),
            (featureIndex) => normalizeMltFeatureId(table.idVector?.getValue(featureIndex)),
        ))) as ColumnarFeatureStateData;

        expect(transferred.ids).toEqual([normalizedId]);
        expect(transferred.featureMap.getPositions(normalizedId)).toEqual([{index: 0, start: 0, end: 4}]);
        expect(transferred.getFeatureProvider()(0)).toMatchObject({
            id: normalizedId,
            properties: {value: 33},
        });
    });
});
