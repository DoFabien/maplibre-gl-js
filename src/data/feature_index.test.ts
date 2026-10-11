import path from 'path';
import {readFileSync} from 'fs';
import {describe, expect, test, vi} from 'vitest';
import {FeatureIndex, GEOJSON_TILE_LAYER_NAME} from './feature_index.ts';
import {type Feature, fromVectorTileJs, GeoJSONWrapper, type VectorTileFeatureLike} from '@maplibre/vt-pbf';
import {createMercatorTransform} from '../geo/projection/mercator_transform.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {CircleStyleLayer} from '../style/style_layer/circle_style_layer.ts';
import Point from '@mapbox/point-geometry';
import {DictionaryCoder} from '../util/dictionary_coder.ts';
import {getMltFeatureTable, MLTVectorTile} from '../source/vector_tile_mlt.ts';
import {createConstGeometryVector, encodeTile, FeatureTable, GEOMETRY_TYPE, IntFlatVector, TopologyVector, type Vector} from '@maplibre/mlt';
import {serialize, deserialize} from '../util/web_worker_transfer.ts';
import {WorkerTile} from '../source/worker_tile.ts';
import {StyleLayerIndex} from '../style/style_layer_index.ts';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';
import {loadFeatureGeometry} from './bucket/columnar/geometry_traversal.ts';
import {EXTENT} from './extent.ts';

import type {EvaluationParameters} from '../style/evaluation_parameters.ts';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {WorkerTileParameters, WorkerTileWithData} from '../source/worker_source.ts';

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
            expect(featureIndex.createMltIdResolver(withIds, 'sourceLayer')(0)).toBe(7);
            expect(featureIndex.createMltIdResolver(withIds, 'sourceLayer')(1)).toBe(18446744071894882000);
            expect(featureIndex.createMltIdResolver(withoutIds, 'sourceLayer')(2)).toBeUndefined();
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
            expect(featureIndex.createMltIdResolver(featureTable, 'sourceLayer')(0)).toBe('road-a');
            expect(featureIndex.createMltIdResolver(featureTable, 'sourceLayer')(1)).toBe(1);
            expect(featureIndex.createMltIdResolver(featureTable, 'sourceLayer')(2)).toBeUndefined();
            expect(featureIndex.createMltIdResolver(featureTable, 'sourceLayer')(3)).toBe(123);
        });
    });

    describe('query', () => {
        const tileID = new OverscaledTileID(3, 0, 2, 1, 2);
        const transform = createMercatorTransform();
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

        test('rendered MLT filters use effective zoom', () => {
            const table = createMltPointFeatureTable();
            const index = createQueryableMltFeatureIndex(table);
            for (let i = 0; i < 3; i++) index.insert(undefined, [[new Point(20 * (i + 1), 20 * (i + 1))]], i, 0, 0);
            const layer = createQueryLayer();
            const result = queryMltFeatureIndex(index, layer, {filter: ['all', ['==', ['zoom'], 3], ['is-supported-script', 'Paris'], ['==', ['get', 'rank'], 2]]});
            expect(result.layer.map(r => r.feature.id)).toEqual([102]);
            expect(queryMltFeatureIndex(index, layer, {filter: ['==', ['zoom'], 2]})).toEqual({});
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
            expect(result.layer[0].feature.properties.admin_level).toBeDefined();
            expect(result.layer[0].feature.geometry.type).toBe('LineString');
        });

        test('queries the projected worker layers after transfer against the complete raw MLT tile', async () => {
            const rawTileData = encodeTile([
                {name: 'aaa-unused', features: [{id: 999, geometry: {type: 'Point', coordinates: [10, 10]}}]},
                {name: 'test', features: [1, 2, 3].map(rank => ({
                    id: 100 + rank, geometry: {type: 'Point', coordinates: [10 * rank, 10 * rank]}, properties: {rank},
                }))},
            ]).buffer as ArrayBuffer;
            const projected = new MLTVectorTile(rawTileData, {layerNames: ['test']});
            const workerTile = new WorkerTile({
                tileID, uid: 'projected', source: 'source', zoom: 3, tileSize: 512, pixelRatio: 1, encoding: 'mlt'
            } as WorkerTileParameters);
            const layerSpec: LayerSpecification = {id: 'layer', source: 'source', 'source-layer': 'test', type: 'circle'};
            const parsed = await workerTile.parse(projected, new StyleLayerIndex([layerSpec]), [],
                {sendAsync: vi.fn(async () => ({}))}, SubdivisionGranularitySetting.noSubdivision) as WorkerTileWithData;
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
            insertMltRow(featureIndex, featureTable, 1);

            const result = queryMltFeatureIndex(featureIndex, createQueryLayer(), {
                filter: ['==', ['get', 'rank'], 2]
            });

            expect(result.layer).toHaveLength(1);
            expect(result.layer[0].feature.id).toBe(102);
            expect(result.layer[0].feature.properties.rank).toBe(2);
        });

        test('filters MLT query candidates on their columns', () => {
            const featureTable = createMltPointFeatureTable();
            const featureIndex = createQueryableMltFeatureIndex(featureTable);
            for (let featureIndexInLayer = 0; featureIndexInLayer < featureTable.numFeatures; featureIndexInLayer++) {
                insertMltRow(featureIndex, featureTable, featureIndexInLayer);
            }
            const result = queryMltFeatureIndex(featureIndex, createQueryLayer(), {
                filter: ['==', ['get', 'rank'], 2]
            });

            expect(result.layer).toHaveLength(1);
            expect(result.layer[0].feature.id).toBe(102);
        });

        test('builds many rendered MLT results as independent public objects', () => {
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
                featureIndex.insert(undefined, [[new Point(10, 10)]], index, 0, 0);
            }
            const layer = createQueryLayer();
            const result = queryMltFeatureIndex(featureIndex, layer);
            expect(result.layer).toHaveLength(featureCount);

            expect(new Set([result.layer[0].feature, result.layer[1].feature])).toHaveLength(2);
            expect(result.layer[0].feature.id).toBe(1639);
            expect(result.layer[featureCount - 1].feature.id).toBe(1000);
            const firstProperties = result.layer[0].feature.properties;
            expect(firstProperties.rank).toBe(639);
            firstProperties.rank = -1;
            expect(result.layer[1].feature.properties.rank).toBe(638);
            (result.layer[0].feature as any).layer.paint.localMutation = true;
            expect((result.layer[1].feature as any).layer.paint.localMutation).toBeUndefined();

            const nextResult = queryMltFeatureIndex(featureIndex, layer);
            expect(nextResult.layer[0].feature).not.toBe(result.layer[0].feature);
            expect(nextResult.layer[0].feature.properties.rank).toBe(639);
        });

        test('reads rendered-query promoteId from the MLT column', () => {
            const featureTable = createMltPointFeatureTable();
            const featureIndex = createQueryableMltFeatureIndex(featureTable);
            featureIndex.promoteId = 'rank';
            insertMltRow(featureIndex, featureTable, 1);
            const result = queryMltFeatureIndex(featureIndex, createQueryLayer(), {
                filter: ['==', ['get', 'rank'], 2]
            });

            expect(result.layer).toHaveLength(1);
            expect(result.layer[0].feature.id).toBe(2);
        });

        test('filters MLT symbol lookups on their columns', () => {
            const featureTable = createMltPointFeatureTable();
            const featureIndex = createQueryableMltFeatureIndex(featureTable);
            const layer = createQueryLayer();
            const result = featureIndex.lookupSymbolFeatures(
                [0, 1, 2],
                {layer: {id: 'layer', source: 'source', 'source-layer': 'test', type: 'circle', paint: {}, layout: {}} as any},
                0,
                0,
                {filterSpec: ['all', ['==', ['zoom'], 3], ['is-supported-script', 'Paris'], ['==', ['get', 'rank'], 2]], globalState: {}},
                null,
                [],
                {layer}
            );

            expect(result.layer).toHaveLength(1);
            expect(result.layer[0].feature.id).toBe(102);
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

/** Indexes a row of an MLT feature table at its geometry, as MLT buckets index the rows they draw. */
function insertMltRow(featureIndex: FeatureIndex, featureTable: FeatureTable, index: number): void {
    featureIndex.insert(undefined, loadFeatureGeometry(featureTable, index, EXTENT / featureTable.extent), index, 0, 0);
}
