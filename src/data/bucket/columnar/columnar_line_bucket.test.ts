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
    FeatureTable,
    GEOMETRY_TYPE,
    IntFlatVector,
    TopologyVector,
} from '@maplibre/mlt';
import {CanonicalTileID} from '../../../tile/tile_id';
import {createPopulateOptions, getFeaturesFromLayer} from '../../../../test/unit/lib/tile';
import Point from '@mapbox/point-geometry';
import {EXTENT} from '../../extent';
import {GEOJSONVT_CLIP_END, GEOJSONVT_CLIP_START} from '@maplibre/geojson-vt';

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

    return new ColumnarLineBucket({layers: [layer], sourceLayerIndex: 0} as BucketParameters<LineStyleLayer>);
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
    test('reads Morton-encoded vertices like plain vertices, including duplicate end trimming', () => {
        // First line: duplicated first and last vertices; second line: longer than the short-line sizes.
        const coordinates = [
            0, 0, 0, 0, 100, 0, 100, 100, 200, 150, 200, 150,
            ...Array.from({length: 12}, (_, i) => [300 + i * 50, (i % 2) * 80]).flat()
        ];
        const partOffsets = new Uint32Array([0, 6, 18]);
        const plainVector = createConstGeometryVector(2, GEOMETRY_TYPE.LINESTRING, new TopologyVector(null, partOffsets, null), undefined, new Int32Array(coordinates));
        const vertexCount = coordinates.length / 2;
        const mortonVector = {
            numGeometries: 2,
            geometryType: () => GEOMETRY_TYPE.LINESTRING,
            containsPolygonGeometry: () => false,
            containsSingleGeometryType: () => true,
            topologyVector: new TopologyVector(null, partOffsets, null),
            vertexOffsets: Uint32Array.from({length: vertexCount}, (_, i) => i),
            // Morton codes must only be read through getVertex.
            vertexBuffer: new Int32Array(vertexCount).fill(-12345),
            mortonSettings: {numBits: 16, coordinateShift: 0},
            getVertex: (index: number): [number, number] => [coordinates[index * 2], coordinates[index * 2 + 1]],
        };

        const populate = (geometryVector: unknown) => {
            const bucket = createColumnarLineBucket({'line-join': 'round', 'line-cap': 'round'});
            const options = createPopulateOptions([]);
            bucket.populateFeatureTable(new FeatureTable('test', geometryVector as any, undefined, []), options, new CanonicalTileID(0, 0, 0));
            return {bucket, featureIndex: options.featureIndex};
        };
        const plain = populate(plainVector);
        const morton = populate(mortonVector);

        expect(plain.bucket.layoutVertexArray.length).toBeGreaterThan(0);
        expect(structArrayBytes(morton.bucket.layoutVertexArray)).toEqual(structArrayBytes(plain.bucket.layoutVertexArray));
        expect(structArrayBytes(morton.bucket.indexArray)).toEqual(structArrayBytes(plain.bucket.indexArray));
        expect(plain.featureIndex.featureIndexArray).toHaveLength(2);
        expect(structArrayBytes(morton.featureIndex.featureIndexArray)).toEqual(structArrayBytes(plain.featureIndex.featureIndexArray));
        expect(new Uint8Array(morton.featureIndex.grid.toArrayBuffer())).toEqual(new Uint8Array(plain.featureIndex.grid.toArrayBuffer()));
    });

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

        bucket.populateFeatureTable(featureTable, options, new CanonicalTileID(0, 0, 0));

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

        bucket.populateFeatureTable(featureTable, options, new CanonicalTileID(0, 0, 0));

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

    test('updates feature-state paint arrays from the vector tile layer', () => {
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
        const vtLayer = MLTVectorTile.fromFeatureTables([featureTable]).layers.test;

        bucket.populateFeatureTable(featureTable, createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
        bucket.stateDependentLayers = bucket.layers;
        bucket.programConfigurations._featureMap.indexed = true;
        bucket.programConfigurations.needsUpload = false;

        bucket.update([{id: '7', state: {wide: true}}], vtLayer, {}, {});

        const paint = (bucket.programConfigurations.get(bucket.layers[0].id).binders['line-width'] as any).paintVertexArray;
        expect(new Set(new Float32Array(paint.arrayBuffer, 0, paint.length))).toEqual(new Set([9]));
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

        const bucket = new ColumnarLineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0, sourceLayerIndex: 0} as BucketParameters<LineStyleLayer>);
        const legacyBucket = new LineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);

        bucket.populateFeatureTable(sourceLayer.featureTable, createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
        legacyBucket.populate(getFeaturesFromLayer(sourceLayer), createPopulateOptions([]), new CanonicalTileID(0, 0, 0));

        expect(bucket.layoutVertexArray).toHaveLength(legacyBucket.layoutVertexArray.length);
        expect(Array.from(new Uint8Array(bucket.layoutVertexArray.arrayBuffer, 0, bucket.layoutVertexArray.length * bucket.layoutVertexArray.bytesPerElement)))
            .toEqual(Array.from(new Uint8Array(legacyBucket.layoutVertexArray.arrayBuffer, 0, legacyBucket.layoutVertexArray.length * legacyBucket.layoutVertexArray.bytesPerElement)));
        expect(Array.from(new Uint8Array(bucket.indexArray.arrayBuffer, 0, bucket.indexArray.length * bucket.indexArray.bytesPerElement)))
            .toEqual(Array.from(new Uint8Array(legacyBucket.indexArray.arrayBuffer, 0, legacyBucket.indexArray.length * legacyBucket.indexArray.bytesPerElement)));
    });

    test('matches legacy line-gradient buffers with geojsonvt clip properties', () => {
        const startKey = GEOJSONVT_CLIP_START;
        const endKey = GEOJSONVT_CLIP_END;
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

        const columnarBucket = new ColumnarLineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0, sourceLayerIndex: 0} as BucketParameters<LineStyleLayer>);
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

        columnarBucket.populateFeatureTable(featureTable, createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
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

        const columnarBucket = new ColumnarLineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0, sourceLayerIndex: 0} as BucketParameters<LineStyleLayer>);
        const legacyBucket = new LineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);

        columnarBucket.populateFeatureTable((mltTile.layers.gradient as any).featureTable, createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
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
        const addFeature = vi.spyOn(bucket, 'addFeature').mockReturnValue(undefined);

        const featureTable = {
            name: 'test',
            extent: EXTENT,
            numFeatures: 4,
            idVector: undefined,
            propertyVectors: [],
            availablePropertyNames: [],
            getPropertyVector: () => undefined,
            materializePropertyVectors: () => [],
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
                },
                vertexBuffer: new Int32Array(Array.from({length: 13}, (_, i) => [i, 0]).flat())
            }
        } as any;

        bucket.populateFeatureTable(featureTable, createPopulateOptions([]), new CanonicalTileID(0, 0, 0));

        const lineVertices = addFeature.mock.calls.map(([, geometry]) => geometry.map(line => line.map(point => point.x)));

        expect(lineVertices).toEqual([
            [[0]],
            [[1, 2, 3]],
            [[4, 5]],
            [[6, 7, 8, 9, 6], [10, 11, 12, 10]]
        ]);
    });
});
