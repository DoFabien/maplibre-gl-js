import {createBucketDependencies} from '../../../../test/unit/lib/tile.ts';
import {describe, expect, test, vi} from 'vitest';
import {ColumnarFillExtrusionBucket} from './columnar_fill_extrusion_bucket';
import {FillExtrusionBucket} from '../fill_extrusion_bucket';
import {FillExtrusionStyleLayer} from '../../../style/style_layer/fill_extrusion_style_layer';
import {CanonicalTileID} from '../../../tile/tile_id';
import {createPopulateOptions} from '../../../../test/unit/lib/tile';
import {
    createConstGeometryVector,
    FeatureTable,
    GEOMETRY_TYPE,
    IntFlatVector,
    TopologyVector
} from '@maplibre/mlt';
import Point from '@mapbox/point-geometry';

import type {BucketParameters} from '../../bucket';
import type {ZoomHistory} from '../../../style/zoom_history';
import type {EvaluationParameters} from '../../../style/evaluation_parameters';

function createStyleLayer(paint?: Record<string, any>) {
    const layer = new FillExtrusionStyleLayer({
        id: 'fill-extrusion-test',
        source: 'source',
        'source-layer': 'test',
        type: 'fill-extrusion',
        paint
    }, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

function createFeatureTable() {
    const geometryVector = createConstGeometryVector(
        1,
        GEOMETRY_TYPE.POLYGON,
        new TopologyVector(new Uint32Array(0), new Uint32Array([0, 1]), new Uint32Array([0, 5])),
        null,
        new Int32Array([0, 0, 10, 0, 10, 10, 0, 10, 0, 0])
    ) as any;
    geometryVector.getGeometries = vi.fn(() => {
        throw new Error('getGeometries should not be called');
    });

    return new FeatureTable(
        'test',
        geometryVector,
        new IntFlatVector('id', new Int32Array([1]), 1),
        [
            new IntFlatVector('render_height', new Int32Array([5]), 1)
        ]
    );
}

function structArrayBytes(array: {arrayBuffer: ArrayBuffer; length: number; bytesPerElement: number}): number[] {
    return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}

describe('ColumnarFillExtrusionBucket', () => {
    test('matches legacy extrusion mesh on a simple polygon', () => {
        const layer = createStyleLayer({
            'fill-extrusion-height': ['get', 'render_height']
        });
        const columnarBucket = new ColumnarFillExtrusionBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<FillExtrusionStyleLayer>);
        const legacyBucket = new FillExtrusionBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<FillExtrusionStyleLayer>);

        const featureTable = createFeatureTable();
        columnarBucket.populate(featureTable, createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
        legacyBucket.populate([{
            id: 1,
            index: 0,
            sourceLayerIndex: 0,
            feature: {
                id: 1,
                type: 3,
                properties: {
                    render_height: 5
                },
                extent: 4096,
                loadGeometry: () => [[
                    new Point(0, 0),
                    new Point(10, 0),
                    new Point(10, 10),
                    new Point(0, 10),
                    new Point(0, 0)
                ]]
            }
        } as any], createPopulateOptions([]), new CanonicalTileID(0, 0, 0));

        expect(structArrayBytes(columnarBucket.layoutVertexArray as any)).toEqual(structArrayBytes(legacyBucket.layoutVertexArray as any));
        expect(structArrayBytes(columnarBucket.centroidVertexArray as any)).toEqual(structArrayBytes(legacyBucket.centroidVertexArray as any));
        expect(structArrayBytes(columnarBucket.indexArray as any)).toEqual(structArrayBytes(legacyBucket.indexArray as any));
        expect(columnarBucket.segments.get()).toEqual(legacyBucket.segments.get());
        expect(columnarBucket.featureIndexBBoxes).toEqual([[0, 0, 20, 20]]);
        expect((featureTable.geometryVector as any).getGeometries).not.toHaveBeenCalled();
    });

    test('defers fill-extrusion-pattern geometry until image positions are available', () => {
        const layer = createStyleLayer({
            'fill-extrusion-pattern': 'pattern'
        });
        const bucket = new ColumnarFillExtrusionBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<FillExtrusionStyleLayer>);
        const options = createPopulateOptions(['pattern']);

        const featureTable = createFeatureTable();
        bucket.populate(featureTable, options, new CanonicalTileID(0, 0, 0));

        expect(options.patternDependencies).toEqual({pattern: true});
        expect(bucket.layoutVertexArray).toHaveLength(0);

        bucket.addFeatures(createBucketDependencies(options, new CanonicalTileID(0, 0, 0), {
            pattern: {
                tlbr: [0, 0, 16, 16],
                pixelRatio: 1
            }
        } as any));

        expect(bucket.layoutVertexArray.length).toBeGreaterThan(0);
        expect(bucket.centroidVertexArray.length).toBeGreaterThan(0);
        expect(bucket.indexArray.length).toBeGreaterThan(0);
        expect((featureTable.geometryVector as any).getGeometries).not.toHaveBeenCalled();
    });
});
