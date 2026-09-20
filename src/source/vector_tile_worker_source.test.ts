import {describe, beforeEach, afterEach, test, expect, vi} from 'vitest';
import fs from 'fs';
import path from 'path';
import {PbfReader} from 'pbf';
import {createMltDecodeOptions, VectorTileWorkerSource} from '../source/vector_tile_worker_source.ts';
import {StyleLayerIndex} from '../style/style_layer_index.ts';
import {fakeServer, type FakeServer} from 'nise';
import {WorkerTile} from './worker_tile.ts';
import {createFakeActor, setPerformance, sleep} from '../util/test/util.ts';
import {ABORT_ERROR} from '../util/abort_error.ts';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';
import {OverscaledTileID, CanonicalTileID} from '../tile/tile_id.ts';
import {VectorTile} from '@mapbox/vector-tile';
import Point from '@mapbox/point-geometry';
import {createConstGeometryVector, encodeFeatureTables, FeatureTable, GEOMETRY_TYPE, IntFlatVector, TopologyVector} from '@maplibre/mlt';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../util/mlt_materialization_stats.ts';
import {deserialize, serialize} from '../util/web_worker_transfer.ts';
import {getMltFeatureTable} from './vector_tile_mlt.ts';

import type {TileParameters, WorkerTileParameters, WorkerTileWithData} from './worker_source.ts';
import type {IActor} from '../util/actor.ts';
import type {FeatureIndex} from '../data/feature_index.ts';
import type {WorkerTileResult} from './worker_source.ts';

describe('vector tile worker source', () => {
    const actor = {sendAsync: () => Promise.resolve({})} as IActor;
    let server: FakeServer;

    beforeEach(() => {
        global.fetch = null;
        server = fakeServer.create();
        setPerformance();
    });

    afterEach(() => {
        server.restore();
        vi.restoreAllMocks();
    });
    test('VectorTileWorkerSource.abortTile aborts pending request', async () => {
        const source = new VectorTileWorkerSource(actor, new StyleLayerIndex(), []);

        const loadPromise = source.loadTile({
            source: 'source',
            uid: 0,
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
            request: {url: 'http://localhost:2900/abort'}
        } as any as WorkerTileParameters);

        const abortPromise = source.abortTile({
            source: 'source',
            uid: 0
        } as any as TileParameters);

        expect(source.tileState.loading).toEqual({});
        await expect(abortPromise).resolves.toBeFalsy();
        await expect(loadPromise).rejects.toThrow(expect.objectContaining({name: ABORT_ERROR}));
    });

    test('VectorTileWorkerSource.removeTile removes loaded tile', async () => {
        const source = new VectorTileWorkerSource(actor, new StyleLayerIndex(), []);

        source.tileState.loaded = {
            '0': {} as WorkerTile
        };

        await source.removeTile({
            source: 'source',
            uid: 0
        } as any as TileParameters);

        expect(source.tileState.loaded).toEqual({});
    });

    test('VectorTileWorkerSource.reloadTile reloads a previously-loaded tile', async () => {
        const source = new VectorTileWorkerSource(actor, new StyleLayerIndex(), []);
        const parse = vi.fn().mockResolvedValue({});

        source.tileState.loaded = {
            '0': {
                vectorTile: {},
                parse
            } as any as WorkerTile
        };

        const reloadPromise = source.reloadTile({uid: 0} as any as WorkerTileParameters);
        expect(parse).toHaveBeenCalledTimes(1);
        await expect(reloadPromise).resolves.toBeTruthy();
    });

    test('VectorTileWorkerSource keeps the etag across reloadTile so the next expiry refresh can return unmodified', async () => {
        const rawTileData = fs.readFileSync(path.join(__dirname, '/../../test/unit/assets/mbsv5-6-18-23.vector.pbf')).buffer.slice(0);
        const layerIndex = new StyleLayerIndex([{
            id: 'test',
            source: 'source',
            'source-layer': 'test',
            type: 'fill'
        }]);
        const source = new VectorTileWorkerSource(actor, layerIndex, []);
        source.loadVectorTile = () => ({vectorTile: new VectorTile(new PbfReader(rawTileData)), rawData: rawTileData});

        server.respondWith(request => {
            request.respond(200, {
                'Content-Type': 'application/pbf',
                'ETag': '"v1"',
                'Cache-Control': 'max-age=300'
            }, new ArrayBuffer(0) as any);
        });

        const params = {
            source: 'source',
            uid: 0,
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
            request: {url: 'http://localhost:2900/faketile.pbf'},
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision,
        } as any as WorkerTileParameters;

        const loadPromise = source.loadTile(params);
        server.respond();
        const loadResult = await loadPromise;
        const reloadResult = await source.reloadTile(params);
        const paramsWithEtagKeptFromReload = {...params, etag: reloadResult.etag};
        const expiryRefreshPromise = source.loadTile(paramsWithEtagKeptFromReload);
        server.respond();
        const expiryRefreshResult = await expiryRefreshPromise;

        expect(loadResult.etag).toBe('"v1"');
        expect(loadResult.cacheControl).toBe('max-age=300');
        expect(reloadResult.etag).toBe('"v1"');
        expect(reloadResult.cacheControl).toBeUndefined();
        expect(expiryRefreshResult.etagUnmodified).toBe(true);
    });

    test('VectorTileWorkerSource.loadTile reparses tile if the reloadTile has been called during parsing', async () => {
        const rawTileData = new ArrayBuffer(0);

        const layerIndex = new StyleLayerIndex([{
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

        const actor = createFakeActor();

        const source = new VectorTileWorkerSource(actor, layerIndex, ['hello']);
        source.loadVectorTile = (_params, _rawData) => {
            return {
                vectorTile: {
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
                                    return [[new Point(0, 0)]];
                                }
                            })
                        }
                    }
                },
                rawData: rawTileData
            };
        };

        server.respondWith(request => {
            request.respond(200, {'Content-Type': 'application/pbf'}, rawTileData as any);
        });

        const onSettled = vi.fn();
        source.loadTile({
            source: 'source',
            uid: 0,
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
            request: {url: 'http://localhost:2900/faketile.pbf'},
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision,
        } as any as WorkerTileParameters).then(onSettled, onSettled);

        server.respond();

        // allow promise to run
        await sleep(0);

        const res = await source.reloadTile({
            source: 'source',
            uid: 0,
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision,
        } as any as WorkerTileParameters) as WorkerTileWithData;
        expect(onSettled).not.toHaveBeenCalled();
        expect(res).toBeDefined();
        expect(res.rawTileData).toBeDefined();
        expect(res.rawTileData).toStrictEqual(rawTileData);
    });

    test('VectorTileWorkerSource.reloadTile includes rawTileData in response if loadTile was aborted', async () => {
        const rawTileData = new ArrayBuffer(0);

        const layerIndex = new StyleLayerIndex([{
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

        let sendAsyncShouldAbort = false;
        const actor = createFakeActor(() => sendAsyncShouldAbort);

        const source = new VectorTileWorkerSource(actor, layerIndex, ['hello']);
        source.loadVectorTile = (_params, _rawData) => {
            return {
                vectorTile: {
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
                                    return [[new Point(0, 0)]];
                                }
                            })
                        }
                    }
                },
                rawData: rawTileData
            };
        };

        server.respondWith(request => {
            request.respond(200, {'Content-Type': 'application/pbf'}, rawTileData as any);
        });

        sendAsyncShouldAbort = true;
        const loadTilePromise = source.loadTile({
            source: 'source',
            uid: 0,
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
            request: {url: 'http://localhost:2900/faketile.pbf'},
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision,
        } as any as WorkerTileParameters);
        server.respond();
        await expect(loadTilePromise).rejects.toThrow(/aborted/);

        sendAsyncShouldAbort = false;
        const res = await source.reloadTile({
            source: 'source',
            uid: 0,
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision,
        } as any as WorkerTileParameters) as WorkerTileWithData;
        expect(res).toBeDefined();
        expect(res.rawTileData).toBeDefined();
        expect(res.rawTileData).toStrictEqual(rawTileData);
    });

    test('VectorTileWorkerSource.loadTile reparses tile if reloadTile is called during reparsing', async () => {
        const rawTileData = new ArrayBuffer(0);
        const loadVectorData = (_params, _rawData) => {
            return {
                vectorTile: new VectorTile(new PbfReader(rawTileData)),
                rawData: rawTileData,
                encoding: 'mvt'
            };
        };

        const layerIndex = new StyleLayerIndex([{
            id: 'test',
            source: 'source',
            'source-layer': 'test',
            type: 'fill'
        }]);

        const source = new VectorTileWorkerSource(actor, layerIndex, []);
        source.loadVectorTile = loadVectorData;

        const parseWorkerTileMock = vi
            .spyOn(WorkerTile.prototype, 'parse')
            .mockImplementation(function(this: WorkerTile, _data, _layerIndex, _availableImages, _actor) {
                return new Promise((resolve) => {
                    setTimeout(() => resolve({} as WorkerTileWithData), 20);
                });
            });

        server.respondWith(request => {
            request.respond(200, {'Content-Type': 'application/pbf'}, rawTileData as any);
        });

        const loadPromise = source.loadTile({
            source: 'source',
            uid: 0,
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
            request: {url: 'http://localhost:2900/faketile.pbf'}
        } as any as WorkerTileParameters);

        server.respond();

        // let the promise start
        await sleep(0);

        const res = await source.reloadTile({
            source: 'source',
            uid: '0',
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
        } as any as WorkerTileParameters);
        expect(res).toBeDefined();
        expect(parseWorkerTileMock).toHaveBeenCalledTimes(2);
        await expect(loadPromise).resolves.toBeTruthy();
    });

    test('VectorTileWorkerSource.reloadTile during loadTile returns data even if interrupted by another reloadTile', async () => {
        const rawTileData = new ArrayBuffer(0);
        const loadVectorData = (_params, _rawData) => {
            return {
                vectorTile: new VectorTile(new PbfReader(rawTileData)),
                rawData: rawTileData,
                encoding: 'mvt'
            };
        };

        const layerIndex = new StyleLayerIndex([{
            id: 'test',
            source: 'source',
            'source-layer': 'test',
            type: 'fill'
        }]);

        const source = new VectorTileWorkerSource(actor, layerIndex, []);
        source.loadVectorTile = loadVectorData;

        const parseWorkerTileMock = vi
            .spyOn(WorkerTile.prototype, 'parse')
            .mockImplementation(function(this: WorkerTile, _data, _layerIndex, _availableImages, _actor) {
                return new Promise((resolve) => {
                    setTimeout(() => resolve({} as WorkerTileWithData), 20);
                });
            });

        server.respondWith(request => {
            request.respond(200, {'Content-Type': 'application/pbf'}, rawTileData as any);
        });

        const loadPromise = source.loadTile({
            source: 'source',
            uid: 0,
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
            request: {url: 'http://localhost:2900/faketile.pbf'}
        } as any as WorkerTileParameters);

        server.respond();

        // Let the load start
        await sleep(0);

        // This reload will be interrupted by the next one
        source.reloadTile({
            source: 'source',
            uid: '0',
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
        } as any as WorkerTileParameters);

        const res = await source.reloadTile({
            source: 'source',
            uid: '0',
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
        } as any as WorkerTileParameters);
        expect(res).toBeDefined();
        expect((res as WorkerTileWithData).rawTileData).toBeDefined();
        expect(parseWorkerTileMock).toHaveBeenCalledTimes(3);
        await expect(loadPromise).resolves.toBeTruthy();
    });

    test.each(['mvt', 'mlt'] as const)('preserves %s encoding and empty queries when overzooming an empty tile', async encoding => {
        const source = new VectorTileWorkerSource(actor, new StyleLayerIndex([{
            id: 'empty', source: 'test', 'source-layer': 'empty', type: 'line'
        }]), []);
        server.respondWith(request => {
            request.respond(200, {'Content-Type': 'application/pbf'}, new ArrayBuffer(0) as any);
        });

        const params = {
            uid: '1',
            encoding, zoom: 16, tileSize: 512, pixelRatio: 1,
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision,
            tileID: new OverscaledTileID(16, 0, 16, 100, 100),
            source: 'test',
            overzoomParameters: {
                maxZoomTileID: new CanonicalTileID(14, 25, 25),
                overzoomRequest: {url: ''}
            }
        } as WorkerTileParameters;

        const promise = source.loadTile(params);
        server.respond();
        const result = await promise as WorkerTileWithData;
        expect(result.encoding).toBe(encoding);
        expect(result.buckets).toEqual([]);
        result.featureIndex.rawTileData = result.rawTileData;
        result.featureIndex.encoding = encoding;
        expect(result.featureIndex.loadVTLayers()).toEqual({});
    });

    test('VectorTileWorkerSource overzooms MLT directly and transfers deferred query coordinates', async () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'line-layer',
            source: 'source',
            'source-layer': 'roads',
            type: 'line'
        }]);
        const source = new VectorTileWorkerSource(actor, layerIndex, []);
        const geometryVector = createConstGeometryVector(
            1,
            GEOMETRY_TYPE.LINESTRING,
            new TopologyVector(undefined, new Uint32Array([0, 2])),
            undefined,
            new Int32Array([1800, 10, 2300, 10])
        );
        const featureTable = new FeatureTable('roads', geometryVector);
        const rawData = encodeFeatureTables([featureTable]);
        server.respondWith(request => request.respond(200, {}, rawData as any));
        const stats = createMltMaterializationStats({strict: true});
        const deactivateStats = activateMltMaterializationStats(stats);
        const results: WorkerTileWithData[] = [];
        const params = {
            encoding: 'mlt', zoom: 15, tileSize: 512, pixelRatio: 1,
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision,
            source: 'source',
            request: {url: 'http://localhost/roads.mlt'},
            tileID: new OverscaledTileID(15, 0, 15, 0, 0),
            overzoomParameters: {
                maxZoomTileID: new CanonicalTileID(14, 0, 0),
                overzoomRequest: {url: 'http://localhost/roads.mlt'}
            }
        } as WorkerTileParameters;
        try {
            for (const uid of ['cold', 'cached']) {
                const pending = source.loadTile({...params, uid});
                server.respond();
                results.push(await pending as WorkerTileWithData);
            }
        } finally {
            deactivateStats();
        }

        for (const result of results) {
            expect(new Uint8Array(result.rawTileData)).toEqual(new Uint8Array(rawData));
            const index = deserialize(serialize(result.featureIndex)) as FeatureIndex;
            expect(index.mltOverzoom).toEqual({z: 14, x: 0, y: 0});
            index.rawTileData = result.rawTileData; index.encoding = 'mlt';
            const table = getMltFeatureTable(index.loadVTLayers().roads);
            expect(table.numFeatures).toBe(1);
            expect(table.geometryVector.topologyVector.partOffsets).toEqual(new Uint32Array([0, 2]));
            expect(Array.from(table.geometryVector.vertexBuffer)).toEqual([3600, 20, 4224, 20]);
            expect(index.loadVTLayers()).toBe(index.vtLayers);
        }
        expect(stats.counters.mvtReencodes).toBe(0);
        expect(stats.counters.overzoomPointObjects).toBe(0);
        expect(stats.counters.overzoomFeaturesClipped).toBe(1);
        expect(stats.counters.decodedLayers).toBe(1);
        expect(source.overzoomedTileResultCache.stats).toMatchObject({
            hits: 1,
            misses: 1,
            evictions: 0,
            entries: 1
        });
        expect(source.overzoomedTileResultCache.stats.bytes).toBeGreaterThan(rawData.byteLength);
    });

    test('overzoomed MLT raw data preserves unstyled properties on a cold load and cache hit', async () => {
        const table = new FeatureTable('roads', createConstGeometryVector(
            1, GEOMETRY_TYPE.LINESTRING, new TopologyVector(undefined, new Uint32Array([0, 2])),
            undefined, new Int32Array([1800, 10, 2300, 10])
        ), new IntFlatVector('id', new Int32Array([42]), 1), [
            new IntFlatVector('width', new Int32Array([2]), 1),
            new IntFlatVector('public-only', new Int32Array([73]), 1)
        ]);
        const rawData = encodeFeatureTables([table]);
        const source = new VectorTileWorkerSource(actor, new StyleLayerIndex([{
            id: 'line', source: 'source', 'source-layer': 'roads', type: 'line', paint: {'line-width': ['get', 'width']}
        }]), []);
        const params = {
            uid: 'cold', source: 'source', encoding: 'mlt', zoom: 15, tileSize: 512, pixelRatio: 1,
            tileID: new OverscaledTileID(15, 0, 15, 0, 0),
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision,
            request: {url: 'http://localhost/roads.mlt'},
            overzoomParameters: {
                maxZoomTileID: new CanonicalTileID(14, 0, 0),
                overzoomRequest: {url: 'http://localhost/roads.mlt'}
            }
        } as WorkerTileParameters;
        server.respondWith(request => {
            expect(request.url).toBe('http://localhost/roads.mlt');
            request.respond(200, {'Content-Type': 'application/octet-stream'}, rawData as any);
        });
        const stats = createMltMaterializationStats({strict: true});
        const restore = activateMltMaterializationStats(stats);
        const responses: WorkerTileWithData[] = [];
        try {
            for (const uid of ['cold', 'cached']) {
                const pending = source.loadTile({...params, uid});
                server.respond();
                responses.push(await pending as WorkerTileWithData);
            }
        } finally {
            restore();
        }
        for (const response of responses) {
            response.featureIndex.rawTileData = response.rawTileData;
            response.featureIndex.encoding = 'mlt';
            const decoded = getMltFeatureTable(response.featureIndex.loadVTLayers().roads);
            expect(decoded.propertyVectors).toHaveLength(0);
            expect(decoded.getPropertyVector('width').getValue(0)).toBe(2);
            expect(decoded.getPropertyVector('public-only')?.getValue(0)).toBe(73);
        }
        expect(source.overzoomedTileResultCache.stats.hits).toBe(1);
        expect(stats.counters.decodedColumns).toBe(3);
        for (const counter of stats.forbiddenCounters) expect(stats.counters[counter]).toBe(0);
    });

    test('VectorTileWorkerSource projects exact MLT application property dependencies', () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'road-layer',
            source: 'source',
            'source-layer': 'road',
            type: 'line',
            filter: ['==', ['get', 'class'], 'street'],
            paint: {
                'line-color': {
                    property: 'surface',
                    type: 'categorical',
                    stops: [['paved', 'red']]
                }
            }
        } as any]);

        const options = createMltDecodeOptions({
            source: 'source',
            promoteId: {road: 'fid'}
        } as any as WorkerTileParameters, layerIndex);

        expect(options.layerNames).toEqual(['road']);
        const propertyColumnNamesByLayer = options.propertyColumnNamesByLayer as Map<string, Set<string>>;
        expect(Array.from(propertyColumnNamesByLayer.get('road')).sort()).toEqual(['class', 'fid', 'surface']);
    });

    test('VectorTileWorkerSource keeps MLT line-gradient clip columns', () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'gradient-layer',
            source: 'source',
            'source-layer': 'gradient',
            type: 'line',
            paint: {
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

        const options = createMltDecodeOptions({
            source: 'source'
        } as any as WorkerTileParameters, layerIndex);

        const propertyColumnNamesByLayer = options.propertyColumnNamesByLayer as Map<string, Set<string>>;
        expect(Array.from(propertyColumnNamesByLayer.get('gradient')).sort()).toEqual([
            'geojsonvt_clip_end', 'geojsonvt_clip_start', 'mapbox_clip_end', 'mapbox_clip_start'
        ]);
    });

    test('VectorTileWorkerSource projects exact MLT symbol property dependencies', () => {
        const layerIndex = new StyleLayerIndex([{
            id: 'symbol-layer',
            source: 'source',
            'source-layer': 'poi_label',
            type: 'symbol',
            filter: ['==', 'maki', 'restaurant'],
            layout: {
                'text-field': 'Test'
            }
        } as any]);

        const options = createMltDecodeOptions({
            source: 'source'
        } as any as WorkerTileParameters, layerIndex);

        const propertyColumnNamesByLayer = options.propertyColumnNamesByLayer as Map<string, Set<string>>;
        expect(Array.from(propertyColumnNamesByLayer.get('poi_label'))).toEqual(['maki']);
    });

    test('VectorTileWorkerSource.reloadTile does not reparse tiles with no vectorTile data but does call callback', async () => {
        const source = new VectorTileWorkerSource(actor, new StyleLayerIndex(), []);
        const parse = vi.fn();

        source.tileState.loaded = {
            '0': {
                parse
            } as any as WorkerTile
        };

        await source.reloadTile({uid: 0} as any as WorkerTileParameters);
        expect(parse).not.toHaveBeenCalled();
    });

    test('VectorTileWorkerSource.loadTile returns null for an empty tile', async () => {
        const source = new VectorTileWorkerSource(actor, new StyleLayerIndex(), []);
        source.loadVectorTile = (_params, _rawData) => null;
        const parse = vi.fn();

        server.respondWith(request => {
            request.respond(200, {'Content-Type': 'application/pbf'}, 'something...');
        });

        const promise = source.loadTile({
            source: 'source',
            uid: 0,
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
            request: {url: 'http://localhost:2900/faketile.pbf'}
        } as any as WorkerTileParameters);

        server.respond();

        expect(parse).not.toHaveBeenCalled();
        await expect(promise).resolves.toBeNull();
    });

    test('VectorTileWorkerSource.returns a good error message when failing to parse a tile', async () => {
        const source = new VectorTileWorkerSource(actor, new StyleLayerIndex(), []);
        const parse = vi.fn();

        server.respondWith(request => {
            request.respond(200, {'Content-Type': 'application/pbf'}, 'something...');
        });

        const loadTilePromise = source.loadTile({
            source: 'source',
            uid: 0,
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
            request: {url: 'http://localhost:2900/faketile.pbf'}
        } as any as WorkerTileParameters);

        server.respond();

        expect(parse).not.toHaveBeenCalled();
        await expect(loadTilePromise).rejects.toThrow(/Unable to parse the tile at/);
    });

    test('VectorTileWorkerSource.returns a good error message when failing to parse a gzipped tile', async () => {
        const source = new VectorTileWorkerSource(actor, new StyleLayerIndex(), []);
        const parse = vi.fn();

        server.respondWith(new Uint8Array([0x1f, 0x8b]).buffer);

        const loadTilePromise = source.loadTile({
            source: 'source',
            uid: 0,
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
            request: {url: 'http://localhost:2900/faketile.pbf'}
        } as any as WorkerTileParameters);

        server.respond();

        expect(parse).not.toHaveBeenCalled();
        await expect(loadTilePromise).rejects.toThrow(/gzipped/);
    });

    test('VectorTileWorkerSource provides resource timing information', async () => {
        const rawTileData = fs.readFileSync(path.join(__dirname, '/../../test/unit/assets/mbsv5-6-18-23.vector.pbf')).buffer.slice(0);

        const loadVectorData = (_params, _rawData) => {
            return {
                vectorTile: new VectorTile(new PbfReader(rawTileData)),
                rawData: rawTileData,
                cacheControl: null,
                expires: null,
                encoding: 'mvt'
            };
        };

        const exampleResourceTiming = {
            connectEnd: 473,
            connectStart: 473,
            decodedBodySize: 86494,
            domainLookupEnd: 473,
            domainLookupStart: 473,
            duration: 341,
            encodedBodySize: 52528,
            entryType: 'resource',
            fetchStart: 473.5,
            initiatorType: 'xmlhttprequest',
            name: 'http://localhost:2900/faketile.pbf',
            nextHopProtocol: 'http/1.1',
            redirectEnd: 0,
            redirectStart: 0,
            requestStart: 477,
            responseEnd: 815,
            responseStart: 672,
            secureConnectionStart: 0
        };

        const layerIndex = new StyleLayerIndex([{
            id: 'test',
            source: 'source',
            'source-layer': 'test',
            type: 'fill'
        }]);

        const source = new VectorTileWorkerSource(actor, layerIndex, []);
        source.loadVectorTile = loadVectorData;

        window.performance.getEntriesByName = vi.fn().mockReturnValue([exampleResourceTiming]);

        server.respondWith(request => {
            request.respond(200, {'Content-Type': 'application/pbf'}, 'ok');
        });

        const promise = source.loadTile({
            source: 'source',
            uid: 0,
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
            request: {url: 'http://localhost:2900/faketile.pbf', collectResourceTiming: true}
        } as any as WorkerTileParameters);

        await sleep(0);
        server.respond();
        const res = await promise;

        expect(res.resourceTiming[0]).toEqual(exampleResourceTiming);
    });

    test('VectorTileWorkerSource provides resource timing information (fallback method)', async () => {
        const rawTileData = fs.readFileSync(path.join(__dirname, '/../../test/unit/assets/mbsv5-6-18-23.vector.pbf')).buffer.slice(0);

        const loadVectorData = (_params, _rawData) => {
            return {
                vectorTile: new VectorTile(new PbfReader(rawTileData)),
                rawData: rawTileData,
                cacheControl: null,
                expires: null,
                encoding: 'mvt'
            };
        };

        const layerIndex = new StyleLayerIndex([{
            id: 'test',
            source: 'source',
            'source-layer': 'test',
            type: 'fill'
        }]);

        const source = new VectorTileWorkerSource(actor, layerIndex, []);
        source.loadVectorTile = loadVectorData;

        const sampleMarks = [100, 350];
        const marks = {};
        const measures = {};
        window.performance.getEntriesByName = vi.fn().mockImplementation(name => (measures[name] || []));
        window.performance.mark = vi.fn().mockImplementation(name => {
            marks[name] = sampleMarks.shift();
            return null;
        });
        window.performance.measure = vi.fn().mockImplementation((name, start, end) => {
            measures[name] ||= [];
            measures[name].push({
                duration: marks[end] - marks[start],
                entryType: 'measure',
                name,
                startTime: marks[start]
            });
            return null;
        });

        server.respondWith(request => {
            request.respond(200, {'Content-Type': 'application/pbf'}, 'ok');
        });

        const promise = source.loadTile({
            source: 'source',
            uid: 0,
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
            request: {url: 'http://localhost:2900/faketile.pbf', collectResourceTiming: true}
        } as any as WorkerTileParameters);

        await sleep(0);
        server.respond();
        const res = await promise;

        expect(res.resourceTiming[0]).toEqual(
            {'duration': 250, 'entryType': 'measure', 'name': 'http://localhost:2900/faketile.pbf', 'startTime': 100}
        );
    });

    test('VectorTileWorkerSource.loadTile skips parsing and returns unmodified when e-tags match', async () => {
        const source = new VectorTileWorkerSource(actor, new StyleLayerIndex(), []);

        source.loadVectorTile = () => {
            throw new Error('loadVectorTile should not be called when etag matches');
        };

        const rawTileData = new ArrayBuffer(0);
        server.respondWith(request => {
            request.respond(200, {
                'Content-Type': 'application/pbf',
                'ETag': '"v1"'
            }, rawTileData as any);
        });

        const promise = source.loadTile({
            source: 'source',
            uid: 0,
            tileID: {overscaledZ: 0, wrap: 0, canonical: {x: 0, y: 0, z: 0, w: 0}},
            request: {url: 'http://localhost:2900/faketile.pbf'},
            etag: '"v1"',
            subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision,
        } as any as WorkerTileParameters);

        server.respond();
        const res = await promise;

        expect(res).toBeDefined();
        expect(res.etagUnmodified).toBe(true);
    });
});
