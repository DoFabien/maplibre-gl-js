import {describe, expect, test, vi} from 'vitest';
import {createConstGeometryVector, createStringDictionaryVector, FeatureTable, GEOMETRY_TYPE, IntFlatVector, TopologyVector} from '@maplibre/mlt';
import {ColumnarLineBucket} from './columnar_line_bucket';
import {LineBucket} from '../line_bucket';
import {LineStyleLayer} from '../../../style/style_layer/line_style_layer';
import {MLTVectorTile} from '../../../source/vector_tile_mlt';
import {CanonicalTileID} from '../../../tile/tile_id';
import {createPopulateOptions, getFeaturesFromLayer} from '../../../../test/unit/lib/tile';

import type {EvaluationParameters} from '../../../style/evaluation_parameters';
import type {ZoomHistory} from '../../../style/zoom_history';
import type {BucketParameters} from '../../bucket';

function createLayer(): LineStyleLayer {
    const layer = new LineStyleLayer({
        id: 'roads',
        type: 'line',
        source: 'source',
        paint: {
            'line-color': ['match', ['get', 'class'], 'a', 'red', 'b', 'blue', 'black'],
            'line-opacity': ['case', ['==', ['id'], 1], 1, 0.5]
        }
    }, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

/** Six lines whose class is a, b, a, b, a and missing. */
function createFeatureTable(): FeatureTable {
    const coordinates = Array.from({length: 6}, (_, line) => [0, line * 10, 100, line * 10]).flat();
    return new FeatureTable(
        'roads',
        createConstGeometryVector(6, GEOMETRY_TYPE.LINESTRING, new TopologyVector(null, new Uint32Array([0, 2, 4, 6, 8, 10, 12]), null), null, new Int32Array(coordinates)),
        new IntFlatVector('id', new Int32Array([1, 2, 3, 4, 5, 6]), 6),
        [
            createStringDictionaryVector(['a', 'b', 'a', 'b', 'a', null], 'class'),
            new IntFlatVector('rank', new Int32Array([3, 1, 3, 3, 1, 2]), 6)
        ]
    );
}

function arrayBytes(array: {arrayBuffer: ArrayBuffer; length: number; bytesPerElement: number}): number[] {
    return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}

function paintBytes(bucket: LineBucket, property: string): number[] {
    return arrayBytes((bucket.programConfigurations.get('roads').binders[property] as any).paintVertexArray);
}

describe('ColumnarPaintValues', () => {
    test('evaluates a paint value that reads one dictionary column once per entry, and others once per row', () => {
        const layer = createLayer();
        const color = vi.spyOn((layer.paint as any).get('line-color').value, 'evaluate');
        const opacity = vi.spyOn((layer.paint as any).get('line-opacity').value, 'evaluate');
        const bucket = new ColumnarLineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0, sourceLayerIndex: 0} as BucketParameters<LineStyleLayer>);

        bucket.populateFeatureTable(createFeatureTable(), createPopulateOptions([]), new CanonicalTileID(0, 0, 0));

        expect(color).toHaveBeenCalledTimes(3);
        expect(opacity).toHaveBeenCalledTimes(6);

        color.mockRestore();
        opacity.mockRestore();
        const legacy = new LineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);
        legacy.populate(getFeaturesFromLayer(MLTVectorTile.fromFeatureTables([createFeatureTable()]).layers.roads), createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
        expect(paintBytes(bucket, 'line-color')).toEqual(paintBytes(legacy, 'line-color'));
        expect(paintBytes(bucket, 'line-opacity')).toEqual(paintBytes(legacy, 'line-opacity'));
    });

    test('evaluates values that read one other column once per value, and sort keys once per entry', () => {
        const layer = new LineStyleLayer({
            id: 'roads',
            type: 'line',
            source: 'source',
            layout: {'line-sort-key': ['match', ['get', 'class'], 'a', 1, 2]},
            paint: {'line-width': ['*', ['get', 'rank'], 2]}
        }, {});
        layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
        const sortKey = vi.spyOn((layer.layout as any).get('line-sort-key').value, 'evaluate');
        const width = vi.spyOn((layer.paint as any).get('line-width').value, 'evaluate');
        const bucket = new ColumnarLineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0, sourceLayerIndex: 0} as BucketParameters<LineStyleLayer>);

        bucket.populateFeatureTable(createFeatureTable(), createPopulateOptions([]), new CanonicalTileID(0, 0, 0));

        expect(sortKey).toHaveBeenCalledTimes(3);
        expect(width).toHaveBeenCalledTimes(3);

        sortKey.mockRestore();
        width.mockRestore();
        const legacy = new LineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);
        legacy.populate(getFeaturesFromLayer(MLTVectorTile.fromFeatureTables([createFeatureTable()]).layers.roads), createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
        expect(paintBytes(bucket, 'line-width')).toEqual(paintBytes(legacy, 'line-width'));
        expect(arrayBytes(bucket.layoutVertexArray)).toEqual(arrayBytes(legacy.layoutVertexArray));
    });
});
