import {createBucketDependencies} from '../../../../test/unit/lib/tile.ts';
import fs from 'fs';
import path from 'path';
import {describe, expect, test, vi} from 'vitest';
import {PbfReader} from 'pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {ColumnarLineBucket} from './columnar_line_bucket';
import {LineBucket} from '../line_bucket';
import {MLTVectorTile} from '../../../source/vector_tile_mlt';
import {LineStyleLayer} from '../../../style/style_layer/line_style_layer';
import {
    createConstGeometryVector,
    createSelectionVector,
    FeatureTable,
    GEOMETRY_TYPE,
    IntFlatVector,
    TopologyVector,
} from '@maplibre/mlt';
import {CanonicalTileID} from '../../../tile/tile_id';
import {createPopulateOptions, getFeaturesFromLayer} from '../../../../test/unit/lib/tile';
import Point from '@mapbox/point-geometry';

import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {EvaluationParameters} from '../../../style/evaluation_parameters';
import type {ZoomHistory} from '../../../style/zoom_history';
import type {BucketParameters} from '../../bucket';

function createColumnarLineBucket(layout?: Record<string, any>, paint?: Record<string, any>): ColumnarLineBucket {
    const layer = new LineStyleLayer({
        id: 'test',
        type: 'line',
        layout,
        paint
    } as LayerSpecification, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);

    return new ColumnarLineBucket({layers: [layer]} as BucketParameters<LineStyleLayer>);
}

function structArrayBytes(array: {arrayBuffer: ArrayBuffer; length: number; bytesPerElement: number}): number[] {
    return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}

function createFloatPropertyVector(name: string, value: number) {
    return {
        name,
        size: 1,
        getValue: () => value
    } as any;
}

describe('ColumnarLineBucket', () => {
    test('defers data-driven line-dasharray geometry until dash positions are available', () => {
        const bucket = createColumnarLineBucket(undefined, {
            'line-dasharray': ['case', ['has', 'road_type'], ['literal', [2, 1]], ['literal', [1, 2]]]
        });
        const options = createPopulateOptions([]);
        const featureTable = new FeatureTable(
            'test',
            createConstGeometryVector(
                1,
                GEOMETRY_TYPE.LINESTRING,
                new TopologyVector(null, new Uint32Array([0, 3]), null),
                null,
                new Int32Array([0, 0, 10, 0, 20, 10])
            ),
            new IntFlatVector('id', new Int32Array([1]), 1),
            [
                new IntFlatVector('road_type', new Int32Array([1]), 1)
            ]
        );

        bucket.populate(featureTable, options, new CanonicalTileID(0, 0, 0));

        expect(options.dashDependencies).toEqual({
            '2,1,false': {
                dasharray: [2, 1],
                round: false
            }
        });
        expect(bucket.layoutVertexArray).toHaveLength(0);

        bucket.addFeatures(createBucketDependencies(options, new CanonicalTileID(0, 0, 0), {}, {
            '2,1,false': {y: 0, height: 16, width: 256}
        }));

        expect(bucket.layoutVertexArray.length).toBeGreaterThan(0);
        expect(bucket.indexArray.length).toBeGreaterThan(0);
    });

    test('defers line-pattern geometry until image positions are available', () => {
        const bucket = createColumnarLineBucket(undefined, {
            'line-pattern': 'pattern'
        });
        const options = createPopulateOptions(['pattern']);
        const featureTable = new FeatureTable(
            'test',
            createConstGeometryVector(
                1,
                GEOMETRY_TYPE.LINESTRING,
                new TopologyVector(null, new Uint32Array([0, 3]), null),
                null,
                new Int32Array([0, 0, 10, 0, 20, 10])
            ),
            new IntFlatVector('id', new Int32Array([1]), 1),
            []
        );

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
        expect(bucket.indexArray.length).toBeGreaterThan(0);
    });

    test('uses the data-driven paint path without needing feature materialization', () => {
        const bucket = createColumnarLineBucket(undefined, {
            'line-width': ['get', 'width'],
            'line-opacity': ['coalesce', ['get', 'opacity'], 1]
        });
        const addGeometryParts = (bucket as any).addGeometryParts = vi.fn();

        bucket.populate({
            numFeatures: 2,
            getPropertyVector: () => undefined,
            geometryVector: {
                containsSingleGeometryType: () => true,
                topologyVector: {
                    partOffsets: new Uint32Array([0, 2, 4])
                }
            }
        } as any, createPopulateOptions([]), undefined);

        expect(addGeometryParts).toHaveBeenCalledWith(
            expect.any(Object),
            expect.any(Object),
            undefined,
            true,
            undefined,
            null,
            undefined
        );
        expect((bucket as any).paintIsDataDriven()).toBe(true);
    });

    test('updates feature-state paint arrays without materializing vector tile features', () => {
        const bucket = createColumnarLineBucket(undefined, {
            'line-width': ['case', ['boolean', ['feature-state', 'wide'], false], ['get', 'width'], 1]
        });
        const featureTable = new FeatureTable(
            'test',
            createConstGeometryVector(
                1,
                GEOMETRY_TYPE.LINESTRING,
                new TopologyVector(null, new Uint32Array([0, 2]), null),
                null,
                new Int32Array([0, 0, 10, 0])
            ),
            new IntFlatVector('id', new Int32Array([7]), 1),
            [
                new IntFlatVector('width', new Int32Array([9]), 1)
            ]
        );
        const vtLayer = {
            featureTable,
            feature: vi.fn(() => {
                throw new Error('Unexpected vector tile feature materialization');
            })
        } as any;

        bucket.populate(featureTable, createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
        bucket.stateDependentLayers = bucket.layers;
        bucket.programConfigurations._featureMap.indexed = true;
        bucket.programConfigurations.needsUpload = false;

        bucket.update([{id: '7', state: {wide: true}}], vtLayer, {});

        expect(vtLayer.feature).not.toHaveBeenCalled();
        expect(bucket.programConfigurations.needsUpload).toBe(true);
    });

    test('closes real polygon rings to match the legacy line bucket', () => {
        const tilePath = path.join(__dirname, '../../../../test/integration/assets/tiles/mlt/14/8717/5679.mlt');
        const rawTile = fs.readFileSync(tilePath);
        const tile = new MLTVectorTile(rawTile.buffer.slice(rawTile.byteOffset, rawTile.byteOffset + rawTile.byteLength));
        const sourceLayer = tile.layers.transportation as any;
        const layer = new LineStyleLayer({
            id: 'line-real',
            source: 'source',
            'source-layer': 'transportation',
            type: 'line',
            filter: ['==', ['get', 'class'], 'bridge'],
            paint: {
                'line-width': 1
            }
        }, {});
        layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);

        const bucket = new ColumnarLineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);
        const legacyBucket = new LineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);

        bucket.populate(sourceLayer.featureTable, createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
        legacyBucket.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions([]), new CanonicalTileID(0, 0, 0));

        expect(bucket.layoutVertexArray).toHaveLength(legacyBucket.layoutVertexArray.length);
        expect(Array.from(new Uint8Array(bucket.layoutVertexArray.arrayBuffer, 0, bucket.layoutVertexArray.length * bucket.layoutVertexArray.bytesPerElement)))
            .toEqual(Array.from(new Uint8Array(legacyBucket.layoutVertexArray.arrayBuffer, 0, legacyBucket.layoutVertexArray.length * legacyBucket.layoutVertexArray.bytesPerElement)));
        expect(Array.from(new Uint8Array(bucket.indexArray.arrayBuffer, 0, bucket.indexArray.length * bucket.indexArray.bytesPerElement)))
            .toEqual(Array.from(new Uint8Array(legacyBucket.indexArray.arrayBuffer, 0, legacyBucket.indexArray.length * legacyBucket.indexArray.bytesPerElement)));
    });

    test.each(['mapbox', 'geojsonvt'])('matches legacy line-gradient buffers with %s clip properties', (prefix) => {
        const startKey = `${prefix}_clip_start`;
        const endKey = `${prefix}_clip_end`;
        const layer = new LineStyleLayer({
            id: 'line-clipped',
            source: 'source',
            'source-layer': 'test',
            type: 'line',
            paint: {
                'line-width': 1,
                'line-gradient': [
                    'interpolate',
                    ['linear'],
                    ['line-progress'],
                    0,
                    '#000000',
                    1,
                    '#ffffff'
                ]
            }
        }, {});
        layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);

        const columnarBucket = new ColumnarLineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);
        const legacyBucket = new LineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);
        const featureTable = new FeatureTable(
            'test',
            createConstGeometryVector(
                1,
                GEOMETRY_TYPE.LINESTRING,
                new TopologyVector(null, new Uint32Array([0, 3]), null),
                null,
                new Int32Array([0, 0, 10, 0, 20, 10])
            ),
            new IntFlatVector('id', new Int32Array([1]), 1),
            [
                createFloatPropertyVector(startKey, 0.25),
                createFloatPropertyVector(endKey, 0.75)
            ]
        );

        columnarBucket.populate(featureTable, createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
        legacyBucket.populate([{
            id: 1,
            index: 0,
            sourceLayerIndex: 0,
            feature: {
                id: 1,
                type: 2,
                properties: {
                    [startKey]: 0.25,
                    [endKey]: 0.75
                },
                extent: 4096,
                loadGeometry: () => [[
                    new Point(0, 0),
                    new Point(10, 0),
                    new Point(20, 10)
                ]]
            }
        } as any], createPopulateOptions([]), new CanonicalTileID(0, 0, 0));

        expect(structArrayBytes(columnarBucket.layoutVertexArray as any)).toEqual(structArrayBytes(legacyBucket.layoutVertexArray as any));
        expect(structArrayBytes(columnarBucket.indexArray as any)).toEqual(structArrayBytes(legacyBucket.indexArray as any));
        expect(columnarBucket.segments.get()).toEqual(legacyBucket.segments.get());
        expect(structArrayBytes(columnarBucket.layoutVertexArray2 as any)).toEqual(structArrayBytes(legacyBucket.layoutVertexArray2 as any));
        expect(columnarBucket.lineClipsArray).toEqual(legacyBucket.lineClipsArray);
        expect(columnarBucket.maxLineLength).toBe(legacyBucket.maxLineLength);
    });

    test('matches legacy line-gradient buffers for the synthetic render fixture tile', () => {
        const mltTilePath = path.join(__dirname, '../../../../test/integration/assets/tiles/mlt/line-gradient-synthetic.mlt');
        const rawMltTile = fs.readFileSync(mltTilePath);
        const mltTile = new MLTVectorTile(rawMltTile.buffer.slice(rawMltTile.byteOffset, rawMltTile.byteOffset + rawMltTile.byteLength));
        const mvtTilePath = path.join(__dirname, '../../../../test/integration/assets/tiles/line-gradient-synthetic.mvt');
        const mvtTile = new VectorTile(new PbfReader(fs.readFileSync(mvtTilePath)));

        const layer = new LineStyleLayer({
            id: 'line-gradient-synthetic',
            source: 'source',
            'source-layer': 'gradient',
            type: 'line',
            paint: {
                'line-width': 24,
                'line-gradient': [
                    'interpolate',
                    ['linear'],
                    ['line-progress'],
                    0,
                    'royalblue',
                    0.25,
                    'cyan',
                    0.5,
                    'lime',
                    0.75,
                    'yellow',
                    1,
                    'red'
                ]
            }
        }, {});
        layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);

        const columnarBucket = new ColumnarLineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);
        const legacyBucket = new LineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);

        columnarBucket.populate((mltTile.layers.gradient as any).featureTable, createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
        legacyBucket.populate(getFeaturesFromLayer(mvtTile.layers.gradient), createPopulateOptions([]), new CanonicalTileID(0, 0, 0));

        expect(columnarBucket.isEmpty()).toBe(false);
        expect(legacyBucket.isEmpty()).toBe(false);
        expect(structArrayBytes(columnarBucket.layoutVertexArray as any)).toEqual(structArrayBytes(legacyBucket.layoutVertexArray as any));
        expect(structArrayBytes(columnarBucket.indexArray as any)).toEqual(structArrayBytes(legacyBucket.indexArray as any));
        expect(columnarBucket.segments.get()).toEqual(legacyBucket.segments.get());
        expect(structArrayBytes(columnarBucket.layoutVertexArray2 as any)).toEqual(structArrayBytes(legacyBucket.layoutVertexArray2 as any));
        expect(columnarBucket.lineClipsArray).toEqual(legacyBucket.lineClipsArray);
        expect(columnarBucket.maxLineLength).toBe(legacyBucket.maxLineLength);
    });

    test('uses ring offsets for mixed linestrings when geometry offsets are absent', () => {
        const bucket = createColumnarLineBucket();
        const addLine = vi.spyOn(bucket, 'addLine').mockReturnValue(undefined);
        vi.spyOn(bucket as any, 'populateFeaturePaintArrays').mockReturnValue(undefined);

        const featureTable = {
            extent: 4096,
            numFeatures: 4,
            idVector: undefined,
            propertyVectors: undefined,
            getPropertyVector: () => undefined,
            geometryVector: {
                numGeometries: 4,
                containsSingleGeometryType: () => false,
                geometryType: (index: number) => [
                    GEOMETRY_TYPE.POINT,
                    GEOMETRY_TYPE.LINESTRING,
                    GEOMETRY_TYPE.LINESTRING,
                    GEOMETRY_TYPE.POLYGON
                ][index],
                topologyVector: {
                    geometryOffsets: null,
                    partOffsets: new Uint32Array([0, 1, 2, 3, 5]),
                    ringOffsets: new Uint32Array([0, 1, 4, 6, 10, 13])
                }
            }
        } as any;

        (bucket as any).populateSelectedLineFeatures(
            featureTable,
            createSelectionVector(featureTable.numFeatures),
            new CanonicalTileID(0, 0, 0),
            false,
            undefined,
            null,
            undefined
        );

        const lineCalls = addLine.mock.calls.map((call) => ({
            startOffset: call[1],
            endOffset: call[2],
            isPolygon: call[3]
        }));

        expect(lineCalls).toEqual([
            {startOffset: 0, endOffset: 1, isPolygon: false},
            {startOffset: 1, endOffset: 4, isPolygon: false},
            {startOffset: 4, endOffset: 6, isPolygon: false},
            {startOffset: 6, endOffset: 10, isPolygon: true},
            {startOffset: 10, endOffset: 13, isPolygon: true}
        ]);
    });
});
