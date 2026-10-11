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
import {
    createSyntheticLegacyTile,
    createSyntheticMltTile,
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

function structArrayBytes(array: {arrayBuffer: ArrayBuffer; length: number; bytesPerElement: number}): number[] {
    return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}

function textColorBytes(bucket: any): number[] {
    const binder = bucket.text.programConfigurations.get(bucket.layers[0].id).binders['text-color'];
    return structArrayBytes(binder.paintVertexArray);
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
                    glyphMap[String.fromCharCode(id)] = {
                        id,
                        bitmap: new AlphaImage({width: 1, height: 1}, new Uint8Array([255])),
                        metrics: {width: 1, height: 1, left: 0, top: 0, advance: 1},
                    };
                }
                return Promise.resolve({Test: {default: glyphMap}});
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

    test.each([
        {name: 'plain', textField: ['get', 'label']},
        {name: 'formatted', textField: ['format', ['get', 'label'], {'font-scale': 1.2}, ' ', {}, ['get', 'category'], {}]},
    ])('matches MVT symbol dependencies, feature ordering and $name text paint without MLT materialization', async ({textField}) => {
        const layerSpec = createLayerSpec({
            label: 'symbol-labels-icons',
            type: 'symbol',
            sourceLayer: syntheticPointLayer,
            filter: ['!=', ['get', 'category'], 'hidden'],
            paint: {'text-color': ['case', ['==', ['get', 'category'], 'poi'], '#ff0000', '#0000ff']},
            layout: {
                'text-field': textField,
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
        expect(textColorBytes(mltParsed.result.buckets[0])).toEqual(textColorBytes(mvtParsed.result.buckets[0]));
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

    test('querySourceFeatures returns the MLT features its filter selects', () => {
        const data = createSyntheticMltTile();
        const tile = createTileForSourceFeatureQuery(data, 'mlt');
        const result = [];
        tile.querySourceFeatures(result, {
            sourceLayer: syntheticPointLayer,
            filter: ['==', ['get', 'label'], 'Alpha'],
        });

        expect(result).toHaveLength(1);
    });

    test('querySourceFeatures selects MLT rows with expressions evaluated row by row', () => {
        const data = createSyntheticMltTile();
        const tile = createTileForSourceFeatureQuery(data, 'mlt');
        const result = [];
        tile.querySourceFeatures(result, {
            sourceLayer: syntheticPointLayer,
            filter: ['==', ['at', 0, ['literal', ['Alpha']]], ['get', 'label']],
        });

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe(31);
    });

    test('querySourceFeatures reads MLT promoteId', () => {
        const data = createSyntheticMltTile();
        const tile = createTileForSourceFeatureQuery(data, 'mlt', 'label');
        const result = [];
        tile.querySourceFeatures(result, {
            sourceLayer: syntheticPointLayer,
            filter: ['==', ['get', 'label'], 'Alpha'],
        });

        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('Alpha');
    });

});
