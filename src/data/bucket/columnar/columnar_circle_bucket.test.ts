import {describe, expect, test, vi} from 'vitest';
import {ColumnarCircleBucket} from './columnar_circle_bucket';
import {CircleBucket} from '../circle_bucket';
import {CircleStyleLayer} from '../../../style/style_layer/circle_style_layer';
import {CanonicalTileID} from '../../../tile/tile_id';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../../../util/mlt_materialization_stats';
import {createPopulateOptions} from '../../../../test/unit/lib/tile';
import {
    createConstGeometryVector,
    FeatureTable,
    GEOMETRY_TYPE,
    IntFlatVector,
    TopologyVector
} from '@maplibre/mlt';

import type {BucketParameters} from '../../bucket';
import type {ZoomHistory} from '../../../style/zoom_history';
import type {EvaluationParameters} from '../../../style/evaluation_parameters';

function createLayer(layout?: Record<string, any>, paint?: Record<string, any>) {
    const layer = new CircleStyleLayer({
        id: 'circle-test',
        source: 'source',
        'source-layer': 'test',
        type: 'circle',
        layout,
        paint
    }, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

function createFeatureTable() {
    const geometryVector = createConstGeometryVector(
        1,
        GEOMETRY_TYPE.POINT,
        new TopologyVector(null, null, null),
        null,
        new Int32Array([10, 10])
    ) as any;
    geometryVector.getGeometries = vi.fn(() => {
        throw new Error('getGeometries should not be called');
    });

    return new FeatureTable(
        'test',
        geometryVector,
        new IntFlatVector('id', new Int32Array([1]), 1),
        [
            new IntFlatVector('radius', new Int32Array([5]), 1)
        ]
    );
}

function structArrayBytes(array: {arrayBuffer: ArrayBuffer; length: number; bytesPerElement: number}): number[] {
    return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}

describe('ColumnarCircleBucket', () => {
    test('matches legacy circle mesh on a simple point', () => {
        const layer = createLayer(undefined, {
            'circle-radius': ['get', 'radius']
        });
        const columnarBucket = new ColumnarCircleBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<CircleStyleLayer>);
        const legacyBucket = new CircleBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<CircleStyleLayer>);

        const featureTable = createFeatureTable();
        columnarBucket.populate(featureTable, createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
        legacyBucket.populate([{
            id: 1,
            index: 0,
            sourceLayerIndex: 0,
            feature: {
                id: 1,
                type: 1,
                properties: {
                    radius: 5
                },
                extent: 4096,
                loadGeometry: () => [[{x: 10, y: 10}]]
            }
        } as any], createPopulateOptions([]), new CanonicalTileID(0, 0, 0));

        expect(structArrayBytes(columnarBucket.layoutVertexArray as any)).toEqual(structArrayBytes(legacyBucket.layoutVertexArray as any));
        expect(structArrayBytes(columnarBucket.indexArray as any)).toEqual(structArrayBytes(legacyBucket.indexArray as any));
        expect(columnarBucket.segments.get()).toEqual(legacyBucket.segments.get());
        expect(columnarBucket.featureIndexBBoxes).toEqual([[20, 20, 20, 20]]);
        expect((featureTable.geometryVector as any).getGeometries).not.toHaveBeenCalled();
    });

    test('reuses a columnar evaluation feature for state-dependent paint', () => {
        const layer = createLayer(undefined, {
            'circle-radius': ['case', ['boolean', ['feature-state', 'active'], false], ['get', 'radius'], 1]
        });
        const bucket = new ColumnarCircleBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<CircleStyleLayer>);
        const stats = createMltMaterializationStats({
            strict: true,
            forbiddenCounters: ['propertyObjects', 'propertyProxyMisses']
        });
        const deactivate = activateMltMaterializationStats(stats);

        try {
            bucket.populate(createFeatureTable(), createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
        } finally {
            deactivate();
        }

        expect(bucket.layoutVertexArray.length).toBeGreaterThan(0);
        expect(stats.counters.propertyObjects).toBe(0);
        expect(stats.counters.propertyProxyMisses).toBe(0);
    });
});
