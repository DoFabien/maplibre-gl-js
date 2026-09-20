import path from 'path';
import {readFileSync} from 'fs';
import {describe, expect, test, vi} from 'vitest';
import {FeatureIndex, GEOJSON_TILE_LAYER_NAME, type QueryResults} from './feature_index.ts';
import {type Feature, fromVectorTileJs, GeoJSONWrapper, type VectorTileFeatureLike} from '@maplibre/vt-pbf';
import {MercatorTransform} from '../geo/projection/mercator_transform.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {CircleStyleLayer} from '../style/style_layer/circle_style_layer.ts';
import Point from '@mapbox/point-geometry';
import {DictionaryCoder} from '../util/dictionary_coder.ts';
import {getMltFeatureTable, MLTVectorTile} from '../source/vector_tile_mlt.ts';
import {createConstGeometryVector, encodeFeatureTables, FeatureTable, GEOMETRY_TYPE, IntFlatVector, TopologyVector, type Vector} from '@maplibre/mlt';
import {activateMltMaterializationStats, createMltMaterializationStats, MLT_ESTIMATED_GEOJSON_QUERY_RESULT_BYTES, MLT_ESTIMATED_RENDERED_QUERY_WRAPPER_BYTES} from '../util/mlt_materialization_stats.ts';
import {serialize, deserialize} from '../util/web_worker_transfer.ts';
import {WorkerTile} from '../source/worker_tile.ts';
import {StyleLayerIndex} from '../style/style_layer_index.ts';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';

import type {EvaluationParameters} from '../style/evaluation_parameters.ts';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {WorkerTileParameters} from '../source/worker_source.ts';

describe('FeatureIndex', () => {
    describe('getId', () => {
        const tileID = new OverscaledTileID(0, 0, 0, 0, 0);

        function createIdentityFeatureTable(idVector?: IntFlatVector, propertyVectors: Vector[] = []): FeatureTable {
            return new FeatureTable(
                'sourceLayer',
                createConstGeometryVector(
                    4,
                    GEOMETRY_TYPE.POINT,
                    new TopologyVector(null, null, null),
                    null,
                    new Int32Array([0, 0, 1, 1, 2, 2, 3, 3]),
                ),
                idVector,
                propertyVectors,
            );
        }

        function createPropertyVector(name: string, values: unknown[]): Vector {
            return {
                name,
                size: values.length,
                getValue: (index: number) => values[index] ?? null,
                has: (index: number) => values[index] !== null && values[index] !== undefined,
            } as unknown as Vector;
        }

        test('uses cluster_id when cluster is true and id is undefined', () => {
            const featureIndex = new FeatureIndex(tileID, 'someProperty');
            const feature: VectorTileFeatureLike = {
                id: 0,
                properties: {
                    cluster: true,
                    cluster_id: '123',
                    promoteId: 'someProperty',
                    someProperty: undefined
                },
                extent: 4096,
                type: 1,
                loadGeometry: () => [],
            };

            expect(featureIndex.getId(feature, 'sourceLayer')).toBe(123); // cluster_id converted to number
        });

        test('reads native, missing, and signed MLT ids without a feature wrapper', () => {
            const signedId = -1814668313;
            const withIds = createIdentityFeatureTable(
                new IntFlatVector('id', new Int32Array([7, signedId, 9, 10]), 4),
            );
            const withoutIds = createIdentityFeatureTable();
            const featureIndex = new FeatureIndex(tileID);
            const stats = createMltMaterializationStats();
            const deactivate = activateMltMaterializationStats(stats);

            try {
                expect(featureIndex.getMltId(withIds, 0, 'sourceLayer')).toBe(7);
                expect(featureIndex.getMltId(withIds, 1, 'sourceLayer')).toBe(18446744071894882000);
                expect(featureIndex.getMltId(withoutIds, 2, 'sourceLayer')).toBe(2);
            } finally {
                deactivate();
            }

            expect(stats.counters.vectorTileFeatureWrappers).toBe(0);
            expect(stats.counters.propertyObjects).toBe(0);
            expect(stats.counters.propertyProxyMisses).toBe(0);
        });

        test('reads MLT promoteId, boolean, missing, and cluster fallback directly from columns', () => {
            const featureTable = createIdentityFeatureTable(
                new IntFlatVector('id', new Int32Array([11, 12, 13, 14]), 4),
                [
                    createPropertyVector('promoted', ['road-a', true, null, null]),
                    createPropertyVector('cluster', [false, false, false, true]),
                    createPropertyVector('cluster_id', [null, null, null, '123']),
                ],
            );
            const featureIndex = new FeatureIndex(tileID, {sourceLayer: 'promoted'});
            const stats = createMltMaterializationStats();
            const deactivate = activateMltMaterializationStats(stats);

            try {
                expect(featureIndex.getMltId(featureTable, 0, 'sourceLayer')).toBe('road-a');
                expect(featureIndex.getMltId(featureTable, 1, 'sourceLayer')).toBe(1);
                expect(featureIndex.getMltId(featureTable, 2, 'sourceLayer')).toBeUndefined();
                expect(featureIndex.getMltId(featureTable, 3, 'sourceLayer')).toBe(123);
            } finally {
                deactivate();
            }

            expect(stats.counters.vectorTileFeatureWrappers).toBe(0);
            expect(stats.counters.propertyObjects).toBe(0);
            expect(stats.counters.propertyProxyMisses).toBe(0);
        });
    });

    describe('query', () => {
        const tileID = new OverscaledTileID(3, 0, 2, 1, 2);
        const transform = new MercatorTransform();
        transform.resize(500, 500);

        function createMltPointFeatureTable(): FeatureTable {
            return new FeatureTable(
                'test',
                createConstGeometryVector(
                    3,
                    GEOMETRY_TYPE.POINT,
                    new TopologyVector(null, null, null),
                    null,
                    new Int32Array([10, 10, 20, 20, 30, 30])
                ),
                new IntFlatVector('id', new Int32Array([101, 102, 103]), 3),
                [
                    new IntFlatVector('rank', new Int32Array([1, 2, 3]), 3)
                ]
            );
        }

        function createQueryableMltFeatureIndex(featureTable: FeatureTable): FeatureIndex {
            const featureIndex = new FeatureIndex(tileID);
            featureIndex.encoding = 'mlt';
            featureIndex.rawTileData = new ArrayBuffer(0);
            featureIndex.bucketLayerIDs = [['layer']];
            featureIndex.sourceLayerCoder = new DictionaryCoder(['test']);
            featureIndex.vtLayers = MLTVectorTile.fromFeatureTables([featureTable]).layers;
            return featureIndex;
        }

        function createQueryLayer(): CircleStyleLayer {
            const layer = new CircleStyleLayer({
                id: 'layer',
                source: 'source',
                'source-layer': 'test',
                type: 'circle',
                paint: {}
            }, {});
            layer.recalculate({} as EvaluationParameters, []);
            layer.queryIntersectsFeature = vi.fn(() => true);
            return layer;
        }

        function createIntersectingQueryLayer(): CircleStyleLayer {
            const layer = new CircleStyleLayer({
                id: 'layer',
                source: 'source',
                'source-layer': 'test',
                type: 'circle',
                paint: {}
            }, {});
            layer.recalculate({} as EvaluationParameters, []);
            return layer;
        }

        function queryMltFeatureIndex(featureIndex: FeatureIndex, layer: CircleStyleLayer, params: Record<string, any> = {}) {
            return featureIndex.query({
                queryPadding: 0,
                tileSize: 512,
                scale: 1,
                queryGeometry: [new Point(0, 0), new Point(100, 100)],
                cameraQueryGeometry: [new Point(0, 0), new Point(100, 100)],
                params,
                transform
            } as any, {
                layer,
            }, {
                layer: {
                    id: 'layer',
                    source: 'source',
                    'source-layer': 'test',
                    type: 'circle',
                    paint: {},
                    layout: {}
                }
            }, undefined);
        }

        test('rendered MLT filters use effective zoom without public materialization', () => {
            const table = createMltPointFeatureTable();
            const index = createQueryableMltFeatureIndex(table);
            for (let i = 0; i < 3; i++) index.insertBBox(i, 0, 0, [20 * (i + 1), 20 * (i + 1), 20 * (i + 1), 20 * (i + 1)], false);
            const layer = createQueryLayer();
            const stats = createMltMaterializationStats({strict: true});
            const restore = activateMltMaterializationStats(stats);
            try {
                const result = queryMltFeatureIndex(index, layer, {filter: ['all', ['==', ['zoom'], 3], ['is-supported-script', 'Paris'], ['==', ['get', 'rank'], 2]]});
                expect(result.layer.map(r => r.feature.id)).toEqual([102]);
                expect(queryMltFeatureIndex(index, layer, {filter: ['==', ['zoom'], 2]})).toEqual({});
            } finally {
                restore();
            }
            for (const counter of stats.forbiddenCounters) expect(stats.counters[counter]).toBe(0);
        });

        test('filter with global-state', () => {
            const features = [
                {
                    type: 1,
                    geometry: [0, 0],
                    tags: {cluster: true}
                }  as any as Feature
            ];
            const geojsonWrapper = new GeoJSONWrapper(features);
            geojsonWrapper.name = GEOJSON_TILE_LAYER_NAME;
            const rawTileData = fromVectorTileJs({layers: {[GEOJSON_TILE_LAYER_NAME]: geojsonWrapper}});
            const globalState = {isCluster: true};
            const layer = new CircleStyleLayer({source: 'source', paint: {}} as LayerSpecification, globalState);
            layer.recalculate({} as EvaluationParameters, []);
            const featureIndex = new FeatureIndex(tileID);
            featureIndex.rawTileData = rawTileData as any as ArrayBuffer;
            featureIndex.bucketLayerIDs = [['layer']];
            featureIndex.insert(geojsonWrapper.feature(0), [[new Point(1, 1)]], 0, 0, 0);

            const result = featureIndex.query({
                queryPadding: 0,
                tileSize: 512,
                scale: 1,
                queryGeometry: [new Point(0, 0), new Point(10, 10)],
                cameraQueryGeometry: [new Point(0, 0), new Point(10, 10)],
                params: {
                    filter: ['==', ['get', 'cluster'], ['global-state', 'isCluster']],
                    globalState
                },
                transform
            } as any, {
                layer,
            }, [], undefined);
            expect(result.layer[0].feature.properties).toEqual(features[0].tags);
        });

        test('query mlt tile', () => {
            const layer = new CircleStyleLayer({source: 'source', paint: {}} as LayerSpecification, {});
            layer.recalculate({} as EvaluationParameters, []);
            const featureIndex = new FeatureIndex(tileID);
            featureIndex.rawTileData = readFileSync(path.join(__dirname, '../../test/integration/assets/tiles/mlt/5/17/10.mlt')).buffer.slice(0);
            featureIndex.encoding = 'mlt';
            featureIndex.bucketLayerIDs = [['layer']];
            featureIndex.insert({} as any, [[new Point(1, 1)]], 0, 0, 0);
            const vtLayers = featureIndex.loadVTLayers();
            const featureTable = getMltFeatureTable(vtLayers[Object.keys(vtLayers)[0]]);
            expect(featureTable?.propertyVectors).toEqual([]);
            const result = featureIndex.query({
                queryPadding: 0,
                tileSize: 512,
                scale: 1,
                queryGeometry: [new Point(0, 0), new Point(0, 2000), new Point(2000, 2000), new Point(2000, 0), new Point(0 ,0)],
                cameraQueryGeometry: [new Point(0, 0), new Point(10, 10)],
                params: {},
                transform
            } as any, {
                layer,
            }, [], undefined);
            expect(featureTable?.propertyVectors).toEqual([]);
            expect(result.layer[0].feature.properties.admin_level).toBeDefined();
            expect(featureTable?.propertyVectors?.length).toBeGreaterThan(0);
            expect(result.layer[0].feature.geometry.type).toBe('LineString');
        });

        test('queries the projected worker layers after transfer against the complete raw MLT tile', async () => {
            const selected = createMltPointFeatureTable();
            const unused = new FeatureTable('aaa-unused', createConstGeometryVector(
                1, GEOMETRY_TYPE.POINT, new TopologyVector(null, null, null), null, new Int32Array([10, 10])
            ), new IntFlatVector('id', new Int32Array([999]), 1));
            const rawTileData = encodeFeatureTables([unused, selected]);
            const projected = new MLTVectorTile(rawTileData, {layerNames: ['test']});
            const workerTile = new WorkerTile({
                tileID, uid: 'projected', source: 'source', zoom: 3, tileSize: 512, pixelRatio: 1, encoding: 'mlt'
            } as WorkerTileParameters);
            const layerSpec: LayerSpecification = {id: 'layer', source: 'source', 'source-layer': 'test', type: 'circle'};
            const parsed = await workerTile.parse(projected, new StyleLayerIndex([layerSpec]), [],
                {sendAsync: vi.fn(async () => ({}))}, SubdivisionGranularitySetting.noSubdivision);
            expect(parsed.featureIndex.featureIndexArray).toHaveLength(3);
            const transferred = deserialize(serialize(parsed.featureIndex)) as FeatureIndex;
            transferred.encoding = 'mlt';
            transferred.rawTileData = rawTileData;

            const result = queryMltFeatureIndex(transferred, createIntersectingQueryLayer());

            expect(result.layer.map(entry => entry.feature.id).sort()).toEqual([101, 102, 103]);
            expect(result.layer.map(entry => entry.feature.properties.rank).sort()).toEqual([1, 2, 3]);
            expect(Object.keys(transferred.loadVTLayers()).sort()).toEqual(['aaa-unused', 'test']);
            expect(transferred.sourceLayerCoder.decode(0)).toBe('test');
        });

        test('query mlt tile with a supported filter and columnar feature table index', () => {
            const featureTable = createMltPointFeatureTable();
            const featureIndex = createQueryableMltFeatureIndex(featureTable);
            featureIndex.insertFeatureTable(featureTable, 1, 0, 0);

            const result = queryMltFeatureIndex(featureIndex, createQueryLayer(), {
                filter: ['==', ['get', 'rank'], 2]
            });

            expect(result.layer).toHaveLength(1);
            expect(result.layer[0].feature.id).toBe(102);
            expect(result.layer[0].feature.properties.rank).toBe(2);
        });

        test('filters MLT query candidates before creating result wrappers', () => {
            const featureTable = createMltPointFeatureTable();
            const featureIndex = createQueryableMltFeatureIndex(featureTable);
            for (let featureIndexInLayer = 0; featureIndexInLayer < featureTable.numFeatures; featureIndexInLayer++) {
                featureIndex.insertFeatureTable(featureTable, featureIndexInLayer, 0, 0);
            }
            const stats = createMltMaterializationStats();
            const deactivate = activateMltMaterializationStats(stats);
            let result;

            try {
                result = queryMltFeatureIndex(featureIndex, createQueryLayer(), {
                    filter: ['==', ['get', 'rank'], 2]
                });
            } finally {
                deactivate();
            }

            expect(result.layer).toHaveLength(1);
            expect(result.layer[0].feature.id).toBe(102);
            expect(stats.counters.queryCandidates).toBe(3);
            expect(stats.counters.queryResults).toBe(1);
            expect(stats.counters.estimatedQueryResultBytes).toBe(MLT_ESTIMATED_GEOJSON_QUERY_RESULT_BYTES + MLT_ESTIMATED_RENDERED_QUERY_WRAPPER_BYTES);
            expect(stats.counters.vectorTileFeatureWrappers).toBe(0);
            expect(stats.counters.propertyObjects).toBe(0);
            expect(stats.counters.queryGeometriesLoaded).toBe(0);
            expect(stats.counters.geometryPartsMaterialized).toBe(0);
            expect(stats.counters.pointObjects).toBe(0);
        });

        test('builds many rendered MLT results lazily with independent public objects', () => {
            const featureCount = 640;
            const featureTable = new FeatureTable(
                'test',
                createConstGeometryVector(
                    featureCount,
                    GEOMETRY_TYPE.POINT,
                    new TopologyVector(null, null, null),
                    null,
                    new Int32Array(featureCount * 2).fill(10),
                ),
                new IntFlatVector(
                    'id',
                    Int32Array.from({length: featureCount}, (_, index) => 1000 + index),
                    featureCount,
                ),
                [new IntFlatVector(
                    'rank',
                    Int32Array.from({length: featureCount}, (_, index) => index),
                    featureCount,
                )],
            );
            const featureIndex = createQueryableMltFeatureIndex(featureTable);
            for (let index = 0; index < featureCount; index++) {
                featureIndex.insertBBox(index, 0, 0, [10, 10, 10, 10]);
            }
            const layer = createQueryLayer();
            const stats = createMltMaterializationStats();
            const deactivate = activateMltMaterializationStats(stats);
            let result;

            try {
                result = queryMltFeatureIndex(featureIndex, layer);
                expect(result.layer).toHaveLength(featureCount);
                expect(stats.counters.queryCandidates).toBe(featureCount);
                expect(stats.counters.queryResults).toBe(featureCount);
                expect(stats.counters.estimatedQueryResultBytes).toBe(featureCount * (MLT_ESTIMATED_GEOJSON_QUERY_RESULT_BYTES + MLT_ESTIMATED_RENDERED_QUERY_WRAPPER_BYTES));
                expect(stats.counters.vectorTileFeatureWrappers).toBe(0);
                expect(stats.counters.propertyObjects).toBe(0);
                expect(stats.counters.queryGeometriesLoaded).toBe(0);
                expect(stats.counters.geometryPartsMaterialized).toBe(0);
                expect(stats.counters.pointObjects).toBe(0);

                expect(new Set([result.layer[0].feature, result.layer[1].feature])).toHaveLength(2);
                expect(result.layer[0].feature.id).toBe(1639);
                expect(result.layer[featureCount - 1].feature.id).toBe(1000);
                const firstProperties = result.layer[0].feature.properties;
                expect(stats.counters.propertyObjects).toBe(1);
                expect(firstProperties.rank).toBe(639);
                firstProperties.rank = -1;
                expect(result.layer[1].feature.properties.rank).toBe(638);
                result.layer[0].feature.layer.paint.localMutation = true;
                expect(result.layer[1].feature.layer.paint.localMutation).toBeUndefined();
            } finally {
                deactivate();
            }

            const nextResult = queryMltFeatureIndex(featureIndex, layer);
            expect(nextResult.layer[0].feature).not.toBe(result.layer[0].feature);
            expect(nextResult.layer[0].feature.properties.rank).toBe(639);
        });

        test('preserves serialized constant layer values without a possibly-evaluated property set', () => {
            const featureTable = createMltPointFeatureTable();
            const featureIndex = createQueryableMltFeatureIndex(featureTable);
            const layer = createQueryLayer() as any;
            layer.paint = undefined;
            layer.layout = undefined;
            const result: QueryResults = {};

            featureIndex.loadMatchingFeature(
                result,
                0,
                0,
                1,
                undefined,
                undefined,
                [],
                {layer},
                {layer: {
                    id: 'layer',
                    source: 'source',
                    'source-layer': 'test',
                    type: 'circle',
                    paint: {'circle-radius': 7},
                    layout: {visibility: 'visible'},
                }},
                undefined,
                undefined,
                () => true,
            );

            const resultFeature = result.layer[0].feature as any;
            expect(resultFeature.layer.paint).toEqual({'circle-radius': 7});
            expect(resultFeature.layer.layout).toEqual({visibility: 'visible'});
        });

        test('reads rendered-query promoteId directly from the MLT column', () => {
            const featureTable = createMltPointFeatureTable();
            const featureIndex = createQueryableMltFeatureIndex(featureTable);
            featureIndex.promoteId = 'rank';
            featureIndex.insertFeatureTable(featureTable, 1, 0, 0);
            const stats = createMltMaterializationStats();
            const deactivate = activateMltMaterializationStats(stats);
            let result;

            try {
                result = queryMltFeatureIndex(featureIndex, createQueryLayer(), {
                    filter: ['==', ['get', 'rank'], 2]
                });
            } finally {
                deactivate();
            }

            expect(result.layer).toHaveLength(1);
            expect(result.layer[0].feature.id).toBe(2);
            expect(stats.counters.vectorTileFeatureWrappers).toBe(0);
            expect(stats.counters.propertyProxyMisses).toBe(0);
        });

        test('intersects an MLT point through the columnar geometry view', () => {
            const featureTable = createMltPointFeatureTable();
            const featureIndex = createQueryableMltFeatureIndex(featureTable);
            featureIndex.insertFeatureTable(featureTable, 1, 0, 0);
            const layer = createIntersectingQueryLayer();
            const intersection = vi.spyOn(layer, 'queryIntersectsFeature');
            const stats = createMltMaterializationStats();
            const deactivate = activateMltMaterializationStats(stats);
            let result;

            try {
                result = queryMltFeatureIndex(featureIndex, layer, {
                    filter: ['==', ['get', 'rank'], 2]
                });
            } finally {
                deactivate();
            }

            expect(result.layer).toHaveLength(1);
            expect(intersection).toHaveBeenCalledTimes(1);
            expect(intersection.mock.calls[0][0].geometry).toMatchObject({
                getPartLength: expect.any(Function),
                getX: expect.any(Function),
                getY: expect.any(Function),
            });
            expect(stats.counters.queryGeometriesLoaded).toBe(1);
            expect(stats.counters.geometryPartsMaterialized).toBe(0);
            expect(stats.counters.pointObjects).toBe(0);
        });

        test('reuses geometry loaded by a generic query filter for intersection', () => {
            const featureTable = createMltPointFeatureTable();
            const featureIndex = createQueryableMltFeatureIndex(featureTable);
            const layer = createQueryLayer();
            const result: QueryResults = {};
            let filterGeometry;
            const filter = {
                needGeometry: true,
                filter: vi.fn((_parameters, evaluationFeature) => {
                    filterGeometry = evaluationFeature.geometry;
                    return true;
                })
            } as any;
            const intersection = vi.fn((_feature, _styleLayer, _featureState, _id, geometry) => geometry === filterGeometry);
            const stats = createMltMaterializationStats();
            const deactivate = activateMltMaterializationStats(stats);

            try {
                featureIndex.loadMatchingFeature(
                    result,
                    0,
                    0,
                    1,
                    filter,
                    undefined,
                    [],
                    {layer},
                    {layer: {id: 'layer', source: 'source', 'source-layer': 'test', type: 'circle', paint: {}, layout: {}}},
                    undefined,
                    undefined,
                    intersection,
                );
            } finally {
                deactivate();
            }

            expect(result.layer).toHaveLength(1);
            expect(intersection).toHaveBeenCalledTimes(1);
            expect(intersection.mock.calls[0][4]).toBe(filterGeometry);
            expect(stats.counters.queryGeometriesLoaded).toBe(1);
            expect(stats.counters.geometryPartsMaterialized).toBe(1);
            expect(stats.counters.pointObjects).toBe(1);
        });

        test('filters MLT symbol lookups before creating result wrappers', () => {
            const featureTable = createMltPointFeatureTable();
            const featureIndex = createQueryableMltFeatureIndex(featureTable);
            const layer = createQueryLayer();
            const stats = createMltMaterializationStats();
            const deactivate = activateMltMaterializationStats(stats);
            let result;

            try {
                result = featureIndex.lookupSymbolFeatures(
                    [0, 1, 2],
                    {layer: {id: 'layer', source: 'source', 'source-layer': 'test', type: 'circle', paint: {}, layout: {}} as any},
                    0,
                    0,
                    {filterSpec: ['all', ['==', ['zoom'], 3], ['is-supported-script', 'Paris'], ['==', ['get', 'rank'], 2]], globalState: {}},
                    null,
                    [],
                    {layer}
                );
            } finally {
                deactivate();
            }

            expect(result.layer).toHaveLength(1);
            expect(result.layer[0].feature.id).toBe(102);
            expect(stats.counters.queryCandidates).toBe(3);
            expect(stats.counters.queryResults).toBe(1);
            expect(stats.counters.estimatedQueryResultBytes).toBe(MLT_ESTIMATED_GEOJSON_QUERY_RESULT_BYTES + MLT_ESTIMATED_RENDERED_QUERY_WRAPPER_BYTES);
            expect(stats.counters.vectorTileFeatureWrappers).toBe(0);
            expect(stats.counters.propertyObjects).toBe(0);
            expect(stats.counters.queryGeometriesLoaded).toBe(0);
            expect(stats.counters.geometryPartsMaterialized).toBe(0);
            expect(stats.counters.pointObjects).toBe(0);
        });

        test('does not create MLT wrappers for candidates rejected by intersection', () => {
            const featureTable = createMltPointFeatureTable();
            const featureIndex = createQueryableMltFeatureIndex(featureTable);
            for (let featureIndexInLayer = 0; featureIndexInLayer < featureTable.numFeatures; featureIndexInLayer++) {
                featureIndex.insertFeatureTable(featureTable, featureIndexInLayer, 0, 0);
            }
            const layer = createQueryLayer();
            layer.queryIntersectsFeature = vi.fn(() => false);
            const stats = createMltMaterializationStats();
            const deactivate = activateMltMaterializationStats(stats);
            let result;

            try {
                result = queryMltFeatureIndex(featureIndex, layer);
            } finally {
                deactivate();
            }

            expect(result.layer).toBeUndefined();
            expect(stats.counters.queryCandidates).toBe(3);
            expect(stats.counters.queryResults).toBe(0);
            expect(stats.counters.estimatedQueryResultBytes).toBe(0);
            expect(stats.counters.vectorTileFeatureWrappers).toBe(0);
            expect(stats.counters.propertyObjects).toBe(0);
            expect(stats.counters.queryGeometriesLoaded).toBe(0);
            expect(stats.counters.geometryPartsMaterialized).toBe(0);
            expect(stats.counters.pointObjects).toBe(0);
        });

        test('query mlt tile with a global-state filter and legacy feature index entry', () => {
            const featureTable = createMltPointFeatureTable();
            const featureIndex = createQueryableMltFeatureIndex(featureTable);
            const sourceLayer = featureIndex.vtLayers.test;
            const feature = sourceLayer.feature(2);
            featureIndex.insert(feature, feature.loadGeometry(), 2, 0, 0);

            const result = queryMltFeatureIndex(featureIndex, createQueryLayer(), {
                filter: ['==', ['get', 'rank'], ['global-state', 'targetRank']],
                globalState: {targetRank: 3}
            });

            expect(result.layer).toHaveLength(1);
            expect(result.layer[0].feature.id).toBe(103);
            expect(result.layer[0].feature.properties.rank).toBe(3);
        });
    });
});
