import {describe, expect, test, vi} from 'vitest';
import {ColumnarFillBucket} from './columnar_fill_bucket';
import {FillBucket} from '../fill_bucket';
import {FillStyleLayer} from '../../../style/style_layer/fill_style_layer';
import {createBucketDependencies, createPopulateOptions} from '../../../../test/unit/lib/tile';
import {createSyntheticLegacyPolygonFeatures, createSyntheticPolygonFeatureTable, syntheticPolygonFeatures} from '../../../../test/unit/lib/mlt_synthetic';
import {CanonicalTileID} from '../../../tile/tile_id';

import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {EvaluationParameters} from '../../../style/evaluation_parameters';
import type {ZoomHistory} from '../../../style/zoom_history';
import type {BucketParameters} from '../../bucket';

const canonical = new CanonicalTileID(0, 0, 0);

function createColumnarFillBucket(layout?: Record<string, any>, paint?: Record<string, any>): ColumnarFillBucket {
    const layer = new FillStyleLayer({
        id: 'test',
        type: 'fill',
        layout,
        paint
    } as LayerSpecification, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);

    return new ColumnarFillBucket({layers: [layer], sourceLayerIndex: 0} as BucketParameters<FillStyleLayer>);
}

function structArrayBytes(array: {arrayBuffer: ArrayBuffer; length: number; bytesPerElement: number}): number[] {
    return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}

describe('ColumnarFillBucket', () => {
    test('defers fill-pattern geometry until image positions are available', () => {
        const bucket = createColumnarFillBucket(undefined, {'fill-pattern': 'pattern'});
        const featureTable = createSyntheticPolygonFeatureTable(syntheticPolygonFeatures().slice(0, 1));
        const getGeometries = vi.spyOn(featureTable.geometryVector, 'getGeometries');
        const options = createPopulateOptions(['pattern']);

        bucket.populateFeatureTable(featureTable, options, canonical);

        expect(options.patternDependencies).toEqual({pattern: true});
        expect(bucket.layoutVertexArray).toHaveLength(0);

        bucket.addFeatures(createBucketDependencies(options, canonical, {
            pattern: {
                tlbr: [0, 0, 16, 16],
                pixelRatio: 1
            }
        } as any));

        expect(bucket.layoutVertexArray.length).toBeGreaterThan(0);
        expect(bucket.indexArray.length).toBeGreaterThan(0);
        expect(getGeometries).not.toHaveBeenCalled();
    });

    test('orders features by fill-sort-key', () => {
        const bucket = createColumnarFillBucket({'fill-sort-key': ['get', 'sort']});

        const options = createPopulateOptions([]);

        bucket.populateFeatureTable(createSyntheticPolygonFeatureTable(), options, canonical);

        const indexedFeatures = options.featureIndex.featureIndexArray;
        expect(Array.from({length: indexedFeatures.length}, (_, i) => indexedFeatures.get(i).featureIndex)).toEqual([1, 2, 0, 3]);
    });

    test('writes outlines, paint arrays keyed by feature id and feature index entries like legacy', () => {
        const bucket = createColumnarFillBucket(undefined, {
            'fill-opacity': ['case', ['has', 'opacity'], 0.75, 0.25]
        });
        const legacyBucket = new FillBucket({layers: bucket.layers} as BucketParameters<FillStyleLayer>);
        const features = syntheticPolygonFeatures().slice(0, 2);
        const options = createPopulateOptions([]);
        const legacyOptions = createPopulateOptions([]);

        bucket.populateFeatureTable(createSyntheticPolygonFeatureTable(features), options, canonical);
        legacyBucket.populate(createSyntheticLegacyPolygonFeatures(features), legacyOptions, canonical);

        expect(bucket.layoutVertexArray.length).toBeGreaterThan(0);
        expect(bucket.indexArray.length).toBeGreaterThan(0);
        expect(bucket.indexArray2.length).toBeGreaterThan(0);
        expect(bucket.programConfigurations._featureMap.ids).toEqual([21]);
        expect(options.featureIndex.featureIndexArray).toHaveLength(2);
        expect(structArrayBytes(options.featureIndex.featureIndexArray)).toEqual(structArrayBytes(legacyOptions.featureIndex.featureIndexArray));
        expect(new Uint8Array(options.featureIndex.grid.toArrayBuffer())).toEqual(new Uint8Array(legacyOptions.featureIndex.grid.toArrayBuffer()));
    });
});
