import {describe, expect, test, vi} from 'vitest';
import {createMltMaterializationStats, activateMltMaterializationStats} from '../../../util/mlt_materialization_stats.ts';
import {createSyntheticPointFeatureTable, signedMltFeatureId} from '../../../../test/unit/lib/mlt_synthetic.ts';
import {ColumnarEvaluationFeature} from './evaluation_feature.ts';
import {createConstGeometryVector, encodeFeatureTables, FeatureTable, GEOMETRY_TYPE, IntFlatVector, TopologyVector} from '@maplibre/mlt';
import {getMltFeatureTable, MLTVectorTile} from '../../../source/vector_tile_mlt.ts';

describe('ColumnarEvaluationFeature', () => {
    test('resolves deferred columns on demand without freezing an incomplete property view', () => {
        const raw = encodeFeatureTables([new FeatureTable('points', createConstGeometryVector(
            2, GEOMETRY_TYPE.POINT, new TopologyVector(null, null, null), null, new Int32Array([10, 10, 20, 20])
        ), undefined, [new IntFlatVector('rank', new Int32Array([2, 7]), 2), new IntFlatVector('other', new Int32Array([3, 8]), 2)])]);
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

    test('reuses one projected property view across feature indices', () => {
        const feature = new ColumnarEvaluationFeature(
            createSyntheticPointFeatureTable(),
            new Set(['category', 'radius']),
        );
        const stats = createMltMaterializationStats({
            strict: true,
            forbiddenCounters: ['propertyObjects', 'propertyProxyMisses'],
        });
        const deactivate = activateMltMaterializationStats(stats);

        try {
            const properties = feature.setIndex(0).properties;
            expect(properties.category).toBe('poi');
            expect(properties.radius).toBe(5);
            expect(Object.keys(properties).sort()).toEqual(['category', 'radius']);
            expect(feature.setIndex(0)).toBe(feature);
            expect(feature.properties).toBe(properties);

            expect(feature.setIndex(1).properties).toBe(properties);
            expect(properties.category).toBe('label');
            expect(properties.radius).toBe(8);
            expect('label' in properties).toBe(false);

            feature.setIndex(2);
            expect(feature.id).toBe(Number(BigInt.asUintN(64, BigInt(signedMltFeatureId))));
        } finally {
            deactivate();
        }

        expect(stats.counters.propertyObjects).toBe(0);
        expect(stats.counters.propertyProxyMisses).toBe(0);
    });

    test('keeps index switches O(1) until type, id, or geometry are consumed', () => {
        const featureTable = createSyntheticPointFeatureTable();
        const geometryType = vi.spyOn(featureTable.geometryVector, 'geometryType');
        const idValue = vi.spyOn(featureTable.idVector, 'getValue');
        const feature = new ColumnarEvaluationFeature(featureTable);

        feature.setIndex(1);
        const geometry = feature.getGeometryView();
        expect(geometryType).not.toHaveBeenCalled();
        expect(idValue).not.toHaveBeenCalled();

        expect(feature.type).toBe(1);
        expect(feature.type).toBe(1);
        expect(geometryType).toHaveBeenCalledTimes(1);
        expect(feature.id).toBe(1);
        expect(feature.id).toBe(1);
        expect(idValue).toHaveBeenCalledTimes(1);

        feature.setIndex(2);
        const secondGeometry = feature.getGeometryView();
        expect(secondGeometry).toBe(geometry);
        expect(geometryType).toHaveBeenCalledTimes(1);
        expect(idValue).toHaveBeenCalledTimes(1);
        expect(feature.type).toBe(1);
        expect(feature.id).toBe(Number(BigInt.asUintN(64, BigInt(signedMltFeatureId))));
        expect(geometryType).toHaveBeenCalledTimes(2);
        expect(idValue).toHaveBeenCalledTimes(2);
        expect(secondGeometry.partCount).toBe(1);
    });
});
