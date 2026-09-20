import {describe, test, expect, vi} from 'vitest';
import {createSymbolBucket} from '../../test/unit/lib/create_symbol_layer.ts';
import {FadingDirections, FadingRoles, Tile} from './tile.ts';
import {OverscaledTileID} from './tile_id.ts';
import {WorkerTile} from '../source/worker_tile.ts';
import {StyleLayerIndex} from '../style/style_layer_index.ts';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';
import fs from 'fs';
import path from 'path';
import {type Feature, fromVectorTileJs, GeoJSONWrapper} from '@maplibre/vt-pbf';
import {FeatureIndex, GEOJSON_TILE_LAYER_NAME} from '../data/feature_index.ts';
import {CollisionBoxArray} from '../data/array_types.g.ts';
import {extend} from '../util/util.ts';
import {serialize, deserialize} from '../util/web_worker_transfer.ts';
import {MLTVectorTile} from '../source/vector_tile_mlt.ts';
import {ColumnarLineBucket} from '../data/bucket/columnar/columnar_line_bucket.ts';
import {ColumnarFillBucket} from '../data/bucket/columnar/columnar_fill_bucket.ts';
import {ColumnarCircleBucket} from '../data/bucket/columnar/columnar_circle_bucket.ts';
import {ColumnarFillExtrusionBucket} from '../data/bucket/columnar/columnar_fill_extrusion_bucket.ts';
import {LineStyleLayer} from '../style/style_layer/line_style_layer.ts';
import {FillStyleLayer} from '../style/style_layer/fill_style_layer.ts';
import {CircleStyleLayer} from '../style/style_layer/circle_style_layer.ts';
import {FillExtrusionStyleLayer} from '../style/style_layer/fill_extrusion_style_layer.ts';
import {SymbolStyleLayer} from '../style/style_layer/symbol_style_layer.ts';
import {CanonicalTileID} from './tile_id.ts';
import {createPopulateOptions} from '../../test/unit/lib/tile.ts';
import {normalizeMltFeatureId} from '../util/mlt_feature_id.ts';
import {AlphaImage} from '../util/image.ts';
import {MessageType} from '../util/actor_messages.ts';
import {
    createSyntheticMltTile,
    createSyntheticLineFeatureTable,
    createSyntheticPointFeatureTable,
    createSyntheticPolygonFeatureTable,
    signedMltFeatureId,
    syntheticLineLayer,
    syntheticLineFeatures,
    syntheticPointLayer,
    syntheticPointFeatures,
    syntheticPolygonLayer,
    syntheticPolygonFeatures,
} from '../../test/unit/lib/mlt_synthetic.ts';
import {createStringFlatVector, FeatureTable} from '@maplibre/mlt';
import {activateMltMaterializationStats, createMltMaterializationStats, MLT_ESTIMATED_GEOJSON_QUERY_RESULT_BYTES} from '../util/mlt_materialization_stats.ts';

import type {WorkerTileParameters} from '../source/worker_source.ts';
import type {Painter} from '../render/painter.ts';
import type {BucketParameters} from '../data/bucket.ts';
import type {ZoomHistory} from '../style/zoom_history.ts';
import type {EvaluationParameters} from '../style/evaluation_parameters.ts';
import type {SymbolBucket} from '../data/bucket/symbol_bucket.ts';

describe('isRenderable', () => {
    test('keeps transparent incoming raster tiles renderable so their fade can advance', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512);
        tile.state = 'loaded';
        tile.setCrossFadeLogic({
            fadingRole: FadingRoles.Base,
            fadingDirection: FadingDirections.Incoming,
            fadingParentID: new OverscaledTileID(0, 0, 0, 0, 0),
            fadeEndTime: 300
        });
        tile.fadeOpacity = 0;

        expect(tile.isRenderable(false)).toBe(true);
    });

    test('keeps transparent self-fading raster tiles renderable only after loading', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512);
        tile.setSelfFadeLogic(300);
        tile.fadeOpacity = 0;

        expect(tile.isRenderable(false)).toBe(false);
        tile.state = 'loaded';
        expect(tile.isRenderable(false)).toBe(true);
    });

    test('excludes departing raster tiles once they are transparent', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 0, 0), 512);
        tile.state = 'loaded';
        tile.setCrossFadeLogic({
            fadingRole: FadingRoles.Base,
            fadingDirection: FadingDirections.Departing,
            fadingParentID: new OverscaledTileID(0, 0, 0, 0, 0),
            fadeEndTime: 300
        });

        expect(tile.isRenderable(false)).toBe(true);
        tile.fadeOpacity = 0;
        expect(tile.isRenderable(false)).toBe(false);
    });
});

describe('querySourceFeatures', () => {
    const features = [{
        type: 1,
        geometry: [0, 0],
        tags: {oneway: true}
    } as any as Feature];

    test('not data', () => {
        const tile = new Tile(new OverscaledTileID(3, 0, 2, 1, 2), undefined);
        const result = [];
        tile.querySourceFeatures(result);
        expect(result).toHaveLength(0);
    });

    describe('geojson tile', () => {
        const tile = new Tile(new OverscaledTileID(3, 0, 2, 1, 2), undefined);
        const geojsonWrapper = new GeoJSONWrapper(features);
        geojsonWrapper.name = GEOJSON_TILE_LAYER_NAME;
        tile.loadVectorData(
            createVectorData({rawTileData: fromVectorTileJs({layers: {[GEOJSON_TILE_LAYER_NAME]: geojsonWrapper}})}),
            createPainter()
        );

        test('query all source features', () => {
            let result = [];
            tile.querySourceFeatures(result);
            expect(result).toHaveLength(1);
            expect(result[0].geometry.coordinates[0]).toEqual([-90, 0]);
            result = [];
            tile.querySourceFeatures(result, {});
            expect(result).toHaveLength(1);
            expect(result[0].properties).toEqual(features[0].tags);
        });

        test('filter source features', () => {
            let result = [];
            tile.querySourceFeatures(result, {sourceLayer: undefined, filter: ['==', 'oneway', true]});
            expect(result).toHaveLength(1);
            result = [];
            tile.querySourceFeatures(result, {sourceLayer: undefined, filter: ['!=', 'oneway', true]});
            expect(result).toHaveLength(0);
            result = [];
            const polygon = {type: 'Polygon',  coordinates: [[[-91, -1], [-89, -1], [-89, 1], [-91, 1], [-91, -1]]]} as GeoJSON.GeoJSON;
            tile.querySourceFeatures(result, {sourceLayer: undefined, filter: ['within', polygon]});
            expect(result).toHaveLength(1);
        });

        test('filter with global-state', () => {
            let result = [];
            tile.querySourceFeatures(result, {sourceLayer: undefined, filter: ['==', ['get', 'oneway'], ['global-state', 'isOneway']] , globalState: {isOneway: true}});
            expect(result).toHaveLength(1);
            result = [];
            tile.querySourceFeatures(result, {sourceLayer: undefined, filter: ['!=', ['get', 'oneway'], ['global-state', 'isOneway']], globalState: {isOneway: true}});
            expect(result).toHaveLength(0);
        });
    });

    test('empty geojson tile', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 1, 1), undefined);
        let result;

        result = [];
        tile.querySourceFeatures(result);
        expect(result).toHaveLength(0);

        const geojsonWrapper = new GeoJSONWrapper([]);
        geojsonWrapper.name = GEOJSON_TILE_LAYER_NAME;

        result = [];
        expect(() => tile.querySourceFeatures(result)).not.toThrow();
        expect(result).toHaveLength(0);
    });

    test('vector tile', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 1, 1), undefined);
        let result;

        result = [];
        tile.querySourceFeatures(result);
        expect(result).toHaveLength(0);

        tile.loadVectorData(
            createVectorData({rawTileData: createRawTileData()}),
            createPainter()
        );

        result = [];
        tile.querySourceFeatures(result, {sourceLayer: 'does-not-exist', filter: undefined});
        expect(result).toHaveLength(0);

        result = [];
        tile.querySourceFeatures(result, {sourceLayer: 'road', filter: undefined});
        expect(result).toHaveLength(3);

        result = [];
        tile.querySourceFeatures(result, {sourceLayer: 'road', filter: ['==', 'class', 'main']});
        expect(result).toHaveLength(1);
        result = [];
        tile.querySourceFeatures(result, {sourceLayer: 'road', filter: ['!=', 'class', 'main']});
        expect(result).toHaveLength(2);

    });

    test('loadVectorData unloads existing data before overwriting it', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 1, 1), undefined);
        tile.state = 'loaded';
        const spy = vi.spyOn(tile, 'unloadVectorData');
        const painter = createPainter();

        tile.loadVectorData(null, painter);

        expect(spy).toHaveBeenCalledWith();
    });

    test('loadVectorData should not do anything if etag was unchanged', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 1, 1), undefined);
        tile.state = 'loading';
        const painter = createPainter();

        tile.loadVectorData({etagUnmodified: true}, painter);

        expect(tile.state).toBe('loaded');
    });

    test('loadVectorData preserves the most recent rawTileData', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 1, 1), undefined);
        tile.state = 'loaded';

        tile.loadVectorData(
            createVectorData({rawTileData: createRawTileData()}),
            createPainter()
        );
        tile.loadVectorData(
            createVectorData(),
            createPainter()
        );

        const features = [];
        tile.querySourceFeatures(features, {sourceLayer: 'road', filter: undefined});
        expect(features).toHaveLength(3);

    });

    test('appends a high-cardinality MLT selection with lazy independent outputs', () => {
        const featureCount = 640;
        const baseFeature = syntheticPointFeatures()[0];
        const featureTable = createSyntheticPointFeatureTable(Array.from({length: featureCount}, (_, index) => ({
            id: index + 1000,
            point: [index % 4096, Math.floor(index / 16)] as [number, number],
            properties: {
                ...baseFeature.properties,
                sort: index,
                label: `feature-${index}`,
            },
        })));
        const tileID = new OverscaledTileID(3, 0, 2, 1, 2);
        const featureIndex = new FeatureIndex(tileID, 'sort');
        featureIndex.encoding = 'mlt';
        featureIndex.rawTileData = new ArrayBuffer(1);
        featureIndex.vtLayers = MLTVectorTile.fromFeatureTables([featureTable]).layers;
        const sourceLayer = featureIndex.vtLayers[syntheticPointLayer];
        const materializeFeature = vi.spyOn(sourceLayer, 'feature');
        const tile = new Tile(tileID, undefined);
        tile.latestFeatureIndex = featureIndex;
        const sentinel = {sentinel: true};
        const result: any[] = [sentinel];
        const stats = createMltMaterializationStats();
        const deactivate = activateMltMaterializationStats(stats);

        try {
            tile.querySourceFeatures(result, {sourceLayer: syntheticPointLayer, filter: ['all', ['==', ['zoom'], 3], ['is-supported-script', ['get', 'label']]]});
            expect(result).toHaveLength(featureCount + 1);
            expect(result[0]).toBe(sentinel);
            expect(result[1].id).toBe(0);
            expect(result[featureCount].id).toBe(featureCount - 1);
            expect(materializeFeature).not.toHaveBeenCalled();
            expect(stats.counters.queryCandidates).toBe(featureCount);
            expect(stats.counters.queryResults).toBe(featureCount);
            expect(stats.counters.estimatedQueryResultBytes).toBe(featureCount * MLT_ESTIMATED_GEOJSON_QUERY_RESULT_BYTES);
            expect(stats.counters.vectorTileFeatureWrappers).toBe(0);
            expect(stats.counters.propertyObjects).toBe(0);
            expect(stats.counters.queryGeometriesLoaded).toBe(0);
            expect(stats.counters.geometryPartsMaterialized).toBe(0);
            expect(stats.counters.pointObjects).toBe(0);

            expect(new Set([result[1], result[2]])).toHaveLength(2);
            const firstProperties = result[1].properties;
            expect(stats.counters.propertyObjects).toBe(1);
            expect(firstProperties.label).toBe('feature-0');
            firstProperties.label = 'mutated';
            expect(result[2].properties.label).toBe('feature-1');
            expect(result[1].geometry).not.toBe(result[2].geometry);
        } finally {
            deactivate();
        }

        const nextResult: any[] = [];
        tile.querySourceFeatures(nextResult, {sourceLayer: syntheticPointLayer});
        expect(nextResult[0]).not.toBe(result[1]);
        expect(nextResult[0].properties.label).toBe('feature-0');
    });

});

describe('Tile.isLessThan', () => {
    test('correctly sorts tiles', () => {
        const tiles = [
            new OverscaledTileID(9, 0, 9, 146, 195),
            new OverscaledTileID(9, 0, 9, 147, 195),
            new OverscaledTileID(9, 0, 9, 148, 195),
            new OverscaledTileID(9, 0, 9, 149, 195),
            new OverscaledTileID(9, 1, 9, 144, 196),
            new OverscaledTileID(9, 0, 9, 145, 196),
            new OverscaledTileID(9, 0, 9, 146, 196),
            new OverscaledTileID(9, 1, 9, 147, 196),
            new OverscaledTileID(9, 0, 9, 145, 194),
            new OverscaledTileID(9, 0, 9, 149, 196),
            new OverscaledTileID(10, 0, 10, 293, 391),
            new OverscaledTileID(10, 0, 10, 291, 390),
            new OverscaledTileID(10, 1, 10, 293, 390),
            new OverscaledTileID(10, 0, 10, 294, 390),
            new OverscaledTileID(10, 0, 10, 295, 390),
            new OverscaledTileID(10, 0, 10, 291, 391),
        ];

        const sortedTiles = tiles.sort((a, b) => { return a.isLessThan(b) ? -1 : b.isLessThan(a) ? 1 : 0; });

        expect(sortedTiles).toEqual([
            new OverscaledTileID(9, 0, 9, 145, 194),
            new OverscaledTileID(9, 0, 9, 145, 196),
            new OverscaledTileID(9, 0, 9, 146, 195),
            new OverscaledTileID(9, 0, 9, 146, 196),
            new OverscaledTileID(9, 0, 9, 147, 195),
            new OverscaledTileID(9, 0, 9, 148, 195),
            new OverscaledTileID(9, 0, 9, 149, 195),
            new OverscaledTileID(9, 0, 9, 149, 196),
            new OverscaledTileID(10, 0, 10, 291, 390),
            new OverscaledTileID(10, 0, 10, 291, 391),
            new OverscaledTileID(10, 0, 10, 293, 391),
            new OverscaledTileID(10, 0, 10, 294, 390),
            new OverscaledTileID(10, 0, 10, 295, 390),
            new OverscaledTileID(9, 1, 9, 144, 196),
            new OverscaledTileID(9, 1, 9, 147, 196),
            new OverscaledTileID(10, 1, 10, 293, 390),
        ]);
    });
});

describe('expiring tiles', () => {
    test('regular tiles do not expire', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 1, 1), undefined);
        tile.state = 'loaded';
        tile.timeAdded = Date.now();

        expect(tile.getExpiryTimeout()).toBeFalsy();

    });

    test('set, get expiry', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 1, 1), undefined);
        tile.state = 'loaded';
        tile.timeAdded = Date.now();

        tile.setExpiryData({
            cacheControl: 'max-age=60'
        });

        // times are fuzzy, so we'll give this a little leeway:
        let expiryTimeout = tile.getExpiryTimeout();
        expect(expiryTimeout >= 56000 && expiryTimeout <= 60000).toBeTruthy();

        const date = new Date();
        date.setMinutes(date.getMinutes() + 10);
        date.setMilliseconds(0);

        tile.setExpiryData({
            expires: date.toString()
        });

        expiryTimeout = tile.getExpiryTimeout();
        expect(expiryTimeout > 598000 && expiryTimeout < 600000).toBeTruthy();

    });

    test('exponential backoff handling', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 1, 1), undefined);
        tile.state = 'loaded';
        tile.timeAdded = Date.now();

        tile.setExpiryData({
            cacheControl: 'max-age=10'
        });

        const expiryTimeout = tile.getExpiryTimeout();
        expect(expiryTimeout >= 8000 && expiryTimeout <= 10000).toBeTruthy();

        const justNow = new Date();
        justNow.setSeconds(justNow.getSeconds() - 1);

        // every time we set a tile's expiration to a date already expired,
        // it assumes it comes from a new HTTP response, so this is counted
        // as an extra expired tile request
        tile.setExpiryData({
            expires: justNow
        });
        expect(tile.getExpiryTimeout()).toBe(1000);

        tile.setExpiryData({
            expires: justNow
        });
        expect(tile.getExpiryTimeout()).toBe(2000);
        tile.setExpiryData({
            expires: justNow
        });
        expect(tile.getExpiryTimeout()).toBe(4000);

        tile.setExpiryData({
            expires: justNow
        });
        expect(tile.getExpiryTimeout()).toBe(8000);

    });

});

describe('rtl text detection', () => {
    test('Tile.hasRTLText is true when a tile loads a symbol bucket with rtl text', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 1, 1), undefined);
        // Create a stub symbol bucket
        const symbolBucket = createSymbolBucket('test', 'Test', 'test', new CollisionBoxArray());
        // symbolBucket has not been populated yet so we force override the value in the stub
        symbolBucket.hasRTLText = true;
        tile.loadVectorData(
            createVectorData({rawTileData: createRawTileData(), buckets: [symbolBucket]}),
            createPainter({
                getLayer() {
                    return symbolBucket.layers[0];
                }
            })
        );

        expect(tile.hasRTLText).toBeTruthy();
    });

});

describe('setFeatureState', () => {
    const signedMltId = -1814668313;
    const bucketCases = [
        {
            name: 'line',
            layer: () => createFeatureStateLineLayer(),
            bucket: (layer: LineStyleLayer) => new ColumnarLineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>),
            featureTable: (id: number | null) => createSyntheticLineFeatureTable(syntheticLineFeatures().slice(0, 1).map(feature => ({...feature, id}))),
            sourceLayerId: syntheticLineLayer,
            stateProperty: 'width',
        },
        {
            name: 'fill',
            layer: () => createFeatureStateFillLayer(),
            bucket: (layer: FillStyleLayer) => new ColumnarFillBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<FillStyleLayer>),
            featureTable: (id: number | null) => createSyntheticPolygonFeatureTable(syntheticPolygonFeatures().slice(0, 1).map(feature => ({...feature, id}))),
            sourceLayerId: syntheticPolygonLayer,
            stateProperty: 'opacity',
        },
        {
            name: 'circle',
            layer: () => createFeatureStateCircleLayer(),
            bucket: (layer: CircleStyleLayer) => new ColumnarCircleBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<CircleStyleLayer>),
            featureTable: (id: number | null) => createSyntheticPointFeatureTable(syntheticPointFeatures().slice(0, 1).map(feature => ({...feature, id}))),
            sourceLayerId: syntheticPointLayer,
            stateProperty: 'radius',
        },
        {
            name: 'fill-extrusion',
            layer: () => createFeatureStateFillExtrusionLayer(),
            bucket: (layer: FillExtrusionStyleLayer) => new ColumnarFillExtrusionBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<FillExtrusionStyleLayer>),
            featureTable: (id: number | null) => createSyntheticPolygonFeatureTable(syntheticPolygonFeatures().slice(0, 1).map(feature => ({...feature, id}))),
            sourceLayerId: syntheticPolygonLayer,
            stateProperty: 'height',
        },
    ];
    const idCases = [
        {idCase: 'numeric id', rawId: 7, stateId: '7'},
        {idCase: 'missing id', rawId: null, stateId: '0'},
        {idCase: 'signed MLT id', rawId: signedMltId, stateId: String(normalizeMltFeatureId(signedMltId))},
    ];

    test('skips bucket updates when revision has already been processed', () => {
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 1, 1), undefined);
        tile.loadVectorData(
            createVectorData({rawTileData: createRawTileData()}),
            createPainter()
        );

        const loadVTLayersSpy = vi.spyOn(tile.latestFeatureIndex, 'loadVTLayers');
        const states = {road: [{id: '1', state: {hover: true}}]};
        const painter = createPainter({
            hasLayer: () => true,
            getLayer: () => ({queryRadius: () => 0}),
        });

        // Simulate that revision 5 was already processed
        tile.featureStateRevision = 5;

        // Calling with the same revision should not trigger any work
        tile.setFeatureState(states, painter, 5);
        expect(loadVTLayersSpy).not.toHaveBeenCalled();
    });

    test.each(bucketCases.flatMap((bucketCase) => idCases.map((idCase) => ({...bucketCase, ...idCase}))))('updates transferred $name columnar MLT paint arrays with $idCase without materializing vector tile features', ({layer, bucket, featureTable, sourceLayerId, stateProperty, rawId, stateId}) => {
        const styleLayer = layer();
        const columnarBucket = bucket(styleLayer as any);
        const table = featureTable(rawId);
        const featureIndex = new FeatureIndex(new OverscaledTileID(1, 0, 1, 1, 1));
        featureIndex.vtLayers = MLTVectorTile.fromFeatureTables([table]).layers;
        const sourceLayer = featureIndex.vtLayers[sourceLayerId];
        const materializeFeature = vi.spyOn(sourceLayer, 'feature').mockImplementation(() => {
            throw new Error('Unexpected vector tile feature materialization');
        });

        columnarBucket.populate(table, createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
        const transferredBucket = deserialize(serialize(columnarBucket)) as typeof columnarBucket;
        expect(transferredBucket.programConfigurations._featureMap.indexed).toBe(true);
        expect(transferredBucket.programConfigurations.columnarFeatureStateData.propertyNames).toEqual([stateProperty]);
        transferredBucket.programConfigurations.needsUpload = false;

        const tile = new Tile(new OverscaledTileID(1, 0, 1, 1, 1), undefined);
        tile.loadVectorData(
            createVectorData({
                buckets: [transferredBucket],
                encoding: 'mlt',
                featureIndex,
                rawTileData: new ArrayBuffer(0),
            }),
            createPainter({
                getLayer: (id) => id === styleLayer.id ? styleLayer : undefined,
            })
        );
        const loadVTLayers = vi.spyOn(tile.latestFeatureIndex, 'loadVTLayers');

        tile.setFeatureState(
            {[sourceLayerId]: [{id: stateId, state: {wide: true}}]},
            createPainter({
                hasLayer: (id) => id === styleLayer.id,
                getLayer: (id) => id === styleLayer.id ? styleLayer : undefined,
            }),
            6
        );

        expect(materializeFeature).not.toHaveBeenCalled();
        expect(loadVTLayers).not.toHaveBeenCalled();
        expect(transferredBucket.programConfigurations.needsUpload).toBe(true);
    });

    test('uses transferred promoteId mapping and only state-dependent columns', () => {
        const styleLayer = createFeatureStateCircleLayer();
        const bucket = new ColumnarCircleBucket({layers: [styleLayer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<CircleStyleLayer>);
        const baseTable = createSyntheticPointFeatureTable(syntheticPointFeatures().slice(0, 1));
        const table = new FeatureTable(
            baseTable.name,
            baseTable.geometryVector,
            baseTable.idVector,
            [...(baseTable.propertyVectors ?? []), createStringFlatVector(['feature-a'], 'promoted')],
            baseTable.extent,
        );
        const populateOptions = createPopulateOptions([]);
        populateOptions.featureIndex.promoteId = 'promoted';
        bucket.populate(table, populateOptions, new CanonicalTileID(0, 0, 0));

        const transferredBucket = deserialize(serialize(bucket)) as ColumnarCircleBucket;
        const stateData = transferredBucket.programConfigurations.columnarFeatureStateData;
        expect(stateData.ids).toEqual(['feature-a']);
        expect(stateData.propertyNames).toEqual(['radius']);
        transferredBucket.programConfigurations.needsUpload = false;

        const featureIndex = new FeatureIndex(new OverscaledTileID(1, 0, 1, 1, 1), 'promoted');
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 1, 1), undefined);
        tile.loadVectorData(
            createVectorData({
                buckets: [transferredBucket],
                encoding: 'mlt',
                featureIndex,
                rawTileData: new ArrayBuffer(1),
            }),
            createPainter({getLayer: (id) => id === styleLayer.id ? styleLayer : undefined}),
        );
        const loadVTLayers = vi.spyOn(tile.latestFeatureIndex, 'loadVTLayers');

        tile.setFeatureState(
            {[syntheticPointLayer]: [{id: 'feature-a', state: {wide: true}}]},
            createPainter({
                hasLayer: (id) => id === styleLayer.id,
                getLayer: (id) => id === styleLayer.id ? styleLayer : undefined,
            }),
            8,
        );

        expect(loadVTLayers).not.toHaveBeenCalled();
        expect(transferredBucket.programConfigurations.needsUpload).toBe(true);
    });

    test('updates transferred symbol columnar MLT paint arrays after worker parse without materializing vector tile features', async () => {
        const layerSpecification = {
            id: 'symbol-feature-state',
            source: 'source',
            'source-layer': syntheticPointLayer,
            type: 'symbol',
            layout: {
                'text-field': ['get', 'label'],
                'text-font': ['literal', ['Test']],
                'text-size': 16,
                'text-allow-overlap': true,
                'text-ignore-placement': true,
            },
            paint: {
                'text-opacity': ['case', ['boolean', ['feature-state', 'active'], false], ['/', ['get', 'radius'], 12], 0.1]
            }
        } as any;
        const styleLayer = new SymbolStyleLayer(layerSpecification, {});
        styleLayer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
        const mltTile = createSyntheticMltTile();
        const sourceLayer = mltTile.layers[syntheticPointLayer];
        const materializeFeature = vi.spyOn(sourceLayer, 'feature').mockImplementation(() => {
            throw new Error('Unexpected vector tile feature materialization');
        });

        const parsed = await createMltWorkerTile().parse(
            mltTile,
            new StyleLayerIndex([layerSpecification]),
            [],
            createGlyphActor(),
            SubdivisionGranularitySetting.noSubdivision
        );
        expect(materializeFeature).not.toHaveBeenCalled();
        expect(parsed.buckets).toHaveLength(1);

        const transferredBuckets = deserialize(serialize(parsed.buckets)) as typeof parsed.buckets;
        const transferredFeatureIndex = deserialize(serialize(parsed.featureIndex)) as FeatureIndex;
        transferredFeatureIndex.vtLayers = mltTile.layers;
        const tile = new Tile(new OverscaledTileID(1, 0, 1, 1, 1), undefined);
        tile.loadVectorData(
            createVectorData({
                buckets: transferredBuckets,
                collisionBoxArray: deserialize(serialize(parsed.collisionBoxArray)),
                encoding: 'mlt',
                featureIndex: transferredFeatureIndex,
                rawTileData: new ArrayBuffer(1),
            }),
            createPainter({
                getLayer: (id) => id === styleLayer.id ? styleLayer : undefined,
            })
        );

        const transferredBucket = tile.buckets[styleLayer.id] as SymbolBucket;
        expect(transferredBucket.text.programConfigurations.columnarFeatureStateData.propertyNames).toEqual(['radius']);
        expect(transferredBucket.icon.programConfigurations.columnarFeatureStateData).toBeUndefined();
        const beforePaint = textPaintBytes(transferredBucket, styleLayer.id, 'text-opacity');
        expect(beforePaint.length).toBeGreaterThan(0);
        transferredBucket.text.programConfigurations.needsUpload = false;
        const loadVTLayers = vi.spyOn(tile.latestFeatureIndex, 'loadVTLayers');

        tile.setFeatureState(
            {
                [syntheticPointLayer]: [
                    {id: '31', state: {active: true}},
                    {id: '1', state: {active: true}},
                    {id: String(normalizeMltFeatureId(signedMltFeatureId)), state: {active: true}},
                ]
            },
            createPainter({
                hasLayer: (id) => id === styleLayer.id,
                getLayer: (id) => id === styleLayer.id ? styleLayer : undefined,
            }),
            7
        );

        expect(materializeFeature).not.toHaveBeenCalled();
        expect(loadVTLayers).not.toHaveBeenCalled();
        expect(textPaintBytes(transferredBucket, styleLayer.id, 'text-opacity')).not.toEqual(beforePaint);
        expect(transferredBucket.text.programConfigurations.needsUpload).toBe(true);
    });
});

function createFeatureStateLineLayer(): LineStyleLayer {
    const layer = new LineStyleLayer({
        id: 'line-feature-state',
        source: 'source',
        'source-layer': syntheticLineLayer,
        type: 'line',
        paint: {
            'line-width': ['case', ['boolean', ['feature-state', 'wide'], false], ['get', 'width'], 1]
        }
    } as any, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

function createFeatureStateFillLayer(): FillStyleLayer {
    const layer = new FillStyleLayer({
        id: 'fill-feature-state',
        source: 'source',
        'source-layer': syntheticPolygonLayer,
        type: 'fill',
        paint: {
            'fill-opacity': ['case', ['boolean', ['feature-state', 'wide'], false], ['get', 'opacity'], 1]
        }
    } as any, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

function createFeatureStateCircleLayer(): CircleStyleLayer {
    const layer = new CircleStyleLayer({
        id: 'circle-feature-state',
        source: 'source',
        'source-layer': syntheticPointLayer,
        type: 'circle',
        paint: {
            'circle-radius': ['case', ['boolean', ['feature-state', 'wide'], false], ['get', 'radius'], 1]
        }
    } as any, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

function createFeatureStateFillExtrusionLayer(): FillExtrusionStyleLayer {
    const layer = new FillExtrusionStyleLayer({
        id: 'fill-extrusion-feature-state',
        source: 'source',
        'source-layer': syntheticPolygonLayer,
        type: 'fill-extrusion',
        paint: {
            'fill-extrusion-height': ['case', ['boolean', ['feature-state', 'wide'], false], ['get', 'height'], 1]
        }
    } as any, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

function createRawTileData() {
    return fs.readFileSync(path.join(__dirname, '../../test/unit/assets/mbsv5-6-18-23.vector.pbf'));
}

function createVectorData(options?) {
    const collisionBoxArray = new CollisionBoxArray();
    return extend({
        collisionBoxArray: deserialize(serialize(collisionBoxArray)),
        featureIndex: deserialize(serialize(new FeatureIndex(new OverscaledTileID(1, 0, 1, 1, 1)))),
        buckets: []
    }, options);
}

function createPainter(styleStub = {}): Painter {
    return {style: styleStub} as unknown as Painter;
}

function createMltWorkerTile(): WorkerTile {
    return new WorkerTile({
        uid: '',
        zoom: 0,
        maxZoom: 20,
        tileSize: 512,
        source: 'source',
        tileID: new OverscaledTileID(1, 0, 1, 1, 1),
        overscaling: 1,
        encoding: 'mlt'
    } as any as WorkerTileParameters);
}

function createGlyphActor() {
    return {
        sendAsync: vi.fn(({type: messageType, data}: any) => {
            if (messageType !== MessageType.getGlyphs) {
                return Promise.resolve({});
            }

            const glyphMap = {};
            for (const glyph of data.stacks.Test) {
                glyphMap[glyph] = {
                    id: glyph.codePointAt(0),
                    bitmap: new AlphaImage({width: 1, height: 1}, new Uint8Array([255])),
                    metrics: {width: 1, height: 1, left: 0, top: 0, advance: 1},
                };
            }
            return Promise.resolve({Test: glyphMap});
        })
    };
}

function structArrayBytes(array: {arrayBuffer: ArrayBuffer; length: number; bytesPerElement: number}): number[] {
    return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}

function textPaintBytes(bucket: SymbolBucket, layerId: string, property: string): number[] {
    const binder = bucket.text.programConfigurations.get(layerId).binders[property] as any;
    return structArrayBytes(binder.paintVertexArray);
}
