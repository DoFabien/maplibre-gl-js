import {describe, expect, test, vi} from 'vitest';
import {WorkerTile} from './worker_tile';
import {OverscaledTileID} from '../tile/tile_id';
import {Tile} from '../tile/tile';
import {StyleLayerIndex} from '../style/style_layer_index';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings';
import {FeatureIndex} from '../data/feature_index';
import {DictionaryCoder} from '../util/dictionary_coder';
import {MercatorTransform} from '../geo/projection/mercator_transform';
import Point from '@mapbox/point-geometry';
import {AlphaImage, RGBAImage} from '../util/image';
import {MessageType} from '../util/actor_messages';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../util/mlt_materialization_stats';
import {
    createSyntheticLegacyTile,
    createSyntheticMltTile,
    getSyntheticFeatureRows,
    signedMltFeatureId,
    syntheticLineLayer,
    syntheticPointLayer,
    syntheticPolygonLayer,
} from '../../test/unit/lib/mlt_synthetic';

import type {WorkerTileParameters} from './worker_source';
import type {VectorTileLike} from '@maplibre/vt-pbf';
import type {StyleImage} from '../style/style_image';

type LayerType = 'line' | 'fill' | 'circle' | 'fill-extrusion' | 'symbol';

type ParityCase = {
    label: string;
    type: LayerType;
    sourceLayer: string;
    filter: any;
    layout?: Record<string, any>;
    paint?: Record<string, any>;
};

function createWorkerTile(encoding: 'mvt' | 'mlt'): WorkerTile {
    return new WorkerTile({
        uid: '',
        zoom: 0,
        maxZoom: 20,
        tileSize: 512,
        source: 'source',
        tileID: new OverscaledTileID(1, 0, 1, 1, 1),
        overscaling: 1,
        encoding
    } as any as WorkerTileParameters);
}

function createLayerSpec(testCase: ParityCase): any {
    return {
        id: `synthetic-${testCase.type}-${testCase.label}`,
        source: 'source',
        'source-layer': testCase.sourceLayer,
        type: testCase.type,
        filter: testCase.filter,
        layout: testCase.layout,
        paint: testCase.paint,
    };
}

function summarizeFeatureIndex(result: any): Array<{featureIndex: number; sourceLayerIndex: number; bucketIndex: number}> {
    return Array.from({length: result.featureIndex.featureIndexArray.length}, (_value, index) => {
        const item = result.featureIndex.featureIndexArray.get(index);
        return {
            featureIndex: item.featureIndex,
            sourceLayerIndex: item.sourceLayerIndex,
            bucketIndex: item.bucketIndex,
        };
    });
}

function summarizeBuckets(result: any): Array<{type: string; empty: boolean}> {
    return result.buckets.map((bucket: any) => ({
        type: bucket.layers[0].type,
        empty: bucket.isEmpty(),
    }));
}

function structArrayBytes(array: {arrayBuffer: ArrayBuffer; length: number; bytesPerElement: number}): number[] {
    return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}

function paintBytes(bucket: any, property: string): number[] {
    const layerId = bucket.layers[0].id;
    const binder = bucket.programConfigurations.get(layerId).binders[property];
    return structArrayBytes(binder.paintVertexArray);
}

function expectBucketParity(mvtBucket: any, mltBucket: any, type: LayerType): void {
    if (type === 'line') {
        expect(structArrayBytes(mltBucket.layoutVertexArray)).toEqual(structArrayBytes(mvtBucket.layoutVertexArray));
        expect(structArrayBytes(mltBucket.indexArray)).toEqual(structArrayBytes(mvtBucket.indexArray));
        expect(mltBucket.lineClipsArray).toEqual(mvtBucket.lineClipsArray);
        expect(paintBytes(mltBucket, 'line-width')).toEqual(paintBytes(mvtBucket, 'line-width'));
    } else if (type === 'circle') {
        expect(structArrayBytes(mltBucket.layoutVertexArray)).toEqual(structArrayBytes(mvtBucket.layoutVertexArray));
        expect(structArrayBytes(mltBucket.indexArray)).toEqual(structArrayBytes(mvtBucket.indexArray));
        expect(mltBucket.segments.get()).toEqual(mvtBucket.segments.get());
        expect(paintBytes(mltBucket, 'circle-radius')).toEqual(paintBytes(mvtBucket, 'circle-radius'));
    } else if (type === 'fill') {
        expect(mltBucket.layoutVertexArray).toHaveLength(mvtBucket.layoutVertexArray.length);
        expect(mltBucket.indexArray.length).toBeGreaterThan(0);
        expect(mvtBucket.indexArray.length).toBeGreaterThan(0);
        expect(mltBucket.indexArray2.length).toBeGreaterThan(0);
        expect(mvtBucket.indexArray2.length).toBeGreaterThan(0);
        expect(paintBytes(mltBucket, 'fill-opacity')).toEqual(paintBytes(mvtBucket, 'fill-opacity'));
    } else {
        expect(mltBucket.layoutVertexArray).toHaveLength(mvtBucket.layoutVertexArray.length);
        expect(mltBucket.centroidVertexArray).toHaveLength(mvtBucket.centroidVertexArray.length);
        expect(mltBucket.indexArray.length).toBeGreaterThan(0);
        expect(mvtBucket.indexArray.length).toBeGreaterThan(0);
        expect(mltBucket.segments.get()).toHaveLength(mvtBucket.segments.get().length);
        expect(paintBytes(mltBucket, 'fill-extrusion-height')).toEqual(paintBytes(mvtBucket, 'fill-extrusion-height'));
    }
}

function syntheticImages(): Record<string, StyleImage> {
    const images: Record<string, StyleImage> = {};
    for (const name of ['marker', 'star', 'dot', 'stripe', 'grid', 'cross']) {
        images[name] = {
            data: new RGBAImage({width: 16, height: 16}, new Uint8Array(16 * 16 * 4).fill(255)),
            pixelRatio: 1,
            sdf: false,
        };
    }
    return images;
}

function createSyntheticActor() {
    const images = syntheticImages();
    return {
        sendAsync: vi.fn(({type: messageType, data}: any) => {
            if (messageType === MessageType.getGlyphs) {
                const glyphMap = {};
                for (let id = 32; id < 128; id++) {
                    glyphMap[id] = {
                        id,
                        bitmap: new AlphaImage({width: 1, height: 1}, new Uint8Array([255])),
                        metrics: {width: 1, height: 1, left: 0, top: 0, advance: 1},
                    };
                }
                return Promise.resolve({Test: glyphMap});
            }
            if (messageType === MessageType.getImages) {
                const response: Record<string, StyleImage> = {};
                for (const icon of data.icons) {
                    response[icon] = images[icon];
                }
                return Promise.resolve(response);
            }
            if (messageType === MessageType.getDashes) {
                return Promise.resolve(Object.fromEntries(
                    Object.keys(data.dashes).map((dashId) => [dashId, {y: 0, height: 16, width: 256}])
                ));
            }
            return Promise.resolve({});
        })
    };
}

async function parseSyntheticTileWithData(encoding: 'mvt' | 'mlt', layerSpec: any): Promise<{result: any; data: VectorTileLike; actor: ReturnType<typeof createSyntheticActor>}> {
    const data: VectorTileLike = encoding === 'mvt'
        ? createSyntheticLegacyTile()
        : createSyntheticMltTile();
    let materializeFeature: ReturnType<typeof vi.spyOn> | undefined;

    if (encoding === 'mlt') {
        const sourceLayer = data.layers[layerSpec['source-layer']];
        materializeFeature = vi.spyOn(sourceLayer, 'feature').mockImplementation(() => {
            throw new Error('MLT parity test should stay on the columnar path');
        });
    }

    const actor = createSyntheticActor();
    const result = await createWorkerTile(encoding).parse(
        data,
        new StyleLayerIndex([layerSpec]),
        ['marker', 'star', 'dot', 'stripe', 'grid', 'cross'],
        actor,
        SubdivisionGranularitySetting.noSubdivision
    );
    materializeFeature?.mockRestore();
    return {result, data, actor};
}

async function parseSyntheticTile(encoding: 'mvt' | 'mlt', layerSpec: any): Promise<any> {
    return (await parseSyntheticTileWithData(encoding, layerSpec)).result;
}

function summarizeSymbolFeatures(bucket: any) {
    return bucket.features.map((feature: any) => ({
        index: feature.index,
        text: feature.text ? feature.text.toString() : null,
        icon: feature.icon?.name ?? null,
        sortKey: feature.sortKey,
        type: feature.type,
    }));
}

function createQueryableFeatureIndex(parsed: {result: any; data: VectorTileLike}, encoding: 'mvt' | 'mlt'): FeatureIndex {
    const featureIndex = parsed.result.featureIndex as FeatureIndex;
    featureIndex.encoding = encoding;
    featureIndex.rawTileData = new ArrayBuffer(0);
    featureIndex.vtLayers = parsed.data.layers;
    featureIndex.sourceLayerCoder = new DictionaryCoder(Object.keys(parsed.data.layers).sort());
    return featureIndex;
}

function queryParsedResult(parsed: {result: any; data: VectorTileLike}, encoding: 'mvt' | 'mlt', layerSpec: any, filter: any) {
    const featureIndex = createQueryableFeatureIndex(parsed, encoding);
    const layerIndex = new StyleLayerIndex([layerSpec]);
    const layer = layerIndex.familiesBySource.source[layerSpec['source-layer']][0][0] as any;
    layer.queryIntersectsFeature = vi.fn(() => true);
    const transform = new MercatorTransform();
    transform.resize(512, 512);

    return featureIndex.query({
        queryPadding: 0,
        tileSize: 512,
        scale: 1,
        queryGeometry: [new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096), new Point(0, 0)],
        cameraQueryGeometry: [new Point(0, 0), new Point(4096, 0), new Point(4096, 4096), new Point(0, 4096), new Point(0, 0)],
        params: {filter},
        transform
    } as any, {
        [layer.id]: layer,
    }, {
        [layer.id]: layerSpec
    }, undefined);
}

function summarizeQueryResults(results: any, layerId: string) {
    return (results[layerId] ?? []).map((item: any) => ({
        featureIndex: item.featureIndex,
        id: item.feature.id,
        properties: item.feature.properties,
        geometry: item.feature.geometry,
    }));
}

function createTileForSourceFeatureQuery(data: VectorTileLike, encoding: 'mvt' | 'mlt', promoteId?: string): Tile {
    const tile = new Tile(new OverscaledTileID(1, 0, 1, 1, 1), 512);
    const featureIndex = new FeatureIndex(tile.tileID, promoteId);
    featureIndex.encoding = encoding;
    featureIndex.rawTileData = new ArrayBuffer(0);
    featureIndex.vtLayers = data.layers;
    featureIndex.sourceLayerCoder = new DictionaryCoder(Object.keys(data.layers).sort());
    (tile as any).latestFeatureIndex = featureIndex;
    return tile;
}

function summarizeSourceFeatures(features: any[]) {
    return features.map(feature => ({
        id: feature.id,
        properties: feature.properties,
        geometry: feature.geometry,
    }));
}

describe('WorkerTile synthetic MVT/MLT filter parity', () => {
    test('keeps synthetic MLT and legacy fixtures aligned by layer and row properties', () => {
        const legacyTile = createSyntheticLegacyTile();
        const mltTile = createSyntheticMltTile();
        const expectedRows = getSyntheticFeatureRows();
        const layerRows = {
            [syntheticLineLayer]: expectedRows.lines,
            [syntheticPolygonLayer]: expectedRows.polygons,
            [syntheticPointLayer]: expectedRows.points,
        };

        for (const [layerName, rows] of Object.entries(layerRows)) {
            const legacyLayer = legacyTile.layers[layerName];
            const mltLayer = mltTile.layers[layerName];

            expect(mltLayer).toHaveLength(legacyLayer.length);
            expect(mltLayer).toHaveLength(rows.length);

            for (let index = 0; index < rows.length; index++) {
                const legacyFeature = legacyLayer.feature(index);
                const mltFeature = mltLayer.feature(index);
                expect(mltFeature.type).toBe(legacyFeature.type);
                expect(mltFeature.properties).toEqual(legacyFeature.properties);
            }
        }
    });

    test.each([
        {
            label: 'line-kind-match',
            type: 'line',
            sourceLayer: syntheticLineLayer,
            filter: ['match', ['get', 'kind'], ['primary', 'secondary'], true, false],
            layout: {'line-sort-key': ['get', 'sort']},
            paint: {'line-width': ['get', 'width']}
        },
        {
            label: 'line-id-and-clip-props',
            type: 'line',
            sourceLayer: syntheticLineLayer,
            filter: ['all', ['==', ['id'], signedMltFeatureId], ['>', ['get', 'mapbox_clip_start'], 0.2]],
            paint: {'line-width': ['get', 'width']}
        },
        {
            label: 'line-missing-id',
            type: 'line',
            sourceLayer: syntheticLineLayer,
            filter: ['!has', '$id'],
            paint: {'line-width': ['get', 'width']}
        },
        {
            label: 'fill-height-and-kind',
            type: 'fill',
            sourceLayer: syntheticPolygonLayer,
            filter: ['all', ['>=', ['get', 'height'], 10], ['!=', ['get', 'kind'], 'outside']],
            layout: {'fill-sort-key': ['get', 'sort']},
            paint: {'fill-opacity': ['get', 'opacity']}
        },
        {
            label: 'fill-pattern-property',
            type: 'fill',
            sourceLayer: syntheticPolygonLayer,
            filter: ['==', ['get', 'pattern'], 'grid'],
            paint: {'fill-opacity': ['get', 'opacity']}
        },
        {
            label: 'fill-missing-id',
            type: 'fill',
            sourceLayer: syntheticPolygonLayer,
            filter: ['!has', '$id'],
            paint: {'fill-opacity': ['get', 'opacity']}
        },
        {
            label: 'circle-category-and-radius',
            type: 'circle',
            sourceLayer: syntheticPointLayer,
            filter: ['all', ['==', ['get', 'category'], 'poi'], ['>', ['get', 'radius'], 5]],
            layout: {'circle-sort-key': ['get', 'sort']},
            paint: {'circle-radius': ['get', 'radius']}
        },
        {
            label: 'circle-string-expression',
            type: 'circle',
            sourceLayer: syntheticPointLayer,
            filter: ['==', ['slice', ['upcase', ['get', 'label']], 0, 1], 'G'],
            paint: {'circle-radius': ['get', 'radius']}
        },
        {
            label: 'circle-missing-id',
            type: 'circle',
            sourceLayer: syntheticPointLayer,
            filter: ['!has', '$id'],
            paint: {'circle-radius': ['get', 'radius']}
        },
        {
            label: 'fill-extrusion-height-base',
            type: 'fill-extrusion',
            sourceLayer: syntheticPolygonLayer,
            filter: ['all', ['>=', ['get', 'height'], 6], ['>=', ['get', 'base'], 2]],
            paint: {
                'fill-extrusion-height': ['get', 'height'],
                'fill-extrusion-base': ['get', 'base']
            }
        },
        {
            label: 'fill-extrusion-geometry-type',
            type: 'fill-extrusion',
            sourceLayer: syntheticPolygonLayer,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: {'fill-extrusion-height': ['get', 'height']}
        },
    ] as ParityCase[])('matches MVT worker selection for $label', async (testCase) => {
        const layerSpec = createLayerSpec(testCase);
        const mvtResult = await parseSyntheticTile('mvt', layerSpec);
        const mltResult = await parseSyntheticTile('mlt', layerSpec);

        expect(summarizeFeatureIndex(mltResult)).toEqual(summarizeFeatureIndex(mvtResult));
        expect(summarizeBuckets(mltResult)).toEqual(summarizeBuckets(mvtResult));
    });

    test.each([
        {
            label: 'line-bucket',
            type: 'line',
            sourceLayer: syntheticLineLayer,
            filter: ['==', ['get', 'kind'], 'primary'],
            layout: {'line-sort-key': ['get', 'sort']},
            paint: {'line-width': ['get', 'width']}
        },
        {
            label: 'fill-bucket',
            type: 'fill',
            sourceLayer: syntheticPolygonLayer,
            filter: ['!=', ['get', 'kind'], 'outside'],
            layout: {'fill-sort-key': ['get', 'sort']},
            paint: {'fill-opacity': ['get', 'opacity']}
        },
        {
            label: 'circle-bucket',
            type: 'circle',
            sourceLayer: syntheticPointLayer,
            filter: ['!=', ['get', 'category'], 'hidden'],
            layout: {'circle-sort-key': ['get', 'sort']},
            paint: {'circle-radius': ['get', 'radius']}
        },
        {
            label: 'fill-extrusion-bucket',
            type: 'fill-extrusion',
            sourceLayer: syntheticPolygonLayer,
            filter: ['>=', ['get', 'height'], 6],
            paint: {
                'fill-extrusion-height': ['get', 'height'],
                'fill-extrusion-base': ['get', 'base']
            }
        },
    ] as ParityCase[])('matches MVT bucket output for $label', async (testCase) => {
        const layerSpec = createLayerSpec(testCase);
        const mvtResult = await parseSyntheticTile('mvt', layerSpec);
        const mltResult = await parseSyntheticTile('mlt', layerSpec);

        expectBucketParity(mvtResult.buckets[0], mltResult.buckets[0], testCase.type);
    });

    test.each([
        {
            label: 'line-pattern',
            type: 'line',
            sourceLayer: syntheticLineLayer,
            filter: ['!=', ['get', 'kind'], 'service'],
            paint: {'line-pattern': ['get', 'pattern'], 'line-width': ['get', 'width']}
        },
        {
            label: 'line-dasharray',
            type: 'line',
            sourceLayer: syntheticLineLayer,
            filter: ['>=', ['get', 'rank'], 1],
            paint: {
                'line-dasharray': ['case', ['==', ['get', 'dash'], 1], ['literal', [2, 1]], ['literal', [1, 2]]],
                'line-width': ['get', 'width']
            }
        },
        {
            label: 'line-gradient',
            type: 'line',
            sourceLayer: syntheticLineLayer,
            filter: ['==', ['get', 'kind'], 'primary'],
            paint: {
                'line-width': ['get', 'width'],
                'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#000000', 1, '#ffffff']
            }
        },
        {
            label: 'fill-pattern',
            type: 'fill',
            sourceLayer: syntheticPolygonLayer,
            filter: ['!=', ['get', 'kind'], 'outside'],
            paint: {'fill-pattern': ['get', 'pattern'], 'fill-opacity': ['/', ['get', 'opacity'], 10]}
        },
        {
            label: 'fill-extrusion-pattern',
            type: 'fill-extrusion',
            sourceLayer: syntheticPolygonLayer,
            filter: ['>=', ['get', 'height'], 6],
            paint: {'fill-extrusion-pattern': ['get', 'pattern'], 'fill-extrusion-height': ['get', 'height']}
        },
        {
            label: 'feature-state-paint',
            type: 'circle',
            sourceLayer: syntheticPointLayer,
            filter: ['!=', ['get', 'category'], 'hidden'],
            paint: {'circle-radius': ['case', ['boolean', ['feature-state', 'active'], false], ['get', 'radius'], 3]}
        },
    ] as ParityCase[])('keeps complex columnar path without MLT feature materialization for $label', async (testCase) => {
        const layerSpec = createLayerSpec(testCase);
        const parsed = await parseSyntheticTileWithData('mlt', layerSpec);

        expect(parsed.result.buckets).toHaveLength(1);
        expect(parsed.result.buckets[0].isEmpty()).toBe(false);
    });

    test.each([
        {
            label: 'feature-state-filter',
            type: 'line',
            sourceLayer: syntheticLineLayer,
            filter: ['case', ['==', ['feature-state', 'rank'], null], true, false],
            paint: {'line-width': ['get', 'width']},
            reason: /feature-state expressions/,
        },
        {
            label: 'mixed-legacy-and-expression-filter',
            type: 'line',
            sourceLayer: syntheticLineLayer,
            filter: ['all', ['==', 'kind', 'primary'], ['==', ['get', 'rank'], 1]],
            paint: {'line-width': ['get', 'width']},
            reason: /not both/,
        },
    ] as Array<ParityCase & {reason: RegExp}>)('rejects unsupported $label before MLT materialization', async (testCase) => {
        const layerSpec = createLayerSpec(testCase);

        await expect(parseSyntheticTile('mlt', layerSpec)).rejects.toThrow(testCase.reason);
    });

    test('matches MVT symbol dependencies and feature ordering without MLT materialization', async () => {
        const layerSpec = createLayerSpec({
            label: 'symbol-labels-icons',
            type: 'symbol',
            sourceLayer: syntheticPointLayer,
            filter: ['!=', ['get', 'category'], 'hidden'],
            layout: {
                'text-field': ['get', 'label'],
                'text-font': ['literal', ['Test']],
                'text-size': 12,
                'icon-image': ['get', 'icon'],
                'icon-allow-overlap': true,
                'text-allow-overlap': true,
                'symbol-sort-key': ['get', 'sort']
            }
        });
        const mvtParsed = await parseSyntheticTileWithData('mvt', layerSpec);
        const mltParsed = await parseSyntheticTileWithData('mlt', layerSpec);

        expect(summarizeSymbolFeatures(mltParsed.result.buckets[0])).toEqual(summarizeSymbolFeatures(mvtParsed.result.buckets[0]));
        expect(mltParsed.actor.sendAsync.mock.calls.map(([message]) => message.type))
            .toEqual(mvtParsed.actor.sendAsync.mock.calls.map(([message]) => message.type));
    });

    test('matches MVT within filtering without MLT materialization', async () => {
        const layerSpec = createLayerSpec({
            label: 'within-filter',
            type: 'circle',
            sourceLayer: syntheticPointLayer,
            filter: ['within', {type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]]}],
            paint: {'circle-radius': ['get', 'radius']},
        });

        const mvtResult = await parseSyntheticTile('mvt', layerSpec);
        const mltResult = await parseSyntheticTile('mlt', layerSpec);

        expect(summarizeFeatureIndex(mltResult)).toEqual(summarizeFeatureIndex(mvtResult));
        expect(summarizeBuckets(mltResult)).toEqual(summarizeBuckets(mvtResult));
    });

    test.each([
        {
            label: 'global-state-non-primitive',
            type: 'line',
            sourceLayer: syntheticLineLayer,
            filter: ['==', ['get', 'rank'], ['global-state', 'targetRank']],
            paint: {'line-width': ['get', 'width']},
            reason: /primitive/,
            globalState: {targetRank: [1]},
        },
    ] as Array<ParityCase & {reason: RegExp; globalState?: Record<string, unknown>}>)('rejects broader unsupported filters: $label', async (testCase) => {
        const layerSpec = createLayerSpec(testCase);
        const layerIndex = new StyleLayerIndex([layerSpec], testCase.globalState);
        const mltData = createSyntheticMltTile();
        const sourceLayer = mltData.layers[testCase.sourceLayer];
        const materializeFeature = vi.spyOn(sourceLayer, 'feature');

        await expect(createWorkerTile('mlt').parse(
            mltData,
            layerIndex,
            ['marker', 'star'],
            createSyntheticActor(),
            SubdivisionGranularitySetting.noSubdivision
        )).rejects.toThrow(testCase.reason);

        expect(materializeFeature).not.toHaveBeenCalled();
    });

    test.each([
        {
            label: 'query-line',
            type: 'line',
            sourceLayer: syntheticLineLayer,
            filter: ['>=', ['get', 'rank'], 1],
            queryFilter: ['==', ['get', 'rank'], 1],
            layout: {'line-sort-key': ['get', 'sort']},
            paint: {'line-width': ['get', 'width']}
        },
        {
            label: 'query-fill',
            type: 'fill',
            sourceLayer: syntheticPolygonLayer,
            filter: ['!=', ['get', 'kind'], 'outside'],
            queryFilter: ['==', ['get', 'height'], 6],
            layout: {'fill-sort-key': ['get', 'sort']},
            paint: {'fill-opacity': ['get', 'opacity']}
        },
        {
            label: 'query-circle',
            type: 'circle',
            sourceLayer: syntheticPointLayer,
            filter: ['!=', ['get', 'category'], 'hidden'],
            queryFilter: ['==', ['get', 'label'], 'Alpha'],
            layout: {'circle-sort-key': ['get', 'sort']},
            paint: {'circle-radius': ['get', 'radius']}
        },
    ] as Array<ParityCase & {queryFilter: any}>)('matches MVT FeatureIndex query results after synthetic MLT parsing for $label', async (testCase) => {
        const layerSpec = createLayerSpec(testCase);
        const mvtParsed = await parseSyntheticTileWithData('mvt', layerSpec);
        const mltParsed = await parseSyntheticTileWithData('mlt', layerSpec);

        expect(summarizeQueryResults(queryParsedResult(mltParsed, 'mlt', layerSpec, testCase.queryFilter), layerSpec.id))
            .toEqual(summarizeQueryResults(queryParsedResult(mvtParsed, 'mvt', layerSpec, testCase.queryFilter), layerSpec.id));
    });

    test.each([
        {
            label: 'line-id-and-geometry',
            sourceLayer: syntheticLineLayer,
            filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['id'], 11]],
        },
        {
            label: 'fill-id-and-geometry',
            sourceLayer: syntheticPolygonLayer,
            filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['id'], 21]],
        },
        {
            label: 'circle-id-and-geometry',
            sourceLayer: syntheticPointLayer,
            filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['id'], 31]],
        },
        {
            label: 'symbol-source-label',
            sourceLayer: syntheticPointLayer,
            filter: ['==', ['get', 'label'], 'Alpha'],
        },
    ] as Array<{label: string; sourceLayer: string; filter: any}>)('matches MVT querySourceFeatures results on synthetic MLT layers for $label', ({sourceLayer, filter}) => {
        const mvtData = createSyntheticLegacyTile();
        const mltData = createSyntheticMltTile();
        const mvtTile = createTileForSourceFeatureQuery(mvtData, 'mvt');
        const mltTile = createTileForSourceFeatureQuery(mltData, 'mlt');
        const mvtFeatures = [];
        const mltFeatures = [];

        mvtTile.querySourceFeatures(mvtFeatures, {sourceLayer, filter});
        mltTile.querySourceFeatures(mltFeatures, {sourceLayer, filter});

        expect(summarizeSourceFeatures(mltFeatures)).toEqual(summarizeSourceFeatures(mvtFeatures));
    });

    test('querySourceFeatures materializes only selected MLT output features', () => {
        const data = createSyntheticMltTile();
        const sourceLayer = data.layers[syntheticPointLayer];
        const feature = vi.spyOn(sourceLayer, 'feature');
        const tile = createTileForSourceFeatureQuery(data, 'mlt');
        const result = [];
        const stats = createMltMaterializationStats();
        const deactivate = activateMltMaterializationStats(stats);

        try {
            tile.querySourceFeatures(result, {
                sourceLayer: syntheticPointLayer,
                filter: ['==', ['get', 'label'], 'Alpha'],
            });
        } finally {
            deactivate();
        }

        expect(result).toHaveLength(1);
        expect(feature).not.toHaveBeenCalled();
        expect(stats.counters.queryCandidates).toBe(4);
        expect(stats.counters.queryResults).toBe(1);
        expect(stats.counters.vectorTileFeatureWrappers).toBe(0);
        expect(stats.counters.propertyObjects).toBe(0);
        expect(stats.counters.queryGeometriesLoaded).toBe(0);
        expect(stats.counters.geometryPartsMaterialized).toBe(0);
        expect(stats.counters.pointObjects).toBe(0);
    });

    test('querySourceFeatures keeps unsupported MLT filters wrapper-free until output', () => {
        const data = createSyntheticMltTile();
        const sourceLayer = data.layers[syntheticPointLayer];
        const feature = vi.spyOn(sourceLayer, 'feature');
        const tile = createTileForSourceFeatureQuery(data, 'mlt');
        const result = [];
        const stats = createMltMaterializationStats();
        const deactivate = activateMltMaterializationStats(stats);

        try {
            tile.querySourceFeatures(result, {
                sourceLayer: syntheticPointLayer,
                filter: ['==', ['at', 0, ['literal', ['Alpha']]], ['get', 'label']],
            });
        } finally {
            deactivate();
        }

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe(31);
        expect(feature).not.toHaveBeenCalled();
        expect(stats.counters.queryCandidates).toBe(4);
        expect(stats.counters.queryResults).toBe(1);
        expect(stats.counters.vectorTileFeatureWrappers).toBe(0);
        expect(stats.counters.geometryPartsMaterialized).toBe(0);
        expect(stats.counters.pointObjects).toBe(0);
    });

    test('querySourceFeatures reads MLT promoteId without materializing properties', () => {
        const data = createSyntheticMltTile();
        const tile = createTileForSourceFeatureQuery(data, 'mlt', 'label');
        const result = [];
        const stats = createMltMaterializationStats();
        const deactivate = activateMltMaterializationStats(stats);

        try {
            tile.querySourceFeatures(result, {
                sourceLayer: syntheticPointLayer,
                filter: ['==', ['get', 'label'], 'Alpha'],
            });
        } finally {
            deactivate();
        }

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('Alpha');
        expect(stats.counters.vectorTileFeatureWrappers).toBe(0);
        expect(stats.counters.propertyObjects).toBe(0);
        expect(stats.counters.propertyProxyMisses).toBe(0);
    });

    test('keeps selected MLT output properties and geometry lazy until public access', () => {
        const data = createSyntheticMltTile();
        const tile = createTileForSourceFeatureQuery(data, 'mlt');
        const result = [];
        const stats = createMltMaterializationStats();
        const deactivate = activateMltMaterializationStats(stats);

        try {
            tile.querySourceFeatures(result, {
                sourceLayer: syntheticPointLayer,
                filter: ['==', ['get', 'label'], 'Alpha'],
            });

            expect(result).toHaveLength(1);
            expect(result[0].id).toBe(31);
            expect(stats.counters.vectorTileFeatureWrappers).toBe(0);
            expect(stats.counters.propertyObjects).toBe(0);
            expect(stats.counters.geometryPartsMaterialized).toBe(0);
            expect(stats.counters.pointObjects).toBe(0);
            expect(Object.keys(result[0])).toContain('properties');

            expect(result[0].properties.label).toBe('Alpha');
            expect(stats.counters.propertyObjects).toBe(1);
            expect(stats.counters.geometryPartsMaterialized).toBe(0);
            expect(stats.counters.pointObjects).toBe(0);

            const geometry = result[0].geometry;
            expect(geometry.type).toBe('Point');
            expect(stats.counters.geometryPartsMaterialized).toBe(0);
            expect(stats.counters.pointObjects).toBe(0);

            const json = result[0].toJSON();
            expect(json.properties.label).toBe('Alpha');
            expect(json.geometry).toBe(geometry);
            expect(stats.counters.propertyObjects).toBe(1);
            expect(stats.counters.geometryPartsMaterialized).toBe(0);
            expect(stats.counters.pointObjects).toBe(0);
        } finally {
            deactivate();
        }
    });
});
