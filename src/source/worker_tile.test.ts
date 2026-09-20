import {describe, test, expect, vi} from 'vitest';
import {WorkerTile} from '../source/worker_tile.ts';
import {type Feature, GeoJSONWrapper, type VectorTileLike} from '@maplibre/vt-pbf';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {StyleLayerIndex} from '../style/style_layer_index.ts';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';
import {createFakeActor} from '../util/test/util.ts';
import {Color} from '@maplibre/maplibre-gl-style-spec';
import {MessageType} from '../util/actor_messages.ts';
import {BitVector, BooleanFlatVector, createConstGeometryVector, createSelectionVector, createStringFlatVector, FeatureTable, GEOMETRY_TYPE, IntFlatVector, TopologyVector} from '@maplibre/mlt';
import {MLTVectorTile} from './vector_tile_mlt.ts';
import {createSyntheticMltTile, syntheticLineLayer, syntheticPointLayer, syntheticPolygonLayer} from '../../test/unit/lib/mlt_synthetic.ts';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../util/mlt_materialization_stats.ts';
import {FeatureIndex} from '../data/feature_index.ts';

import type {SymbolLayoutProps, SymbolLayoutPropsPossiblyEvaluated} from '../style/style_layer/symbol_style_layer_properties.g.ts';
import type {CirclePaintProps, CirclePaintPropsPossiblyEvaluated} from '../style/style_layer/circle_style_layer_properties.g.ts';
import type {PossiblyEvaluated} from '../style/properties.ts';
import type {EvaluationParameters} from '../style/evaluation_parameters.ts';
import type {WorkerTileParameters} from './worker_source.ts';
import type {ParseProfile} from '../data/bucket.ts';
import type {WorkerTileWithData} from './worker_source.ts';

function createWorkerTile(params?: {globalState?: Record<string, any>; encoding?: 'mvt' | 'mlt'}): WorkerTile {
    return new WorkerTile({
        uid: '',
        zoom: 0,
        maxZoom: 20,
        tileSize: 512,
        source: 'source',
        tileID: new OverscaledTileID(1, 0, 1, 1, 1),
        overscaling: 1,
        globalState: params?.globalState,
        encoding: params?.encoding
    } as any as WorkerTileParameters);
}

function createWrapper() {
    return new GeoJSONWrapper([{
        type: 1,
        geometry: [0, 0],
        tags: {}
    } as any as Feature]);
}

function createLineWrapper() {
    return new GeoJSONWrapper([{
        type: 2,
        geometry: [[0, 0], [1, 1]],
        tags: {}
    } as any as Feature]);
}

function createClippedLineFeatureTable(): FeatureTable {
    const createFloatPropertyVector = (name: string, value: number) => ({
        name,
        size: 1,
        getValue: () => value
    } as any);

    return new FeatureTable(
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
            createFloatPropertyVector('mapbox_clip_start', 0.25),
            createFloatPropertyVector('mapbox_clip_end', 0.75)
        ]
    );
}

function createPatternFillFeatureTable(): FeatureTable {
    const geometryVector = createConstGeometryVector(
        1,
        GEOMETRY_TYPE.POLYGON,
        new TopologyVector(new Uint32Array(0), new Uint32Array([0, 1]), new Uint32Array([0, 5])),
        null,
        new Int32Array([0, 0, 10, 0, 10, 10, 0, 10, 0, 0])
    ) as any;
    geometryVector.getGeometries = vi.fn(() => {
        throw new Error('legacy materialization path should not be used');
    });

    return new FeatureTable(
        'test',
        geometryVector,
        new IntFlatVector('id', new Int32Array([1]), 1),
        []
    );
}

function createPatternLineFeatureTable(): FeatureTable {
    return new FeatureTable(
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
}

function createDashLineFeatureTable(): FeatureTable {
    return new FeatureTable(
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
}

function createCircleFeatureTable(): FeatureTable {
    return new FeatureTable(
        'test',
        createConstGeometryVector(
            1,
            GEOMETRY_TYPE.POINT,
            new TopologyVector(null, null, null),
            null,
            new Int32Array([10, 10])
        ),
        new IntFlatVector('id', new Int32Array([1]), 1),
        [
            new IntFlatVector('radius', new Int32Array([5]), 1)
        ]
    );
}

function createSymbolFeatureTable(): FeatureTable {
    return new FeatureTable(
        'test',
        createConstGeometryVector(
            1,
            GEOMETRY_TYPE.POINT,
            new TopologyVector(null, null, null),
            null,
            new Int32Array([10, 10])
        ),
        new IntFlatVector('id', new Int32Array([1]), 1),
        [
            createStringFlatVector(['hello'], 'name')
        ]
    );
}

describe('worker tile', () => {
    test('reuses circle bucket bboxes when building the MLT feature index', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'circle-layer',
            source: 'source',
            'source-layer': 'test',
            type: 'circle'
        }]);
        const insertBBox = vi.spyOn(FeatureIndex.prototype, 'insertBBox');
        const insertFeatureTable = vi.spyOn(FeatureIndex.prototype, 'insertFeatureTable');

        try {
            await createWorkerTile({encoding: 'mlt'}).parse(
                MLTVectorTile.fromFeatureTables([createCircleFeatureTable()]),
                layerIndex,
                [],
                {} as any,
                SubdivisionGranularitySetting.noSubdivision
            );

            expect(insertBBox).toHaveBeenCalledWith(0, 0, 0, [20, 20, 20, 20], false);
            expect(insertFeatureTable).not.toHaveBeenCalled();
        } finally {
            insertBBox.mockRestore();
            insertFeatureTable.mockRestore();
        }
    });

    test.each([
        {
            label: 'line',
            layerSpec: {
                id: 'synthetic-line',
                source: 'source',
                'source-layer': syntheticLineLayer,
                type: 'line',
                filter: ['==', ['get', 'kind'], 'primary'],
                paint: {'line-width': ['get', 'width']}
            },
            sourceLayerId: syntheticLineLayer,
            availableImages: []
        },
        {
            label: 'fill',
            layerSpec: {
                id: 'synthetic-fill',
                source: 'source',
                'source-layer': syntheticPolygonLayer,
                type: 'fill',
                filter: ['!=', ['get', 'kind'], 'outside'],
                layout: {'fill-sort-key': ['get', 'sort']},
                paint: {'fill-opacity': ['get', 'opacity']}
            },
            sourceLayerId: syntheticPolygonLayer,
            availableImages: []
        },
        {
            label: 'circle',
            layerSpec: {
                id: 'synthetic-circle',
                source: 'source',
                'source-layer': syntheticPointLayer,
                type: 'circle',
                filter: ['==', ['get', 'category'], 'poi'],
                layout: {'circle-sort-key': ['get', 'sort']},
                paint: {'circle-radius': ['get', 'radius']}
            },
            sourceLayerId: syntheticPointLayer,
            availableImages: []
        },
        {
            label: 'fill-extrusion',
            layerSpec: {
                id: 'synthetic-fill-extrusion',
                source: 'source',
                'source-layer': syntheticPolygonLayer,
                type: 'fill-extrusion',
                filter: ['>=', ['get', 'height'], 6],
                paint: {
                    'fill-extrusion-height': ['get', 'height'],
                    'fill-extrusion-base': ['get', 'base']
                }
            },
            sourceLayerId: syntheticPolygonLayer,
            availableImages: []
        },
        {
            label: 'symbol',
            layerSpec: {
                id: 'synthetic-symbol',
                source: 'source',
                'source-layer': syntheticPointLayer,
                type: 'symbol',
                filter: ['!=', ['get', 'category'], 'hidden'],
                layout: {
                    'icon-image': ['get', 'icon'],
                    'icon-allow-overlap': true
                }
            },
            sourceLayerId: syntheticPointLayer,
            availableImages: ['marker', 'star']
        }
    ])('WorkerTile.parse keeps synthetic MLT $label layers on the columnar path', async ({label, layerSpec, sourceLayerId, availableImages}) => {
        const data = createSyntheticMltTile();
        const sourceLayer = data.layers[sourceLayerId];
        const materializeFeature = vi.spyOn(sourceLayer, 'feature').mockImplementation(() => {
            throw new Error('legacy materialization path should not be used');
        });
        const layerIndex = new StyleLayerIndex([layerSpec as any]);

        const result = await createWorkerTile({encoding: 'mlt'}).parse(
            data,
            layerIndex,
            availableImages,
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(result).toBeDefined();
        expect(label === 'symbol' || result.buckets.length === 1).toBe(true);
        expect(label === 'symbol' || !result.buckets[0].isEmpty()).toBe(true);
        expect(materializeFeature).not.toHaveBeenCalled();
    });

    test('WorkerTile.parse rejects invalid MLT feature-state filters before bucket creation', async () => {
        const data = createSyntheticMltTile();
        const sourceLayer = data.layers[syntheticLineLayer];
        const materializeFeature = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'synthetic-line-feature-state-filter',
            source: 'source',
            'source-layer': syntheticLineLayer,
            type: 'line',
            filter: ['case', ['==', ['feature-state', 'rank'], null], true, false]
        } as any]);
        const layer = layerIndex.familiesBySource.source[syntheticLineLayer][0][0];
        const createBucket = vi.spyOn(layer, 'createBucket');

        await expect(createWorkerTile({encoding: 'mlt'}).parse(
            data,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        )).rejects.toThrow(/does not support the filter.*feature-state expressions/);

        expect(createBucket).not.toHaveBeenCalled();
        expect(materializeFeature).not.toHaveBeenCalled();
    });

    test('WorkerTile.parse rejects unsupported filters without touching strict materialization counters', async () => {
        const data = createSyntheticMltTile();
        const sourceLayer = data.layers[syntheticLineLayer];
        const feature = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'synthetic-line-strict-filter',
            source: 'source',
            'source-layer': syntheticLineLayer,
            type: 'line',
            filter: ['case', ['==', ['feature-state', 'rank'], null], true, false]
        } as any]);
        const stats = createMltMaterializationStats({
            strict: true,
            forbiddenCounters: ['workerFilterFallbackFeatures'],
        });
        const deactivate = activateMltMaterializationStats(stats);

        try {
            await expect(createWorkerTile({encoding: 'mlt'}).parse(
                data,
                layerIndex,
                [],
                {sendAsync: vi.fn().mockResolvedValue({})},
                SubdivisionGranularitySetting.noSubdivision
            )).rejects.toThrow(/does not support the filter.*feature-state expressions/);
        } finally {
            deactivate();
        }

        expect(stats.counters.workerFilterFallbackFeatures).toBe(0);
        expect(feature).not.toHaveBeenCalled();
    });

    test('WorkerTile.parse profiling separates aggregate and exclusive durations', async () => {
        const data = createSyntheticMltTile();
        const layerIndex = new StyleLayerIndex([{
            id: 'synthetic-line-profile',
            source: 'source',
            'source-layer': syntheticLineLayer,
            type: 'line',
            paint: {'line-width': ['get', 'width']}
        } as any]);
        const profile: ParseProfile = {records: []};

        await createWorkerTile({encoding: 'mlt'}).parse(
            data,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision,
            profile
        );

        const total = profile.records.find((record) => record.phase === 'parse.total');
        const exclusiveDuration = profile.records
            .filter((record) => record.kind !== 'aggregate')
            .reduce((sum, record) => sum + record.duration, 0);

        expect(total?.kind).toBe('aggregate');
        expect(profile.records.some((record) => record.phase === 'bucket.populate.total' && record.kind === 'aggregate')).toBe(true);
        expect(profile.records.some((record) => record.phase === 'bucket.populate.self' && record.kind === 'exclusive')).toBe(true);
        expect(exclusiveDuration).toBeCloseTo(total?.duration ?? 0, 8);
    });

    test('WorkerTile.parse evaluates MLT within filters without materializing features', async () => {
        const data = createSyntheticMltTile();
        const sourceLayer = data.layers[syntheticPointLayer];
        const materializeFeature = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'synthetic-circle-within-filter',
            source: 'source',
            'source-layer': syntheticPointLayer,
            type: 'circle',
            filter: ['within', {type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]]}],
            paint: {'circle-radius': 4}
        } as any]);

        await createWorkerTile({encoding: 'mlt'}).parse(
            data,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(materializeFeature).not.toHaveBeenCalled();
    });

    test.each([
        {
            label: 'mixed legacy and expression syntax',
            sourceLayerId: syntheticLineLayer,
            type: 'line',
            filter: ['all', ['==', 'kind', 'primary'], ['==', ['get', 'rank'], 1]],
            reason: /not both/,
        },
        {
            label: 'non-primitive global-state value',
            sourceLayerId: syntheticLineLayer,
            type: 'line',
            filter: ['==', ['get', 'rank'], ['global-state', 'targetRank']],
            globalState: {targetRank: [1]},
            reason: /primitive values/,
        },
    ])('WorkerTile.parse rejects unsupported $label filters without materializing features', async ({sourceLayerId, type, filter, globalState, reason}) => {
        const data = createSyntheticMltTile();
        const sourceLayer = data.layers[sourceLayerId];
        const materializeFeature = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: `synthetic-${type}-unsupported-filter`,
            source: 'source',
            'source-layer': sourceLayerId,
            type,
            filter,
            paint: type === 'circle' ? {'circle-radius': 4} : {'line-width': 2}
        } as any], globalState);
        const layer = layerIndex.familiesBySource.source[sourceLayerId][0][0];
        const createBucket = vi.spyOn(layer, 'createBucket');

        await expect(createWorkerTile({encoding: 'mlt'}).parse(
            data,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        )).rejects.toThrow(reason);

        expect(createBucket).not.toHaveBeenCalled();
        expect(materializeFeature).not.toHaveBeenCalled();
    });

    test('WorkerTile.parse routes synthetic data-driven MLT line-dasharray dependencies without materializing features', async () => {
        const data = createSyntheticMltTile();
        const sourceLayer = data.layers[syntheticLineLayer];
        const materializeFeature = vi.spyOn(sourceLayer, 'feature').mockImplementation(() => {
            throw new Error('legacy materialization path should not be used');
        });
        const layerIndex = new StyleLayerIndex([{
            id: 'synthetic-line-dasharray',
            source: 'source',
            'source-layer': syntheticLineLayer,
            type: 'line',
            paint: {
                'line-dasharray': ['case', ['==', ['get', 'dash'], 1], ['literal', [2, 1]], ['literal', [1, 2]]]
            }
        } as any]);
        const sendAsync = vi.fn(({type: messageType}) => {
            if (messageType === MessageType.getDashes) {
                return Promise.resolve({
                    '1,2,false': {y: 0, height: 16, width: 256},
                    '2,1,false': {y: 16, height: 16, width: 256}
                });
            }
            return Promise.resolve({});
        });

        const result = await createWorkerTile({encoding: 'mlt'}).parse(
            data,
            layerIndex,
            [],
            {sendAsync},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(materializeFeature).not.toHaveBeenCalled();
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({
            type: MessageType.getDashes,
            data: expect.objectContaining({
                dashes: expect.objectContaining({
                    '1,2,false': expect.any(Object),
                    '2,1,false': expect.any(Object)
                })
            })
        }), expect.anything());
        expect(result.buckets[0].isEmpty()).toBe(false);
    });

    test.each([
        {
            label: 'line',
            layerSpec: {
                id: 'synthetic-line-pattern',
                source: 'source',
                'source-layer': syntheticLineLayer,
                type: 'line',
                paint: {'line-pattern': ['get', 'pattern']}
            },
            sourceLayerId: syntheticLineLayer,
            expectedPatterns: ['dot', 'stripe']
        },
        {
            label: 'fill',
            layerSpec: {
                id: 'synthetic-fill-pattern',
                source: 'source',
                'source-layer': syntheticPolygonLayer,
                type: 'fill',
                paint: {'fill-pattern': ['get', 'pattern']}
            },
            sourceLayerId: syntheticPolygonLayer,
            expectedPatterns: ['cross', 'grid']
        },
        {
            label: 'fill-extrusion',
            layerSpec: {
                id: 'synthetic-fill-extrusion-pattern',
                source: 'source',
                'source-layer': syntheticPolygonLayer,
                type: 'fill-extrusion',
                paint: {'fill-extrusion-pattern': ['get', 'pattern']}
            },
            sourceLayerId: syntheticPolygonLayer,
            expectedPatterns: ['cross', 'grid']
        }
    ])('WorkerTile.parse routes synthetic data-driven MLT $label pattern dependencies without materializing features', async ({layerSpec, sourceLayerId, expectedPatterns}) => {
        const data = createSyntheticMltTile();
        const sourceLayer = data.layers[sourceLayerId];
        const materializeFeature = vi.spyOn(sourceLayer, 'feature').mockImplementation(() => {
            throw new Error('legacy materialization path should not be used');
        });
        const layerIndex = new StyleLayerIndex([layerSpec as any]);
        const sendAsync = vi.fn(({type: messageType, data: requestData}) => {
            if (messageType === MessageType.getImages && requestData.type === 'patterns') {
                return Promise.resolve({});
            }
            return Promise.resolve({});
        });

        const result = await createWorkerTile({encoding: 'mlt'}).parse(
            data,
            layerIndex,
            expectedPatterns,
            {sendAsync},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(materializeFeature).not.toHaveBeenCalled();
        const patternRequest = sendAsync.mock.calls.find(([message]) => message.type === MessageType.getImages && message.data.type === 'patterns')?.[0];
        expect(patternRequest).toBeDefined();
        expect([...patternRequest.data.icons].sort()).toEqual([...expectedPatterns].sort());
        expect(result.buckets[0].isEmpty()).toBe(false);
    });

    test.each(['fill', 'line', 'fill-extrusion', 'circle'] as const)('WorkerTile.parse routes MLT %s buckets without materializing features', async (type) => {
        const layerIndex = new StyleLayerIndex([{
            id: `${type}-layer`,
            source: 'source',
            'source-layer': 'test',
            type
        }]);

        const layer = layerIndex.familiesBySource.source.test[0][0];
        const populate = vi.fn();
        const bucket = {
            isColumnar: true,
            featureIndexSelectionVector: createSelectionVector(1),
            layerIds: [layer.id],
            layers: [layer],
            hasDependencies: false,
            stateDependentLayers: [],
            stateDependentLayerIds: [],
            populate,
            update: vi.fn(),
            isEmpty: () => false,
            upload: vi.fn(),
            uploadPending: () => false,
            destroy: vi.fn()
        };
        layer.createBucket = vi.fn(() => bucket as any);

        const feature = vi.fn(() => {
            throw new Error('legacy materialization path should not be used');
        });
        const featureTable = type === 'circle' ? createCircleFeatureTable() : {numFeatures: 1} as any;
        const data = {
            layers: {
                test: {
                    version: 2,
                    name: 'test',
                    extent: 8192,
                    length: 1,
                    feature,
                    featureTable
                }
            }
        } as any as VectorTileLike;

        const tile = createWorkerTile({encoding: 'mlt'});
        await tile.parse(data, layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision);

        expect(populate).toHaveBeenCalledTimes(1);
        expect(populate).toHaveBeenCalledWith(featureTable, expect.any(Object), expect.any(Object));
        expect(feature).not.toHaveBeenCalled();
    });

    test('WorkerTile.parse rejects a non-symbol MLT bucket without a feature-index selection', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'fill-layer',
            source: 'source',
            'source-layer': 'test',
            type: 'fill'
        }]);
        const layer = layerIndex.familiesBySource.source.test[0][0];
        const bucket = {
            isColumnar: true,
            layerIds: [layer.id],
            layers: [layer],
            hasDependencies: false,
            stateDependentLayers: [],
            stateDependentLayerIds: [],
            populate: vi.fn(),
            update: vi.fn(),
            isEmpty: () => false,
            upload: vi.fn(),
            uploadPending: () => false,
            destroy: vi.fn()
        };
        layer.createBucket = vi.fn(() => bucket as any);
        const data = MLTVectorTile.fromFeatureTables([createPatternFillFeatureTable()]);

        await expect(createWorkerTile({encoding: 'mlt'}).parse(
            data,
            layerIndex,
            [],
            {} as any,
            SubdivisionGranularitySetting.noSubdivision
        )).rejects.toThrow(/did not expose its feature-index selection/);
    });

    test('WorkerTile.parse rejects unsupported MLT columnar filters before bucket creation', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'fill-layer',
            source: 'source',
            'source-layer': 'test',
            type: 'fill',
            filter: ['case', ['==', ['feature-state', 'rank'], null], true, false] as any
        }]);

        const layer = layerIndex.familiesBySource.source.test[0][0];
        const populate = vi.fn();
        const bucket = {
            isColumnar: false,
            layerIds: [layer.id],
            layers: [layer],
            hasDependencies: false,
            stateDependentLayers: [],
            stateDependentLayerIds: [],
            populate,
            update: vi.fn(),
            isEmpty: () => false,
            upload: vi.fn(),
            uploadPending: () => false,
            destroy: vi.fn()
        };
        layer.createBucket = vi.fn(() => bucket as any);

        const feature = vi.fn((featureIndex: number) => ({
            extent: 8192,
            type: 3,
            id: featureIndex,
            properties: {rank: featureIndex + 1},
            loadGeometry: () => [[{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 0}]]
        }));
        const data = {
            layers: {
                test: {
                    version: 2,
                    name: 'test',
                    extent: 8192,
                    length: 1,
                    feature,
                    featureTable: createPatternFillFeatureTable()
                }
            }
        } as any as VectorTileLike;

        const tile = createWorkerTile({encoding: 'mlt'});
        await expect(tile.parse(data, layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision))
            .rejects.toThrow(/does not support the filter.*feature-state/);

        expect(layer.createBucket).not.toHaveBeenCalled();
        expect(populate).not.toHaveBeenCalled();
        expect(feature).not.toHaveBeenCalled();
    });

    test('WorkerTile.parse keeps supported MLT case/coalesce/scalar coercion filters on the columnar path', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'fill-layer',
            source: 'source',
            'source-layer': 'test',
            type: 'fill',
            filter: ['case', ['all',
                ['coalesce', ['==', ['get', 'rank'], 1], false],
                ['coalesce', ['get', 'visible']],
                ['==', ['to-number', ['coalesce', ['get', 'rank'], 0]], 1],
                ['==', ['%', ['to-number', ['id']], 10], 1],
                ['==', ['length', ['get', 'name']], 5],
                ['==', ['concat', ['get', 'name'], '-', ['to-string', ['+', ['get', 'rank'], 1]]], 'hello-2'],
                ['let', 'computedRank', ['+', ['get', 'rank'], 1], ['==', ['var', 'computedRank'], 2]]
            ], true, false] as any
        }]);

        const layer = layerIndex.familiesBySource.source.test[0][0];
        const populate = vi.fn();
        const bucket = {
            isColumnar: true,
            featureIndexSelectionVector: createSelectionVector(1),
            layerIds: [layer.id],
            layers: [layer],
            hasDependencies: false,
            stateDependentLayers: [],
            stateDependentLayerIds: [],
            populate,
            update: vi.fn(),
            isEmpty: () => false,
            upload: vi.fn(),
            uploadPending: () => false,
            destroy: vi.fn()
        };
        layer.createBucket = vi.fn(() => bucket as any);

        const feature = vi.fn(() => {
            throw new Error('legacy materialization path should not be used');
        });
        const data = {
            layers: {
                test: {
                    version: 2,
                    name: 'test',
                    extent: 8192,
                    length: 1,
                    feature,
                    featureTable: new FeatureTable(
                        'test',
                        createConstGeometryVector(
                            1,
                            GEOMETRY_TYPE.POLYGON,
                            new TopologyVector(new Uint32Array(0), new Uint32Array([0, 1]), new Uint32Array([0, 5])),
                            null,
                            new Int32Array([0, 0, 10, 0, 10, 10, 0, 10, 0, 0])
                        ),
                        new IntFlatVector('id', new Int32Array([1]), 1),
                        [
                            new IntFlatVector('rank', new Int32Array([1]), 1),
                            new BooleanFlatVector('visible', new BitVector(new Uint8Array([1]), 1), 1),
                            createStringFlatVector(['hello'], 'name')
                        ]
                    )
                }
            }
        } as any as VectorTileLike;

        const tile = createWorkerTile({encoding: 'mlt'});
        await tile.parse(data, layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision);

        expect(layer.createBucket).toHaveBeenCalledWith(expect.objectContaining({encoding: 'mlt'}));
        expect(populate).toHaveBeenCalledWith((data.layers.test as any).featureTable, expect.any(Object), expect.any(Object));
        expect(feature).not.toHaveBeenCalled();
    });

    test('WorkerTile.parse keeps supported MLT global-state filters on the columnar path', async () => {
        const globalState = {targetRank: 1};
        const layerIndex = new StyleLayerIndex([{
            id: 'fill-layer',
            source: 'source',
            'source-layer': 'test',
            type: 'fill',
            filter: ['==', ['get', 'rank'], ['global-state', 'targetRank']] as any
        }], globalState);

        const layer = layerIndex.familiesBySource.source.test[0][0];
        const populate = vi.fn();
        const bucket = {
            isColumnar: true,
            featureIndexSelectionVector: createSelectionVector(1),
            layerIds: [layer.id],
            layers: [layer],
            hasDependencies: false,
            stateDependentLayers: [],
            stateDependentLayerIds: [],
            populate,
            update: vi.fn(),
            isEmpty: () => false,
            upload: vi.fn(),
            uploadPending: () => false,
            destroy: vi.fn()
        };
        layer.createBucket = vi.fn(() => bucket as any);

        const feature = vi.fn(() => {
            throw new Error('legacy materialization path should not be used');
        });
        const data = {
            layers: {
                test: {
                    version: 2,
                    name: 'test',
                    extent: 8192,
                    length: 1,
                    feature,
                    featureTable: new FeatureTable(
                        'test',
                        createConstGeometryVector(
                            1,
                            GEOMETRY_TYPE.POLYGON,
                            new TopologyVector(new Uint32Array(0), new Uint32Array([0, 1]), new Uint32Array([0, 5])),
                            null,
                            new Int32Array([0, 0, 10, 0, 10, 10, 0, 10, 0, 0])
                        ),
                        new IntFlatVector('id', new Int32Array([1]), 1),
                        [new IntFlatVector('rank', new Int32Array([1]), 1)]
                    )
                }
            }
        } as any as VectorTileLike;

        const tile = createWorkerTile({encoding: 'mlt'});
        await tile.parse(data, layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision);

        expect(layer.createBucket).toHaveBeenCalledWith(expect.objectContaining({encoding: 'mlt'}));
        expect(populate).toHaveBeenCalledWith((data.layers.test as any).featureTable, expect.any(Object), expect.any(Object));
        expect(feature).not.toHaveBeenCalled();
    });

    test('WorkerTile.parse never routes unsupported MLT filters through legacy line buckets', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'line-layer',
            source: 'source',
            'source-layer': 'test',
            type: 'line',
            filter: ['case', ['==', ['feature-state', 'rank'], null], true, false] as any
        }]);
        const featureTable = createPatternLineFeatureTable();
        const data = MLTVectorTile.fromFeatureTables([featureTable]);
        const feature = vi.spyOn(data.layers.test, 'feature');
        const layer = layerIndex.familiesBySource.source.test[0][0];
        const createBucket = vi.spyOn(layer, 'createBucket');

        const tile = createWorkerTile({encoding: 'mlt'});
        await expect(tile.parse(data, layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision))
            .rejects.toThrow(/does not support the filter.*feature-state/);

        expect(createBucket).not.toHaveBeenCalled();
        expect(feature).not.toHaveBeenCalled();
    });

    test('WorkerTile.parse rejects MLT layers without feature tables', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'line-layer',
            source: 'source',
            'source-layer': 'test',
            type: 'line'
        }]);
        const layer = layerIndex.familiesBySource.source.test[0][0];
        const populate = vi.fn();
        const bucket = {
            isColumnar: false,
            layerIds: [layer.id],
            layers: [layer],
            hasDependencies: false,
            stateDependentLayers: [],
            stateDependentLayerIds: [],
            populate,
            update: vi.fn(),
            isEmpty: () => false,
            upload: vi.fn(),
            uploadPending: () => false,
            destroy: vi.fn()
        };
        layer.createBucket = vi.fn(() => bucket as any);

        const feature = vi.fn(() => ({
            type: 2,
            properties: {},
            loadGeometry: () => [[{x: 0, y: 0}, {x: 1, y: 1}]]
        }));
        const data = {
            layers: {
                test: {
                    version: 2,
                    name: 'test',
                    extent: 8192,
                    length: 1,
                    feature
                }
            }
        } as any as VectorTileLike;

        const tile = createWorkerTile({encoding: 'mlt'});
        await expect(tile.parse(data, layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision))
            .rejects
            .toThrow(/MLT layer "test" is missing its FeatureTable/);

        expect(layer.createBucket).not.toHaveBeenCalled();
        expect(feature).not.toHaveBeenCalled();
        expect(populate).not.toHaveBeenCalled();
    });

    test('WorkerTile.parse rejects non-columnar MLT buckets instead of materializing features', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'line-layer',
            source: 'source',
            'source-layer': 'test',
            type: 'line'
        }]);
        const layer = layerIndex.familiesBySource.source.test[0][0];
        const populate = vi.fn();
        const bucket = {
            isColumnar: false,
            layerIds: [layer.id],
            layers: [layer],
            hasDependencies: false,
            stateDependentLayers: [],
            stateDependentLayerIds: [],
            populate,
            update: vi.fn(),
            isEmpty: () => false,
            upload: vi.fn(),
            uploadPending: () => false,
            destroy: vi.fn()
        };
        layer.createBucket = vi.fn(() => bucket as any);

        const feature = vi.fn(() => {
            throw new Error('legacy materialization path should not be used');
        });
        const data = {
            layers: {
                test: {
                    version: 2,
                    name: 'test',
                    extent: 8192,
                    length: 1,
                    feature,
                    featureTable: createPatternLineFeatureTable()
                }
            }
        } as any as VectorTileLike;

        const tile = createWorkerTile({encoding: 'mlt'});
        await expect(tile.parse(data, layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision))
            .rejects
            .toThrow(/MLT no-materialization v1 requires a columnar bucket/);

        expect(feature).not.toHaveBeenCalled();
        expect(populate).not.toHaveBeenCalled();
    });

    test('WorkerTile.parse builds MLT heatmaps without feature materialization', async () => {
        const data = createSyntheticMltTile();
        const sourceLayer = data.layers[syntheticPointLayer];
        const feature = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'heatmap-layer',
            source: 'source',
            'source-layer': syntheticPointLayer,
            type: 'heatmap'
        }]);
        const layer = layerIndex.familiesBySource.source[syntheticPointLayer][0][0];
        const createBucket = vi.spyOn(layer, 'createBucket');

        const stats = createMltMaterializationStats({strict: true});
        const restore = activateMltMaterializationStats(stats);
        try {
            const result = await createWorkerTile({encoding: 'mlt'}).parse(
                data, layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision
            );
            expect(result.buckets).toHaveLength(1);
            expect(result.buckets[0].isEmpty()).toBe(false);
            expect((result.buckets[0] as any).isColumnar).toBe(true);
        } finally {
            restore();
        }

        expect(createBucket).toHaveBeenCalledTimes(1);
        expect(feature).not.toHaveBeenCalled();
        for (const counter of stats.forbiddenCounters) expect(stats.counters[counter]).toBe(0);
    });

    test('WorkerTile.parse routes constant MLT line-dasharray without dependencies or materialization', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'line-layer',
            source: 'source',
            'source-layer': 'test',
            type: 'line',
            paint: {'line-dasharray': ['literal', [2, 1]]}
        } as any]);

        const feature = vi.fn(() => {
            throw new Error('legacy materialization path should not be used');
        });
        const data = {
            layers: {
                test: {
                    version: 2,
                    name: 'test',
                    extent: 8192,
                    length: 1,
                    feature,
                    featureTable: createPatternLineFeatureTable()
                }
            }
        } as any as VectorTileLike;

        const sendAsync = vi.fn();
        const tile = createWorkerTile({encoding: 'mlt'});

        const result = await tile.parse(
            data,
            layerIndex,
            [],
            {sendAsync},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(feature).not.toHaveBeenCalled();
        expect(sendAsync).not.toHaveBeenCalled();
        expect(result.buckets[0].isEmpty()).toBe(false);
    });

    test('WorkerTile.parse routes MLT symbol buckets without materializing full source layers', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'symbol-layer',
            source: 'source',
            'source-layer': 'test',
            type: 'symbol',
            layout: {
                'icon-image': 'hello'
            }
        }]);

        const feature = vi.fn(() => {
            throw new Error('legacy materialization path should not be used');
        });
        const data = {
            layers: {
                test: {
                    version: 2,
                    name: 'test',
                    extent: 8192,
                    length: 1,
                    feature,
                    featureTable: createSymbolFeatureTable()
                }
            }
        } as any as VectorTileLike;

        const sendAsync = vi.fn().mockResolvedValue({'hello': {width: 1, height: 1, data: new Uint8Array([0])}});
        const tile = createWorkerTile({encoding: 'mlt'});

        const result = await tile.parse(
            data,
            layerIndex,
            ['hello'],
            {sendAsync},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(result).toBeDefined();
        expect(sendAsync).toHaveBeenCalledTimes(1);
        expect(sendAsync).toHaveBeenCalledWith(
            expect.objectContaining({type: MessageType.getImages, data: expect.objectContaining({icons: ['hello'], type: 'icons'})}),
            expect.any(Object)
        );
        expect(feature).not.toHaveBeenCalled();
    });

    test('WorkerTile.parse routes MLT text symbol buckets without materializing full source layers', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'symbol-text-layer',
            source: 'source',
            'source-layer': 'test',
            type: 'symbol',
            layout: {
                'text-field': '{name}',
                'text-font': ['StandardFont-Bold']
            }
        }]);

        const feature = vi.fn(() => {
            throw new Error('legacy materialization path should not be used');
        });
        const data = {
            layers: {
                test: {
                    version: 2,
                    name: 'test',
                    extent: 8192,
                    length: 1,
                    feature,
                    featureTable: createSymbolFeatureTable()
                }
            }
        } as any as VectorTileLike;

        const sendAsync = vi.fn().mockImplementation((message: {type: string}) => {
            if (message.type === MessageType.getGlyphs) {
                const bitmap = {width: 1, height: 1, data: new Uint8Array([0])};
                const metrics = {width: 1, height: 1, left: 0, top: 0, advance: 1};
                return Promise.resolve({
                    'StandardFont-Bold': Object.fromEntries(
                        [...'helo'].map((glyph) => [glyph, {id: glyph.codePointAt(0), bitmap, metrics}])
                    )
                });
            }
            return Promise.resolve({});
        });
        const tile = createWorkerTile({encoding: 'mlt'});

        const result = await tile.parse(
            data,
            layerIndex,
            [],
            {sendAsync},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(result).toBeDefined();
        expect(sendAsync).toHaveBeenCalledTimes(1);
        expect(sendAsync).toHaveBeenCalledWith(
            expect.objectContaining({type: MessageType.getGlyphs, data: expect.objectContaining({stacks: {'StandardFont-Bold': ['h', 'e', 'l', 'o']}})}),
            expect.any(Object)
        );
        expect(feature).not.toHaveBeenCalled();
    });

    test('WorkerTile.parse routes data-driven MLT line-dasharray dependencies without materializing features', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'line-dasharray-layer',
            source: 'source',
            'source-layer': 'test',
            type: 'line',
            paint: {
                'line-dasharray': ['case', ['has', 'road_type'], ['literal', [2, 1]], ['literal', [1, 2]]]
            }
        } as any]);

        const feature = vi.fn(() => {
            throw new Error('legacy materialization path should not be used');
        });
        const sendAsync = vi.fn(({type: messageType}) => {
            if (messageType === MessageType.getDashes) {
                return Promise.resolve({
                    '2,1,false': {y: 0, height: 16, width: 256}
                });
            }
            return Promise.resolve({});
        });
        const data = {
            layers: {
                test: {
                    version: 2,
                    name: 'test',
                    extent: 8192,
                    length: 1,
                    feature,
                    featureTable: createDashLineFeatureTable()
                }
            }
        } as any as VectorTileLike;

        const tile = createWorkerTile({encoding: 'mlt'});
        const result = await tile.parse(
            data,
            layerIndex,
            [],
            {sendAsync},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(feature).not.toHaveBeenCalled();
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({
            type: MessageType.getDashes,
            data: expect.objectContaining({dashes: expect.any(Object)})
        }), expect.anything());
        expect(result.buckets[0].isEmpty()).toBe(false);
    });

    test.each([
        {
            label: 'fill',
            type: 'fill' as const,
            paint: {'fill-pattern': 'pattern'},
            featureTable: createPatternFillFeatureTable()
        },
        {
            label: 'fill-extrusion',
            type: 'fill-extrusion' as const,
            paint: {'fill-extrusion-pattern': 'pattern'},
            featureTable: createPatternFillFeatureTable()
        },
        {
            label: 'line',
            type: 'line' as const,
            paint: {'line-pattern': 'pattern'},
            featureTable: createPatternLineFeatureTable()
        }
    ])('WorkerTile.parse routes MLT $label pattern dependencies without materializing features', async ({type, paint, featureTable}) => {
        const layerIndex = new StyleLayerIndex([{
            id: `${type}-pattern-layer`,
            source: 'source',
            'source-layer': 'test',
            type,
            paint
        }]);

        const feature = vi.fn(() => {
            throw new Error('legacy materialization path should not be used');
        });
        const sendAsync = vi.fn(({type: messageType, data}) => {
            if (messageType === MessageType.getImages && data.type === 'patterns') {
                return Promise.resolve({});
            }
            return Promise.resolve({});
        });
        const data = {
            layers: {
                test: {
                    version: 2,
                    name: 'test',
                    extent: 8192,
                    length: 1,
                    feature,
                    featureTable
                }
            }
        } as any as VectorTileLike;

        const tile = createWorkerTile({encoding: 'mlt'});
        const result = await tile.parse(
            data,
            layerIndex,
            ['pattern'],
            {sendAsync},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(feature).not.toHaveBeenCalled();
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({
            type: MessageType.getImages,
            data: expect.objectContaining({type: 'patterns', icons: ['pattern']})
        }), expect.anything());
        expect(result.buckets[0].isEmpty()).toBe(false);
    });

    test('WorkerTile.parse routes MLT line-gradient without materializing features', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'line-gradient-layer',
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
        } as any]);

        const feature = vi.fn(() => {
            throw new Error('legacy materialization path should not be used');
        });
        const data = {
            layers: {
                test: {
                    version: 2,
                    name: 'test',
                    extent: 8192,
                    length: 1,
                    feature,
                    featureTable: createClippedLineFeatureTable()
                }
            }
        } as any as VectorTileLike;

        const tile = createWorkerTile({encoding: 'mlt'});
        const result = await tile.parse(data, layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision);
        const bucket = result.buckets[0] as any;

        expect(feature).not.toHaveBeenCalled();
        expect(bucket.layoutVertexArray2.length).toBeGreaterThan(0);
        expect(bucket.lineClipsArray).toEqual([{start: 0.25, end: 0.75}]);
        expect(bucket.maxLineLength).toBeGreaterThan(0);
    });

    test('WorkerTile.parse', async () => {
        const originalWarn = console.warn;
        console.warn = vi.fn();
        const layerIndex = new StyleLayerIndex([{
            id: 'test',
            source: 'source',
            type: 'circle'
        }]);

        const tile = createWorkerTile();
        const result = await tile.parse(createWrapper(), layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision);
        expect(result.buckets[0]).toBeTruthy();
        console.warn = originalWarn;
    });

    test('WorkerTile.parse layer with layout property', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'test',
            source: 'source',
            type: 'line',
            layout: {
                'line-join': 'bevel'
            }
        }]);

        const tile = createWorkerTile();
        const result = await tile.parse(createLineWrapper(), layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision);
        expect(result.buckets[0]).toBeTruthy();
        expect(result.buckets[0].layers[0].layout._values['line-join'].value.value).toBe('bevel');
    });

    test('WorkerTile.parse layer with layout property using global-state', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'test',
            source: 'source',
            type: 'line',
            layout: {
                'line-join': ['global-state', 'test']
            }
        }], {test: 'bevel'});

        const tile = createWorkerTile({
            globalState: {test: 'bevel'}
        });
        const result = await tile.parse(createLineWrapper(), layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision);
        expect(result.buckets[0]).toBeTruthy();
        expect(result.buckets[0].layers[0].layout._values['line-join'].value.value).toBe('bevel');
    });

    test('WorkerTile.parse layer with paint property using global-state', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'test',
            source: 'source',
            type: 'fill-extrusion',
            paint: {
                'fill-extrusion-height': ['global-state', 'test']
            }
        }], {test: 1});

        const tile = createWorkerTile({
            globalState: {test: 1}
        });
        const result = await tile.parse(createLineWrapper(), layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision);
        expect(result.buckets[0]).toBeTruthy();
        expect(result.buckets[0].layers[0].paint._values['fill-extrusion-height'].value.value).toBe(1);
    });

    test('WorkerTile.parse skips hidden layers', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'test-hidden',
            source: 'source',
            type: 'fill',
            layout: {visibility: 'none'}
        }]);

        const tile = createWorkerTile();
        const result = await tile.parse(createWrapper(), layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision);
        expect(result.buckets).toHaveLength(0);
    });

    test('WorkerTile.parse skips layers without a corresponding source layer', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'test',
            source: 'source',
            'source-layer': 'nonesuch',
            type: 'fill'
        }]);

        const tile = createWorkerTile();
        const result = await tile.parse({layers: {}}, layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision);
        expect(result.buckets).toHaveLength(0);
    });

    test('WorkerTile.parse warns once when encountering a v1 vector tile layer', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'test',
            source: 'source',
            'source-layer': 'test',
            type: 'fill'
        }]);

        const data = {
            layers: {
                test: {
                    version: 1
                }
            }
        } as any as VectorTileLike;

        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const tile = createWorkerTile();
        await tile.parse(data, layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision);
        expect(spy.mock.calls[0][0]).toMatch(/does not use vector tile spec v2/);
    });

    test('WorkerTile.parse would request all types of dependencies', async () => {
        const tile = createWorkerTile();
        const layerIndex = new StyleLayerIndex([{
            id: '1',
            type: 'fill',
            source: 'source',
            'source-layer': 'test',
            paint: {
                'fill-pattern': 'hello'
            }
        }, {
            id: 'test',
            source: 'source',
            'source-layer': 'test',
            type: 'symbol',
            layout: {
                'icon-image': 'hello',
                'text-font': ['StandardFont-Bold'],
                'text-field': '{name}'
            }
        }, {
            id: 'line-layer',
            type: 'line',
            source: 'source',
            'source-layer': 'test',
            paint: {
                'line-dasharray': ['case', ['has', 'road_type'], ['literal', [2, 1]], ['literal', [1, 2]]]
            }
        }]);

        const data = {
            layers: {
                test: {
                    version: 2,
                    name: 'test',
                    extent: 8192,
                    length: 1,
                    feature: (featureIndex: number) => ({
                        extent: 8192,
                        type: 1,
                        id: featureIndex,
                        properties: {
                            name: 'test'
                        },
                        loadGeometry () {
                            return [[{x: 0, y: 0}]];
                        }
                    })
                }
            }
        } as any as VectorTileLike;

        const sendAsync = vi.fn().mockImplementation((message: {type: string; data: any}) => {
            if (message.type === MessageType.getImages) {
                return Promise.resolve({'hello': {width: 1, height: 1, data: new Uint8Array([0])}});
            } else if (message.type === MessageType.getGlyphs) {
                return Promise.resolve({'StandardFont-Bold': {'e': {id: 101, bitmap: {width: 1, height: 1, data: new Uint8Array([0])}, metrics: {width: 1, height: 1, left: 0, top: 0, advance: 1}}}});
            } else if (message.type === MessageType.getDashes) {
                return Promise.resolve({
                    '2,1,false': {y: 0, height: 16, width: 256},
                    '1,2,false': {y: 16, height: 16, width: 256}
                });
            }
        });

        const actorMock = {
            sendAsync
        };
        const result = await tile.parse(data, layerIndex, ['hello'], actorMock, SubdivisionGranularitySetting.noSubdivision);
        expect(result).toBeDefined();
        expect(result.buckets.some((bucket) => bucket.layerIds.includes('test'))).toBe(true);
        expect(sendAsync).toHaveBeenCalledTimes(4); // icons, patterns, glyphs, dashes
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({type: 'GI', data: expect.objectContaining({'icons': ['hello'], 'type': 'icons'})}), expect.any(Object));
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({type: 'GI', data: expect.objectContaining({'icons': ['hello'], 'type': 'patterns'})}), expect.any(Object));
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({type: 'GG', data: expect.objectContaining({'source': 'source', 'type': 'glyphs', 'stacks': {'StandardFont-Bold': ['t', 'e', 's']}})}), expect.any(Object));
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({type: 'GDA', data: expect.objectContaining({'dashes': expect.any(Object)})}), expect.any(Object));
    });

    test('WorkerTile.parse would cancel and only event once on repeated reparsing', async () => {
        const tile = createWorkerTile();
        const layerIndex = new StyleLayerIndex([{
            id: '1',
            type: 'fill',
            source: 'source',
            'source-layer': 'test',
            paint: {
                'fill-pattern': 'hello'
            }
        }, {
            id: 'test',
            source: 'source',
            'source-layer': 'test',
            type: 'symbol',
            layout: {
                'icon-image': 'hello',
                'text-font': ['StandardFont-Bold'],
                'text-field': '{name}'
            }
        }]);

        const data = {
            layers: {
                test: {
                    version: 2,
                    name: 'test',
                    extent: 8192,
                    length: 1,
                    feature: (featureIndex: number) => ({
                        extent: 8192,
                        type: 1,
                        id: featureIndex,
                        properties: {
                            name: 'test'
                        },
                        loadGeometry () {
                            return [[{x: 0, y: 0}]];
                        }
                    })
                }
            }
        } as any as VectorTileLike;

        let cancelCount = 0;
        const actorMock = createFakeActor(undefined, () => { cancelCount += 1; });
        const sendAsync = actorMock.sendAsync;
        const onSettled = vi.fn();
        tile.parse(data, layerIndex, ['hello'], actorMock, SubdivisionGranularitySetting.noSubdivision).then(onSettled, onSettled);
        tile.parse(data, layerIndex, ['hello'], actorMock, SubdivisionGranularitySetting.noSubdivision).then(onSettled, onSettled);
        const result = await tile.parse(data, layerIndex, ['hello'], actorMock, SubdivisionGranularitySetting.noSubdivision);
        expect(onSettled).not.toHaveBeenCalled();
        expect(result).toBeDefined();
        expect(cancelCount).toBe(6);
        expect(sendAsync).toHaveBeenCalledTimes(9);
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({'icons': ['hello'], 'type': 'icons'})}), expect.any(Object));
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({'icons': ['hello'], 'type': 'patterns'})}), expect.any(Object));
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({data: expect.objectContaining({'source': 'source', 'type': 'glyphs', 'stacks': {'StandardFont-Bold': ['t', 'e', 's']}})}), expect.any(Object));
    });

    test('WorkerTile.parse passes global-state to layout properties', async () => {
        const globalState = {} as any;
        const layerIndex = new StyleLayerIndex([
            {
                id: 'layer-id',
                type: 'symbol',
                source: 'source',
                layout: {
                    'text-size': ['global-state', 'size']
                }
            }
        ], globalState);

        const tile = createWorkerTile({globalState});
        globalState.size = 12;
        await tile.parse(createLineWrapper(), layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision);
        const layer = layerIndex._layers['layer-id'];
        layer.recalculate({} as EvaluationParameters, []);
        const layout = layer.layout as PossiblyEvaluated<SymbolLayoutProps, SymbolLayoutPropsPossiblyEvaluated>;
        expect(layout.get('text-size').evaluate({} as any, {})).toBe(12);
    });

    test('WorkerTile.parse passes global-state to paint properties', async () => {
        const layerIndex = new StyleLayerIndex([
            {
                id: 'circle',
                type: 'circle',
                source: 'source',
                paint: {
                    'circle-color': ['global-state', 'color'],
                    'circle-radius': ['global-state', 'radius']
                }
            }
        ], {radius: 15, color: '#FF0000'});

        const tile = createWorkerTile({});
        await tile.parse(createLineWrapper(), layerIndex, [], {} as any, SubdivisionGranularitySetting.noSubdivision);
        const layer = layerIndex._layers['circle'];
        layer.recalculate({zoom: 0} as EvaluationParameters, []);
        const paint = layer.paint as PossiblyEvaluated<CirclePaintProps, CirclePaintPropsPossiblyEvaluated>;
        expect(paint.get('circle-color').evaluate({} as any, {})).toEqual(new Color(1, 0, 0, 1));
        expect(paint.get('circle-radius').evaluate({} as any, {})).toBe(15);
    });
});
