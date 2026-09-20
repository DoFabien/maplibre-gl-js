import fs from 'fs';
import path from 'path';
import {describe, expect, test, vi} from 'vitest';
import {PbfReader} from 'pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {WorkerTile} from './worker_tile';
import {MLTVectorTile} from './vector_tile_mlt';
import {OverscaledTileID, CanonicalTileID} from '../tile/tile_id';
import {StyleLayerIndex} from '../style/style_layer_index';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings';
import {getFeaturesFromLayer, createPopulateOptions} from '../../test/unit/lib/tile';
import {CircleBucket} from '../data/bucket/circle_bucket';
import {FillBucket} from '../data/bucket/fill_bucket';
import {FillExtrusionBucket} from '../data/bucket/fill_extrusion_bucket';
import {LineBucket} from '../data/bucket/line_bucket';
import {SymbolBucket} from '../data/bucket/symbol_bucket';
import {CollisionBoxArray} from '../data/array_types.g';
import {CircleStyleLayer} from '../style/style_layer/circle_style_layer';
import {FillStyleLayer} from '../style/style_layer/fill_style_layer';
import {FillExtrusionStyleLayer} from '../style/style_layer/fill_extrusion_style_layer';
import {LineStyleLayer} from '../style/style_layer/line_style_layer';
import {SymbolStyleLayer} from '../style/style_layer/symbol_style_layer';
import {MessageType} from '../util/actor_messages';
import {AlphaImage} from '../util/image';

import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {BucketParameters} from '../data/bucket';
import type {EvaluationParameters} from '../style/evaluation_parameters';
import type {ZoomHistory} from '../style/zoom_history';
import type {WorkerTileParameters} from './worker_source';

type LayerType = 'fill' | 'line' | 'circle';

type RealTileCandidate = {
    label: string;
    tilePath: string;
    layerName: string;
    propertyName: string;
    sampleValue: string | number | boolean;
};

function createWorkerTile(): WorkerTile {
    return new WorkerTile({
        uid: '',
        zoom: 0,
        maxZoom: 20,
        tileSize: 512,
        source: 'source',
        tileID: new OverscaledTileID(0, 0, 0, 0, 0),
        overscaling: 1,
        encoding: 'mlt'
    } as any as WorkerTileParameters);
}

function candidateTilePaths(): string[] {
    return [
        path.join(__dirname, '../../test/integration/assets/tiles/mlt/5/17/10.mlt'),
        path.join(__dirname, '../../test/integration/assets/tiles/mlt/5/22/12.mlt'),
        path.join(__dirname, '../../test/integration/assets/tiles/mlt/14/8716/5685.mlt'),
        path.join(__dirname, '../../test/integration/assets/tiles/mlt/14/8717/5679.mlt'),
    ];
}

function convertedGlJsRoadTilePaths(): string[] {
    return [
        path.join(__dirname, '../../test/integration/assets/tiles/mlt/gl-js/14-8802-5374.mlt'),
        path.join(__dirname, '../../test/integration/assets/tiles/mlt/gl-js/14-8802-5375.mlt'),
        path.join(__dirname, '../../test/integration/assets/tiles/mlt/gl-js/14-8803-5374.mlt'),
        path.join(__dirname, '../../test/integration/assets/tiles/mlt/gl-js/14-8803-5375.mlt')
    ];
}

function convertedGlJsRoadTiles(): Array<{label: string; mltTilePath: string; mvtTilePath: string}> {
    return convertedGlJsRoadTilePaths().map((mltTilePath) => {
        const fileName = path.basename(mltTilePath, '.mlt');
        return {
            label: fileName,
            mltTilePath,
            mvtTilePath: path.join(__dirname, `../../test/integration/assets/tiles/${fileName}.mvt`)
        };
    });
}

function loadMltTile(tilePath: string): MLTVectorTile {
    const rawTile = fs.readFileSync(tilePath);
    return new MLTVectorTile(rawTile.buffer.slice(rawTile.byteOffset, rawTile.byteOffset + rawTile.byteLength));
}

function loadMvtTile(tilePath: string): VectorTile {
    return new VectorTile(new PbfReader(fs.readFileSync(tilePath)));
}

function findRealTileCandidates(layerType: LayerType, limit: number): RealTileCandidate[] {
    const expectedFeatureType = layerType === 'fill' ? 3 : layerType === 'line' ? 2 : 1;
    const candidates: RealTileCandidate[] = [];

    for (const tilePath of candidateTilePaths()) {
        const tile = loadMltTile(tilePath);
        for (const [layerName, sourceLayer] of Object.entries(tile.layers)) {
            if (sourceLayer.length === 0) continue;

            const candidateValues = new Map<string, {sampleValue: string | number | boolean; distinctValues: Set<string | number | boolean>}>();
            let matchingTypeFound = false;

            for (let index = 0; index < Math.min(sourceLayer.length, 32); index++) {
                const feature = sourceLayer.feature(index);
                if (feature.type !== expectedFeatureType) continue;
                matchingTypeFound = true;

                for (const [propertyName, value] of Object.entries(feature.properties ?? {})) {
                    if (value === null) continue;
                    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;

                    const entry = candidateValues.get(propertyName) ?? {sampleValue: value, distinctValues: new Set<string | number | boolean>()};
                    entry.distinctValues.add(value);
                    candidateValues.set(propertyName, entry);
                }
            }

            for (const [propertyName, entry] of candidateValues) {
                if (entry.distinctValues.size >= 2) {
                    const candidate = {
                        label: `${path.basename(tilePath)}:${layerName}:${propertyName}`,
                        tilePath,
                        layerName,
                        propertyName,
                        sampleValue: entry.sampleValue
                    };
                    if (layerType !== 'circle' || producesNonEmptyLegacyCircleBucket(candidate)) {
                        candidates.push(candidate);
                    }
                    break;
                }
            }

            if (candidates.length >= limit) {
                return candidates;
            }

            if (matchingTypeFound && candidates.every(candidate => candidate.tilePath !== tilePath || candidate.layerName !== layerName)) {
                for (const [propertyName, entry] of candidateValues) {
                    const candidate = {
                        label: `${path.basename(tilePath)}:${layerName}:${propertyName}`,
                        tilePath,
                        layerName,
                        propertyName,
                        sampleValue: entry.sampleValue
                    };
                    if (layerType !== 'circle' || producesNonEmptyLegacyCircleBucket(candidate)) {
                        candidates.push(candidate);
                    }
                    break;
                }
            }

            if (candidates.length >= limit) {
                return candidates;
            }
        }
    }

    if (candidates.length === 0) {
        throw new Error(`No real MLT candidate found for ${layerType}`);
    }

    return candidates;
}

function producesNonEmptyLegacyCircleBucket(candidate: RealTileCandidate): boolean {
    const legacyLayer = createCircleLayer(candidate.layerName, candidate.propertyName, candidate.sampleValue);
    const legacyBucket = new CircleBucket({
        layers: [legacyLayer],
        zoom: 0,
        overscaling: 1,
        index: 0
    } as BucketParameters<CircleStyleLayer>);
    const legacyTile = loadMltTile(candidate.tilePath);
    legacyBucket.populate(getFeaturesFromLayer(legacyTile.layers[candidate.layerName]), createPopulateOptions([]), new CanonicalTileID(0, 0, 0));
    return !legacyBucket.isEmpty();
}

function findMixedRealTileCandidate(): RealTileCandidate {
    for (const tilePath of candidateTilePaths()) {
        const tile = loadMltTile(tilePath);
        for (const [layerName, sourceLayer] of Object.entries(tile.layers)) {
            if (sourceLayer.length === 0) continue;

            let hasFill = false;
            let hasLine = false;
            const candidateValues = new Map<string, {sampleValue: string | number | boolean; distinctValues: Set<string | number | boolean>}>();

            for (let index = 0; index < Math.min(sourceLayer.length, 32); index++) {
                const feature = sourceLayer.feature(index);
                hasFill ||= feature.type === 3;
                hasLine ||= feature.type === 2;

                for (const [propertyName, value] of Object.entries(feature.properties ?? {})) {
                    if (value === null) continue;
                    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;

                    const entry = candidateValues.get(propertyName) ?? {sampleValue: value, distinctValues: new Set<string | number | boolean>()};
                    entry.distinctValues.add(value);
                    candidateValues.set(propertyName, entry);
                }
            }

            if (!hasFill || !hasLine) {
                continue;
            }

            for (const [propertyName, entry] of candidateValues) {
                if (entry.distinctValues.size >= 2) {
                    return {
                        label: `${path.basename(tilePath)}:${layerName}:${propertyName}`,
                        tilePath,
                        layerName,
                        propertyName,
                        sampleValue: entry.sampleValue
                    };
                }
            }
        }
    }

    throw new Error('No real mixed MLT candidate found');
}

function createFillLayer(sourceLayer: string, propertyName: string, sampleValue: string | number | boolean): FillStyleLayer {
    const layer = new FillStyleLayer({
        id: 'fill-real',
        source: 'source',
        'source-layer': sourceLayer,
        type: 'fill',
        filter: ['has', propertyName],
        paint: {
            'fill-opacity': ['case', ['==', ['get', propertyName], sampleValue], 0.75, 0.25]
        }
    }, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

function createLineLayer(sourceLayer: string, propertyName: string, sampleValue: string | number | boolean): LineStyleLayer {
    const layer = new LineStyleLayer({
        id: 'line-real',
        source: 'source',
        'source-layer': sourceLayer,
        type: 'line',
        filter: ['has', propertyName],
        paint: {
            'line-width': ['case', ['==', ['get', propertyName], sampleValue], 3, 1]
        }
    }, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

function createConvertedRoadLineLayer(id: string, sourceLayer: string, paint: LayerSpecification['paint']): LineStyleLayer {
    const layer = new LineStyleLayer({
        id,
        source: 'source',
        'source-layer': sourceLayer,
        type: 'line',
        paint
    } as LayerSpecification, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

function createCircleLayer(sourceLayer: string, propertyName: string, sampleValue: string | number | boolean): CircleStyleLayer {
    const layer = new CircleStyleLayer({
        id: 'circle-real',
        source: 'source',
        'source-layer': sourceLayer,
        type: 'circle',
        filter: ['has', propertyName],
        paint: {
            'circle-radius': ['case', ['==', ['get', propertyName], sampleValue], 5, 2]
        }
    }, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

function createSymbolBucketFromSpec(layerSpec: LayerSpecification, zoom: number, encoding: 'mvt' | 'mlt'): SymbolBucket {
    const layer = new SymbolStyleLayer(layerSpec, {});
    layer.recalculate({zoom, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return new SymbolBucket({
        layers: [layer],
        zoom,
        overscaling: 1,
        index: 0,
        sourceLayerIndex: 0,
        sourceID: 'source',
        collisionBoxArray: new CollisionBoxArray(),
        encoding
    } as BucketParameters<SymbolStyleLayer>);
}

function structArrayBytes(array: {arrayBuffer: ArrayBuffer; length: number; bytesPerElement: number}): number[] {
    return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}

function getPaintArrayValues(bucket: {programConfigurations: any}, layerId: string, property: string): number[] {
    const binder = bucket.programConfigurations.get(layerId).binders[property];
    if (!binder || !('paintVertexArray' in binder) || !binder.paintVertexArray) {
        return [];
    }
    const array = binder.paintVertexArray;
    return Array.from(new Float32Array(array.arrayBuffer, 0, array.length * (array.bytesPerElement / Float32Array.BYTES_PER_ELEMENT)));
}

function compressRuns(values: number[]): number[] {
    return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

function compareLineBucketToLegacy(columnar: LineBucket, legacy: LineBucket) {
    expect(structArrayBytes(columnar.layoutVertexArray as any)).toEqual(structArrayBytes(legacy.layoutVertexArray as any));
    expect(structArrayBytes(columnar.indexArray as any)).toEqual(structArrayBytes(legacy.indexArray as any));
    expect(columnar.segments.get()).toEqual(legacy.segments.get());
    expect(getPaintArrayValues(columnar as any, columnar.layerIds[0], 'line-width'))
        .toEqual(getPaintArrayValues(legacy as any, legacy.layerIds[0], 'line-width'));
}

function compareFillBucketToLegacy(columnar: FillBucket, legacy: FillBucket) {
    expect(columnar.layoutVertexArray).toHaveLength(legacy.layoutVertexArray.length);
    expect(structArrayBytes(columnar.indexArray as any)).toEqual(structArrayBytes(legacy.indexArray as any));
    expect(structArrayBytes(columnar.indexArray2 as any)).toEqual(structArrayBytes(legacy.indexArray2 as any));
    expect(columnar.segments.get()).toEqual(legacy.segments.get());
    expect(columnar.segments2.get()).toEqual(legacy.segments2.get());
    expect(compressRuns(getPaintArrayValues(legacy as any, legacy.layerIds[0], 'fill-opacity')))
        .toEqual(compressRuns(getPaintArrayValues(columnar as any, columnar.layerIds[0], 'fill-opacity')));
}

function compareFillExtrusionBucketToLegacy(columnar: FillExtrusionBucket, legacy: FillExtrusionBucket) {
    expect(structArrayBytes(columnar.layoutVertexArray as any)).toEqual(structArrayBytes(legacy.layoutVertexArray as any));
    expect(structArrayBytes(columnar.centroidVertexArray as any)).toEqual(structArrayBytes(legacy.centroidVertexArray as any));
    expect(structArrayBytes(columnar.indexArray as any)).toEqual(structArrayBytes(legacy.indexArray as any));
    expect(columnar.segments.get()).toEqual(legacy.segments.get());
    expect(compressRuns(getPaintArrayValues(legacy as any, legacy.layerIds[0], 'fill-extrusion-height')))
        .toEqual(compressRuns(getPaintArrayValues(columnar as any, columnar.layerIds[0], 'fill-extrusion-height')));
}

function compareCircleBucketToLegacy(columnar: CircleBucket<CircleStyleLayer>, legacy: CircleBucket<CircleStyleLayer>) {
    expect(structArrayBytes(columnar.layoutVertexArray as any)).toEqual(structArrayBytes(legacy.layoutVertexArray as any));
    expect(structArrayBytes(columnar.indexArray as any)).toEqual(structArrayBytes(legacy.indexArray as any));
    expect(columnar.segments.get()).toEqual(legacy.segments.get());
    expect(compressRuns(getPaintArrayValues(legacy as any, legacy.layerIds[0], 'circle-radius')))
        .toEqual(compressRuns(getPaintArrayValues(columnar as any, columnar.layerIds[0], 'circle-radius')));
}

function summarizeSymbolFeatures(bucket: SymbolBucket) {
    return bucket.features.map((feature) => ({
        text: feature.text ? feature.text.toString() : null,
        icon: feature.icon?.name ?? null,
        type: feature.type,
        index: feature.index
    }));
}

function createSupportedRealMltAuditLayers(): LayerSpecification[] {
    return [
        {
            id: 'audit-landcover-fill',
            source: 'source',
            'source-layer': 'landcover',
            type: 'fill',
            filter: ['==', ['get', 'class'], 'wood'],
            paint: {'fill-opacity': 0.9}
        },
        {
            id: 'audit-transportation-line',
            source: 'source',
            'source-layer': 'transportation',
            type: 'line',
            filter: ['has', 'class'],
            paint: {'line-width': 2}
        },
        {
            id: 'audit-place-circle',
            source: 'source',
            'source-layer': 'place',
            type: 'circle',
            filter: ['has', 'rank'],
            paint: {'circle-radius': 4}
        },
        {
            id: 'audit-building-extrusion',
            source: 'source',
            'source-layer': 'building',
            type: 'fill-extrusion',
            filter: ['has', 'render_height'],
            paint: {'fill-extrusion-height': ['get', 'render_height']}
        },
    ] as LayerSpecification[];
}

describe('WorkerTile real MLT corpus parsing', () => {
    const canonical = new CanonicalTileID(0, 0, 0);
    const fillCandidates = findRealTileCandidates('fill', 3);
    const lineCandidates = findRealTileCandidates('line', 3);
    const circleCandidates = findRealTileCandidates('circle', 2);

    test('keeps supported real MLT worker parses at zero feature materializations', async () => {
        const tilePath = path.join(__dirname, '../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const layerSpecifications = createSupportedRealMltAuditLayers();
        const featureSpies = layerSpecifications.map((layer) => {
            const sourceLayer = tile.layers[layer['source-layer']];
            const originalFeature = sourceLayer.feature.bind(sourceLayer);
            return vi.spyOn(sourceLayer, 'feature').mockImplementation((index: number) => originalFeature(index));
        });

        const result = await createWorkerTile().parse(
            tile,
            new StyleLayerIndex(layerSpecifications),
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(result.buckets.length).toBeGreaterThan(0);
        expect(featureSpies.reduce((count, spy) => count + spy.mock.calls.length, 0)).toBe(0);
    });

    test.each(fillCandidates)('parses real MLT fill candidate $label without materializing features', async (candidate) => {
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'fill-real',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'fill',
            filter: ['has', candidate.propertyName],
            paint: {
                'fill-opacity': ['case', ['==', ['get', candidate.propertyName], candidate.sampleValue], 0.75, 0.25]
            }
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as FillBucket;
        const legacyLayer = createFillLayer(candidate.layerName, candidate.propertyName, candidate.sampleValue);
        const legacyBucket = new FillBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<FillStyleLayer>);
        const legacyTile = loadMltTile(candidate.tilePath);
        legacyBucket.populate(getFeaturesFromLayer(legacyTile.layers[candidate.layerName]), createPopulateOptions([]), canonical);

        compareFillBucketToLegacy(columnarBucket, legacyBucket);
    });

    test('parses real MLT landcover render fixture without materializing features', async () => {
        const tilePath = path.join(__dirname, '../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.landcover;
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'landcover-render-fixture',
            source: 'source',
            'source-layer': 'landcover',
            type: 'fill',
            filter: ['==', ['get', 'class'], 'wood'],
            paint: {
                'fill-color': '#16a34a',
                'fill-opacity': 0.92
            }
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as FillBucket;
        const legacyLayer = new FillStyleLayer({
            id: 'landcover-render-fixture',
            source: 'source',
            'source-layer': 'landcover',
            type: 'fill',
            filter: ['==', ['get', 'class'], 'wood'],
            paint: {
                'fill-color': '#16a34a',
                'fill-opacity': 0.92
            }
        }, {});
        legacyLayer.recalculate({zoom: 14.92, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
        const legacyBucket = new FillBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<FillStyleLayer>);
        legacyBucket.populate(getFeaturesFromLayer(loadMltTile(tilePath).layers.landcover), createPopulateOptions([]), canonical);

        compareFillBucketToLegacy(columnarBucket, legacyBucket);
    });

    test('parses real MLT water render fixture without materializing features', async () => {
        const tilePath = path.join(__dirname, '../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.water;
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const filterExpression = ['all', ['==', ['get', 'class'], 'lake'], ['!=', ['get', 'intermittent'], 1]] as any;
        const layerIndex = new StyleLayerIndex([{
            id: 'water-render-fixture',
            source: 'source',
            'source-layer': 'water',
            type: 'fill',
            filter: filterExpression,
            paint: {
                'fill-color': '#38bdf8',
                'fill-opacity': 0.92
            }
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        const legacyLayer = new FillStyleLayer({
            id: 'water-render-fixture',
            source: 'source',
            'source-layer': 'water',
            type: 'fill',
            filter: filterExpression,
            paint: {
                'fill-color': '#38bdf8',
                'fill-opacity': 0.92
            }
        }, {});
        legacyLayer.recalculate({zoom: 14.92, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
        const legacyBucket = new FillBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<FillStyleLayer>);
        legacyBucket.populate(getFeaturesFromLayer(loadMltTile(tilePath).layers.water), createPopulateOptions([]), canonical);

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(legacyBucket.isEmpty() ? 0 : 1);

        if (legacyBucket.isEmpty()) {
            return;
        }

        const columnarBucket = result.buckets[0] as any as FillBucket;
        compareFillBucketToLegacy(columnarBucket, legacyBucket);
    });

    test.each(lineCandidates)('parses real MLT line candidate $label without materializing features', async (candidate) => {
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'line-real',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'line',
            filter: ['has', candidate.propertyName],
            paint: {
                'line-width': ['case', ['==', ['get', candidate.propertyName], candidate.sampleValue], 3, 1]
            }
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as LineBucket;
        const legacyLayer = createLineLayer(candidate.layerName, candidate.propertyName, candidate.sampleValue);
        const legacyBucket = new LineBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<LineStyleLayer>);
        const legacyTile = loadMltTile(candidate.tilePath);
        legacyBucket.populate(getFeaturesFromLayer(legacyTile.layers[candidate.layerName]), createPopulateOptions([]), canonical);

        compareLineBucketToLegacy(columnarBucket, legacyBucket);
    }, 60000);

    test.each(circleCandidates)('parses real MLT circle candidate $label without materializing features', async (candidate) => {
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'circle-real',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'circle',
            filter: ['has', candidate.propertyName],
            paint: {
                'circle-radius': ['case', ['==', ['get', candidate.propertyName], candidate.sampleValue], 5, 2]
            }
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as CircleBucket<CircleStyleLayer>;
        const legacyLayer = createCircleLayer(candidate.layerName, candidate.propertyName, candidate.sampleValue);
        const legacyBucket = new CircleBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<CircleStyleLayer>);
        const legacyTile = loadMltTile(candidate.tilePath);
        legacyBucket.populate(getFeaturesFromLayer(legacyTile.layers[candidate.layerName]), createPopulateOptions([]), canonical);

        compareCircleBucketToLegacy(columnarBucket, legacyBucket);
    });

    test('matches legacy on a real MLT circle layer with nested filters, sort-key and data-driven paint', async () => {
        const candidate = {
            tilePath: path.join(__dirname, '../../test/integration/assets/tiles/mlt/14/8716/5685.mlt'),
            layerName: 'place'
        } as const;
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'circle-real-advanced',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'circle',
            filter: [
                'all',
                ['has', 'rank'],
                ['any',
                    ['==', ['get', 'class'], 'suburb'],
                    ['==', ['get', 'class'], 'neighbourhood']
                ],
                ['!', ['==', ['get', 'name'], 'Nymphenburg']]
            ],
            layout: {
                'circle-sort-key': ['get', 'rank']
            },
            paint: {
                'circle-radius': [
                    'case',
                    ['==', ['get', 'class'], 'suburb'],
                    8,
                    5
                ],
                'circle-stroke-width': [
                    'case',
                    ['<=', ['get', 'rank'], 10],
                    2,
                    1
                ]
            }
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as CircleBucket<CircleStyleLayer>;
        const legacyLayer = new CircleStyleLayer({
            id: 'circle-real-advanced',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'circle',
            filter: [
                'all',
                ['has', 'rank'],
                ['any',
                    ['==', ['get', 'class'], 'suburb'],
                    ['==', ['get', 'class'], 'neighbourhood']
                ],
                ['!', ['==', ['get', 'name'], 'Nymphenburg']]
            ],
            layout: {
                'circle-sort-key': ['get', 'rank']
            },
            paint: {
                'circle-radius': [
                    'case',
                    ['==', ['get', 'class'], 'suburb'],
                    8,
                    5
                ],
                'circle-stroke-width': [
                    'case',
                    ['<=', ['get', 'rank'], 10],
                    2,
                    1
                ]
            }
        }, {});
        legacyLayer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);

        const legacyBucket = new CircleBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<CircleStyleLayer>);
        const legacyTile = loadMltTile(candidate.tilePath);
        legacyBucket.populate(getFeaturesFromLayer(legacyTile.layers[candidate.layerName]), createPopulateOptions([]), canonical);

        compareCircleBucketToLegacy(columnarBucket, legacyBucket);
    });

    test('matches legacy on a real MLT point symbol layer with data-driven icons', async () => {
        const tilePath = path.join(__dirname, '../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.place;
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const sendAsync = vi.fn().mockImplementation(async (message: {type: string; data?: {icons?: string[]}}) => {
            if (message.type === MessageType.getImages) {
                return Object.fromEntries((message.data?.icons ?? []).map((icon) => [icon, {width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0])}]));
            }

            return {};
        });
        const layerSpec = {
            id: 'place-icons-real',
            source: 'source',
            'source-layer': 'place',
            type: 'symbol',
            filter: [
                'all',
                ['has', 'rank'],
                ['any',
                    ['==', ['get', 'class'], 'suburb'],
                    ['==', ['get', 'class'], 'neighbourhood']
                ],
                ['!', ['==', ['get', 'name'], 'Nymphenburg']]
            ],
            layout: {
                'icon-image': [
                    'match',
                    ['get', 'class'],
                    'suburb',
                    'fav-circle-18',
                    'neighbourhood',
                    'fav-square-18',
                    'fav-marker-18'
                ],
                'icon-size': 1,
                'icon-allow-overlap': true,
                'symbol-sort-key': ['get', 'rank']
            }
        } as LayerSpecification;
        const layerIndex = new StyleLayerIndex([layerSpec]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            ['fav-circle-18', 'fav-square-18', 'fav-marker-18'],
            {sendAsync},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({
            type: MessageType.getImages,
            data: expect.objectContaining({type: 'icons'})
        }), expect.anything());
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as SymbolBucket;
        const legacyBucket = createSymbolBucketFromSpec(layerSpec, 14.92, 'mvt');
        legacyBucket.populate(getFeaturesFromLayer(loadMltTile(tilePath).layers.place), createPopulateOptions([]), canonical);

        expect(summarizeSymbolFeatures(columnarBucket)).toEqual(summarizeSymbolFeatures(legacyBucket));
    });

    test('matches legacy on a real MLT line placement symbol layer without materializing features', async () => {
        const tilePath = path.join(__dirname, '../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.transportation;
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const sendAsync = vi.fn().mockImplementation(async (message: {type: string; data?: {stacks?: Record<string, string[]>}}) => {
            if (message.type === MessageType.getGlyphs) {
                const stacks = message.data?.stacks ?? {};
                return Object.fromEntries(Object.entries(stacks).map(([stack, codes]) => [
                    stack,
                    Object.fromEntries(codes.map((code) => [code, {
                        id: code.codePointAt(0) ?? 0,
                        bitmap: new AlphaImage({width: 1, height: 1}, new Uint8Array([255])),
                        metrics: {width: 1, height: 1, left: 0, top: 0, advance: 8}
                    }]))
                ]));
            }

            return {};
        });
        const layerSpec = {
            id: 'transportation-labels-real',
            source: 'source',
            'source-layer': 'transportation',
            type: 'symbol',
            filter: [
                'all',
                ['has', 'class'],
                ['any',
                    ['==', ['get', 'class'], 'path'],
                    ['==', ['get', 'class'], 'service']
                ]
            ],
            layout: {
                'symbol-placement': 'line',
                'text-field': ['to-string', ['get', 'class']],
                'text-font': ['Noto Sans Regular'],
                'text-size': 14
            },
            paint: {
                'text-color': '#ffffff'
            }
        } as LayerSpecification;
        const layerIndex = new StyleLayerIndex([layerSpec]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({
            type: MessageType.getGlyphs,
            data: expect.objectContaining({
                stacks: expect.objectContaining({
                    'Noto Sans Regular': expect.arrayContaining(['a', 'h', 'p', 't'])
                })
            })
        }), expect.anything());
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as SymbolBucket;
        const legacyBucket = createSymbolBucketFromSpec(layerSpec, 15.8, 'mvt');
        legacyBucket.populate(getFeaturesFromLayer(loadMltTile(tilePath).layers.transportation), createPopulateOptions([]), canonical);

        expect(summarizeSymbolFeatures(columnarBucket)).toEqual(summarizeSymbolFeatures(legacyBucket));
    }, 60000);

    test('matches legacy on a real MLT mixed symbol layer with glyph and icon dependencies', async () => {
        const tilePath = path.join(__dirname, '../../test/integration/assets/tiles/mlt/14/8716/5685.mlt');
        const tile = loadMltTile(tilePath);
        const sourceLayer = tile.layers.place;
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const sendAsync = vi.fn().mockImplementation(async (message: {type: string; data?: {icons?: string[]; stacks?: Record<string, string[]>}}) => {
            if (message.type === MessageType.getImages) {
                return Object.fromEntries((message.data?.icons ?? []).map((icon) => [icon, {width: 1, height: 1, data: new Uint8Array([0, 0, 0, 0])}]));
            }
            if (message.type === MessageType.getGlyphs) {
                const stacks = message.data?.stacks ?? {};
                return Object.fromEntries(Object.entries(stacks).map(([stack, codes]) => [
                    stack,
                    Object.fromEntries(codes.map((code) => [code, {
                        id: code.codePointAt(0) ?? 0,
                        bitmap: new AlphaImage({width: 1, height: 1}, new Uint8Array([255])),
                        metrics: {width: 1, height: 1, left: 0, top: 0, advance: 8}
                    }]))
                ]));
            }

            return {};
        });
        const layerSpec = {
            id: 'place-mixed-real',
            source: 'source',
            'source-layer': 'place',
            type: 'symbol',
            filter: [
                'all',
                ['has', 'rank'],
                ['any',
                    ['==', ['get', 'class'], 'suburb'],
                    ['==', ['get', 'class'], 'neighbourhood']
                ],
                ['!', ['==', ['get', 'name'], 'Nymphenburg']]
            ],
            layout: {
                'text-field': ['get', 'name'],
                'text-font': ['Noto Sans Regular'],
                'text-size': 13,
                'icon-image': [
                    'match',
                    ['get', 'class'],
                    'suburb',
                    'fav-circle-18',
                    'neighbourhood',
                    'fav-square-18',
                    'fav-marker-18'
                ],
                'icon-size': 0.85,
                'icon-allow-overlap': true,
                'text-allow-overlap': true,
                'symbol-sort-key': ['get', 'rank']
            },
            paint: {
                'text-color': '#f8fafc'
            }
        } as LayerSpecification;
        const layerIndex = new StyleLayerIndex([layerSpec]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            ['fav-circle-18', 'fav-square-18', 'fav-marker-18'],
            {sendAsync},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({
            type: MessageType.getImages,
            data: expect.objectContaining({
                type: 'icons',
                icons: expect.arrayContaining(['fav-circle-18', 'fav-square-18'])
            })
        }), expect.anything());
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({
            type: MessageType.getGlyphs,
            data: expect.objectContaining({
                stacks: expect.objectContaining({
                    'Noto Sans Regular': expect.arrayContaining(['N', 'a', 'e'])
                })
            })
        }), expect.anything());
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as SymbolBucket;
        const legacyBucket = createSymbolBucketFromSpec(layerSpec, 14.92, 'mvt');
        legacyBucket.populate(getFeaturesFromLayer(loadMltTile(tilePath).layers.place), createPopulateOptions([]), canonical);

        expect(summarizeSymbolFeatures(columnarBucket)).toEqual(summarizeSymbolFeatures(legacyBucket));
    });

    test('matches legacy on a real MLT fill-extrusion layer without materializing features', async () => {
        const candidate = {
            tilePath: path.join(__dirname, '../../test/integration/assets/tiles/mlt/14/8716/5685.mlt'),
            layerName: 'building'
        } as const;
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'fill-extrusion-real',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'fill-extrusion',
            filter: ['==', 'render_height', 4],
            paint: {
                'fill-extrusion-height': ['get', 'render_height'],
                'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
                'fill-extrusion-opacity': 0.9
            }
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as FillExtrusionBucket;
        const legacyLayer = new FillExtrusionStyleLayer({
            id: 'fill-extrusion-real',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'fill-extrusion',
            filter: ['==', 'render_height', 4],
            paint: {
                'fill-extrusion-height': ['get', 'render_height'],
                'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
                'fill-extrusion-opacity': 0.9
            }
        }, {});
        legacyLayer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
        const legacyBucket = new FillExtrusionBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<FillExtrusionStyleLayer>);
        const legacyTile = loadMltTile(candidate.tilePath);
        legacyBucket.populate(getFeaturesFromLayer(legacyTile.layers[candidate.layerName]), createPopulateOptions([]), canonical);

        compareFillExtrusionBucketToLegacy(columnarBucket, legacyBucket);
    }, 60000);

    test('parses mixed real MLT source layers for line buckets without materializing features', async () => {
        const candidate = findMixedRealTileCandidate();
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'line-mixed-real',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'line',
            filter: ['has', candidate.propertyName],
            paint: {
                'line-width': ['case', ['==', ['get', candidate.propertyName], candidate.sampleValue], 3, 1]
            }
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);
        const columnarLineBucket = result.buckets.find((bucket: any) => bucket.layerIds?.includes('line-mixed-real')) as LineBucket;

        expect(columnarLineBucket).toBeDefined();
        const legacyLineLayer = createLineLayer(candidate.layerName, candidate.propertyName, candidate.sampleValue);
        legacyLineLayer.id = 'line-mixed-real';

        const legacyLineBucket = new LineBucket({
            layers: [legacyLineLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<LineStyleLayer>);
        const legacyTile = loadMltTile(candidate.tilePath);
        const legacyFeatures = getFeaturesFromLayer(legacyTile.layers[candidate.layerName]);

        legacyLineBucket.populate(legacyFeatures, createPopulateOptions([]), canonical);

        compareLineBucketToLegacy(columnarLineBucket, legacyLineBucket);
    });

    test('matches legacy on a real MLT fill layer with sort-key and data-driven paint', async () => {
        const candidate = {
            tilePath: path.join(__dirname, '../../test/integration/assets/tiles/mlt/14/8716/5685.mlt'),
            layerName: 'building',
            propertyName: 'render_height',
            sampleValue: 4
        } as const;
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'fill-real-sort',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'fill',
            filter: ['has', candidate.propertyName],
            layout: {
                'fill-sort-key': ['get', candidate.propertyName]
            },
            paint: {
                'fill-opacity': ['case', ['==', ['get', candidate.propertyName], candidate.sampleValue], 0.75, 0.25]
            }
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as FillBucket;
        const legacyLayer = new FillStyleLayer({
            id: 'fill-real-sort',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'fill',
            filter: ['has', candidate.propertyName],
            layout: {
                'fill-sort-key': ['get', candidate.propertyName]
            },
            paint: {
                'fill-opacity': ['case', ['==', ['get', candidate.propertyName], candidate.sampleValue], 0.75, 0.25]
            }
        }, {});
        legacyLayer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
        const legacyBucket = new FillBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<FillStyleLayer>);
        const legacyTile = loadMltTile(candidate.tilePath);
        legacyBucket.populate(getFeaturesFromLayer(legacyTile.layers[candidate.layerName]), createPopulateOptions([]), canonical);

        compareFillBucketToLegacy(columnarBucket, legacyBucket);
    }, 60000);

    test('matches legacy on a real MLT line layer with sort-key and data-driven paint', async () => {
        const candidate = {
            tilePath: path.join(__dirname, '../../test/integration/assets/tiles/mlt/14/8716/5685.mlt'),
            layerName: 'transportation',
            propertyName: 'layer',
            sampleValue: -1
        } as const;
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'line-real-sort',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'line',
            filter: ['has', candidate.propertyName],
            layout: {
                'line-sort-key': ['get', candidate.propertyName]
            },
            paint: {
                'line-width': ['case', ['==', ['get', candidate.propertyName], candidate.sampleValue], 3, 1]
            }
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as LineBucket;
        const legacyLayer = new LineStyleLayer({
            id: 'line-real-sort',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'line',
            filter: ['has', candidate.propertyName],
            layout: {
                'line-sort-key': ['get', candidate.propertyName]
            },
            paint: {
                'line-width': ['case', ['==', ['get', candidate.propertyName], candidate.sampleValue], 3, 1]
            }
        }, {});
        legacyLayer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
        const legacyBucket = new LineBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<LineStyleLayer>);
        const legacyTile = loadMltTile(candidate.tilePath);
        legacyBucket.populate(getFeaturesFromLayer(legacyTile.layers[candidate.layerName]), createPopulateOptions([]), canonical);

        compareLineBucketToLegacy(columnarBucket, legacyBucket);
    }, 60000);

    test.each(convertedGlJsRoadTilePaths())('matches legacy on converted gl-js road tile %s with data-driven line-color', async (tilePath) => {
        const candidate = {tilePath, layerName: 'road'} as const;
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const paint = {
            'line-width': 10,
            'line-color': {
                property: 'class',
                type: 'categorical',
                stops: [
                    ['path', 'red'],
                    ['driveway', 'orange'],
                    ['service', 'yellow'],
                    ['street_limited', 'green'],
                    ['street', 'blue'],
                    ['main', 'purple']
                ]
            }
        } as const;
        const layerIndex = new StyleLayerIndex([{
            id: 'line-real-color',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'line',
            paint: paint as any
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as LineBucket;
        const legacyLayer = createConvertedRoadLineLayer('line-real-color', candidate.layerName, paint as any);
        const legacyBucket = new LineBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<LineStyleLayer>);
        const legacyTile = loadMltTile(candidate.tilePath);
        legacyBucket.populate(getFeaturesFromLayer(legacyTile.layers[candidate.layerName]), createPopulateOptions([]), canonical);

        compareLineBucketToLegacy(columnarBucket, legacyBucket);
        expect(compressRuns(getPaintArrayValues(columnarBucket as any, columnarBucket.layerIds[0], 'line-color')))
            .toEqual(compressRuns(getPaintArrayValues(legacyBucket as any, legacyBucket.layerIds[0], 'line-color')));
    });

    test.each(convertedGlJsRoadTilePaths())('matches legacy on converted gl-js road tile %s with constant line-color', async (tilePath) => {
        const candidate = {tilePath, layerName: 'road'} as const;
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const paint = {
            'line-width': 10,
            'line-color': 'blue'
        } as const;
        const layerIndex = new StyleLayerIndex([{
            id: 'line-real-constant-color',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'line',
            paint
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as LineBucket;
        const legacyLayer = createConvertedRoadLineLayer('line-real-constant-color', candidate.layerName, paint);
        const legacyBucket = new LineBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<LineStyleLayer>);
        const legacyTile = loadMltTile(candidate.tilePath);
        legacyBucket.populate(getFeaturesFromLayer(legacyTile.layers[candidate.layerName]), createPopulateOptions([]), canonical);
        compareLineBucketToLegacy(columnarBucket, legacyBucket);
    });

    test.each(convertedGlJsRoadTilePaths())('keeps global-state value filters columnar on converted gl-js road tile %s', async (tilePath) => {
        const candidate = {tilePath, layerName: 'road'} as const;
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureTable = (sourceLayer as any).featureTable;
        const classVector = featureTable.getPropertyVector('class');
        const roadClass = Array.from({length: featureTable.numFeatures}, (_, index) => classVector.getValue(index))
            .find((value) => typeof value === 'string');
        expect(roadClass).toBeDefined();

        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const globalState = {roadClass};
        const layerSpecification = {
            id: 'line-real-global-state-filter',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'line',
            filter: ['==', ['get', 'class'], ['global-state', 'roadClass']],
            paint: {
                'line-width': 10,
                'line-color': 'blue'
            }
        } as LayerSpecification;
        const layerIndex = new StyleLayerIndex([layerSpecification], globalState);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        const legacyLayer = new LineStyleLayer(layerSpecification, globalState);
        legacyLayer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
        const legacyBucket = new LineBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<LineStyleLayer>);
        const legacyTile = loadMltTile(candidate.tilePath);
        legacyBucket.populate(getFeaturesFromLayer(legacyTile.layers[candidate.layerName]), createPopulateOptions([]), canonical);

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(legacyBucket.isEmpty() ? 0 : 1);
        if (!legacyBucket.isEmpty()) {
            const columnarBucket = result.buckets[0] as any as LineBucket;
            compareLineBucketToLegacy(columnarBucket, legacyBucket);
        }
    });

    test.each(convertedGlJsRoadTilePaths())('keeps trivial case filters columnar on converted gl-js road tile %s', async (tilePath) => {
        const candidate = {tilePath, layerName: 'road'} as const;
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureTable = (sourceLayer as any).featureTable;
        const classVector = featureTable.getPropertyVector('class');
        const roadClass = Array.from({length: featureTable.numFeatures}, (_, index) => classVector.getValue(index))
            .find((value) => typeof value === 'string');
        expect(roadClass).toBeDefined();

        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const layerSpecification = {
            id: 'line-real-case-filter',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'line',
            filter: ['case', ['coalesce', ['==', ['get', 'class'], roadClass], false], true, false],
            paint: {
                'line-width': 10,
                'line-color': 'blue'
            }
        } as LayerSpecification;
        const layerIndex = new StyleLayerIndex([layerSpecification]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        const legacyLayer = new LineStyleLayer(layerSpecification, {});
        legacyLayer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
        const legacyBucket = new LineBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<LineStyleLayer>);
        const legacyTile = loadMltTile(candidate.tilePath);
        legacyBucket.populate(getFeaturesFromLayer(legacyTile.layers[candidate.layerName]), createPopulateOptions([]), canonical);

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(legacyBucket.isEmpty() ? 0 : 1);
        if (!legacyBucket.isEmpty()) {
            const columnarBucket = result.buckets[0] as any as LineBucket;
            compareLineBucketToLegacy(columnarBucket, legacyBucket);
        }
    });

    test.each(convertedGlJsRoadTilePaths())('rejects unsupported filters without materializing converted gl-js road tile %s', async (tilePath) => {
        const candidate = {tilePath, layerName: 'road'} as const;
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const layerSpecification = {
            id: 'line-real-fallback-filter',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'line',
            filter: ['case', ['==', ['feature-state', 'rank'], null], true, false],
            paint: {
                'line-width': 10,
                'line-color': 'blue'
            }
        } as LayerSpecification;
        const layerIndex = new StyleLayerIndex([layerSpecification]);

        const workerTile = createWorkerTile();
        await expect(workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        )).rejects.toThrow(/does not support the filter.*feature-state expressions/);

        expect(featureSpy).not.toHaveBeenCalled();
    });

    test('matches legacy on a real MLT fill layer with nested filters, sort-key and data-driven paint', async () => {
        const candidate = {
            tilePath: path.join(__dirname, '../../test/integration/assets/tiles/mlt/14/8716/5685.mlt'),
            layerName: 'building'
        } as const;
        const filterSpecification: any = [
            'all',
            ['has', 'render_height'],
            ['any', ['==', ['get', 'render_height'], 3], ['==', ['get', 'render_height'], 4]],
            ['!', ['has', 'colour']]
        ];
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'fill-real-nested',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'fill',
            filter: filterSpecification,
            layout: {
                'fill-sort-key': ['get', 'render_height']
            },
            paint: {
                'fill-opacity': ['case', ['==', ['get', 'render_height'], 4], 0.75, 0.25]
            }
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        const legacyLayer = new FillStyleLayer({
            id: 'fill-real-nested',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'fill',
            filter: filterSpecification,
            layout: {
                'fill-sort-key': ['get', 'render_height']
            },
            paint: {
                'fill-opacity': ['case', ['==', ['get', 'render_height'], 4], 0.75, 0.25]
            }
        } as any as LayerSpecification, {});
        legacyLayer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
        const legacyBucket = new FillBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<FillStyleLayer>);
        const legacyTile = loadMltTile(candidate.tilePath);
        legacyBucket.populate(getFeaturesFromLayer(legacyTile.layers[candidate.layerName]), createPopulateOptions([]), canonical);

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(legacyBucket.isEmpty() ? 0 : 1);

        if (legacyBucket.isEmpty()) {
            return;
        }

        const columnarBucket = result.buckets[0] as any as FillBucket;
        compareFillBucketToLegacy(columnarBucket, legacyBucket);
    });

    test('matches legacy on a real MLT line layer with nested filters, sort-key and data-driven paint', async () => {
        const candidate = {
            tilePath: path.join(__dirname, '../../test/integration/assets/tiles/mlt/14/8716/5685.mlt'),
            layerName: 'transportation'
        } as const;
        const filterSpecification: any = [
            'all',
            ['has', 'layer'],
            ['any', ['==', ['get', 'class'], 'path'], ['==', ['get', 'class'], 'service']],
            ['!', ['==', ['get', 'ramp'], 1]]
        ];
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
            id: 'line-real-nested',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'line',
            filter: filterSpecification,
            layout: {
                'line-sort-key': ['get', 'layer']
            },
            paint: {
                'line-width': ['case', ['==', ['get', 'layer'], -1], 3, 1]
            }
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as LineBucket;
        const legacyLayer = new LineStyleLayer({
            id: 'line-real-nested',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'line',
            filter: filterSpecification,
            layout: {
                'line-sort-key': ['get', 'layer']
            },
            paint: {
                'line-width': ['case', ['==', ['get', 'layer'], -1], 3, 1]
            }
        } as any as LayerSpecification, {});
        legacyLayer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
        const legacyBucket = new LineBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<LineStyleLayer>);
        const legacyTile = loadMltTile(candidate.tilePath);
        legacyBucket.populate(getFeaturesFromLayer(legacyTile.layers[candidate.layerName]), createPopulateOptions([]), canonical);

        compareLineBucketToLegacy(columnarBucket, legacyBucket);
    });

    test.each(convertedGlJsRoadTiles())('matches equivalent original MVT rendering for converted gl-js road tile %s with data-driven line-color', async ({label: _label, mltTilePath, mvtTilePath}) => {
        const layerName = 'road' as const;
        const tile = loadMltTile(mltTilePath);
        const sourceLayer = tile.layers[layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const paint = {
            'line-width': 10,
            'line-color': {
                property: 'class',
                type: 'categorical',
                stops: [
                    ['path', 'red'],
                    ['driveway', 'orange'],
                    ['service', 'yellow'],
                    ['street_limited', 'green'],
                    ['street', 'blue'],
                    ['main', 'purple']
                ]
            }
        } as const;
        const layerIndex = new StyleLayerIndex([{
            id: 'line-real-color-mvt-parity',
            source: 'source',
            'source-layer': layerName,
            type: 'line',
            paint: paint as any
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as LineBucket;
        const legacyLayer = createConvertedRoadLineLayer('line-real-color-mvt-parity', layerName, paint as any);
        const legacyBucket = new LineBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<LineStyleLayer>);
        legacyBucket.populate(getFeaturesFromLayer(loadMvtTile(mvtTilePath).layers[layerName]), createPopulateOptions([]), canonical);

        compareLineBucketToLegacy(columnarBucket, legacyBucket);
        expect(compressRuns(getPaintArrayValues(columnarBucket as any, columnarBucket.layerIds[0], 'line-color')))
            .toEqual(compressRuns(getPaintArrayValues(legacyBucket as any, legacyBucket.layerIds[0], 'line-color')));
    });

    test.each(convertedGlJsRoadTiles())('matches equivalent original MVT rendering for converted gl-js road_label tile $label with constant line-color', async ({mltTilePath, mvtTilePath}) => {
        const layerName = 'road_label' as const;
        const tile = loadMltTile(mltTilePath);
        const sourceLayer = tile.layers[layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const paint = {
            'line-width': 1,
            'line-color': '#000000'
        } as const;
        const layerIndex = new StyleLayerIndex([{
            id: 'road-label-line-constant',
            source: 'source',
            'source-layer': layerName,
            type: 'line',
            paint
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as LineBucket;
        const legacyLayer = createConvertedRoadLineLayer('road-label-line-constant', layerName, paint);
        const legacyBucket = new LineBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<LineStyleLayer>);
        legacyBucket.populate(getFeaturesFromLayer(loadMvtTile(mvtTilePath).layers[layerName]), createPopulateOptions([]), canonical);

        compareLineBucketToLegacy(columnarBucket, legacyBucket);
    });

    test.each(convertedGlJsRoadTiles())('matches equivalent original MVT rendering for converted gl-js road_label tile $label with id-driven line-color', async ({mltTilePath, mvtTilePath}) => {
        const layerName = 'road_label' as const;
        const tile = loadMltTile(mltTilePath);
        const sourceLayer = tile.layers[layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const paint = {
            'line-width': 1,
            'line-color': ['match',
                ['%', ['to-number', ['id']], 10],
                0, ['to-color', 'red'],
                1, ['to-color', 'blue'],
                2, ['to-color', 'yellow'],
                3, ['to-color', 'black'],
                4, ['to-color', 'grey'],
                5, ['to-color', 'purple'],
                6, ['to-color', 'green'],
                7, ['to-color', 'orange'],
                8, ['to-color', 'brown'],
                9, ['to-color', 'lime'],
                ['to-color', 'magenta']
            ]
        } as const;
        const layerIndex = new StyleLayerIndex([{
            id: 'road-label-line-id-color',
            source: 'source',
            'source-layer': layerName,
            type: 'line',
            paint: paint as any
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as LineBucket;
        const legacyLayer = createConvertedRoadLineLayer('road-label-line-id-color', layerName, paint as any);
        const legacyBucket = new LineBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<LineStyleLayer>);
        legacyBucket.populate(getFeaturesFromLayer(loadMvtTile(mvtTilePath).layers[layerName]), createPopulateOptions([]), canonical);

        compareLineBucketToLegacy(columnarBucket, legacyBucket);
        expect(compressRuns(getPaintArrayValues(columnarBucket as any, columnarBucket.layerIds[0], 'line-color')))
            .toEqual(compressRuns(getPaintArrayValues(legacyBucket as any, legacyBucket.layerIds[0], 'line-color')));
    });

    test('matches equivalent original MVT rendering for converted gl-js building tile with constant line-color', async () => {
        const layerName = 'building' as const;
        const mltTilePath = path.join(__dirname, '../../test/integration/assets/tiles/mlt/gl-js/14-9579-5520.mlt');
        const mvtTilePath = path.join(__dirname, '../../test/integration/assets/tiles/14-9579-5520.mvt');
        const tile = loadMltTile(mltTilePath);
        const sourceLayer = tile.layers[layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const paint = {
            'line-width': 1,
            'line-color': '#000000'
        } as const;
        const layerIndex = new StyleLayerIndex([{
            id: 'building-line-constant',
            source: 'source',
            'source-layer': layerName,
            type: 'line',
            paint
        }]);

        const workerTile = createWorkerTile();
        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(result.buckets).toHaveLength(1);

        const columnarBucket = result.buckets[0] as any as LineBucket;
        const legacyLayer = createConvertedRoadLineLayer('building-line-constant', layerName, paint);
        const legacyBucket = new LineBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<LineStyleLayer>);
        legacyBucket.populate(getFeaturesFromLayer(loadMvtTile(mvtTilePath).layers[layerName]), createPopulateOptions([]), canonical);

        compareLineBucketToLegacy(columnarBucket, legacyBucket);
    });

    test('supports fill-pattern on a real MLT fill layer without materializing features', async () => {
        const candidate = fillCandidates[0];
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const sendAsync = vi.fn().mockResolvedValue({});
        const layerIndex = new StyleLayerIndex([{
            id: 'fill-real-pattern',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'fill',
            filter: ['has', candidate.propertyName],
            paint: {
                'fill-pattern': 'pattern'
            }
        }]);

        const workerTile = createWorkerTile();

        const result = await workerTile.parse(
            tile,
            layerIndex,
            ['pattern'],
            {sendAsync},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({
            type: MessageType.getImages,
            data: expect.objectContaining({type: 'patterns', icons: ['pattern']})
        }), expect.anything());
        expect(result.buckets[0].isEmpty()).toBe(false);
    });

    test('supports line-pattern on a real MLT line layer without materializing features', async () => {
        const candidate = lineCandidates[0];
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const sendAsync = vi.fn().mockResolvedValue({});
        const layerIndex = new StyleLayerIndex([{
            id: 'line-real-pattern',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'line',
            filter: ['has', candidate.propertyName],
            paint: {'line-pattern': 'pattern'}
        } as any]);

        const workerTile = createWorkerTile();

        const result = await workerTile.parse(
            tile,
            layerIndex,
            ['pattern'],
            {sendAsync},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({
            type: MessageType.getImages,
            data: expect.objectContaining({type: 'patterns', icons: ['pattern']})
        }), expect.anything());
        expect(result.buckets[0].isEmpty()).toBe(false);
    });

    test('supports constant real MLT line-dasharray without materializing features', async () => {
        const candidate = lineCandidates[0];
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const sendAsync = vi.fn().mockResolvedValue({});
        const layerIndex = new StyleLayerIndex([{
            id: 'line-real-dasharray',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'line',
            filter: ['has', candidate.propertyName],
            paint: {'line-dasharray': ['literal', [2, 1]]}
        } as any]);

        const workerTile = createWorkerTile();

        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(sendAsync).not.toHaveBeenCalled();
        expect(result.buckets[0].isEmpty()).toBe(false);
    });

    test('supports data-driven real MLT line-dasharray without materializing features', async () => {
        const candidate = lineCandidates[0];
        const tile = loadMltTile(candidate.tilePath);
        const sourceLayer = tile.layers[candidate.layerName];
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const sendAsync = vi.fn().mockResolvedValue({
            '2,1,false': {y: 0, height: 16, width: 256}
        });
        const layerIndex = new StyleLayerIndex([{
            id: 'line-real-dasharray-data-driven',
            source: 'source',
            'source-layer': candidate.layerName,
            type: 'line',
            filter: ['has', candidate.propertyName],
            paint: {
                'line-dasharray': ['case', ['has', candidate.propertyName], ['literal', [2, 1]], ['literal', [1, 2]]]
            }
        } as any]);

        const workerTile = createWorkerTile();

        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync},
            SubdivisionGranularitySetting.noSubdivision
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(sendAsync).toHaveBeenCalledWith(expect.objectContaining({
            type: MessageType.getDashes,
            data: expect.objectContaining({dashes: expect.any(Object)})
        }), expect.anything());
        expect(result.buckets[0].isEmpty()).toBe(false);
    });

    test('parses the synthetic MLT line-gradient render fixture into a non-empty bucket', async () => {
        const mltTilePath = path.join(__dirname, '../../test/integration/assets/tiles/mlt/line-gradient-synthetic.mlt');
        const mvtTilePath = path.join(__dirname, '../../test/integration/assets/tiles/line-gradient-synthetic.mvt');
        const tile = loadMltTile(mltTilePath);
        const sourceLayer = tile.layers.gradient;
        const featureSpy = vi.spyOn(sourceLayer, 'feature');
        const layerIndex = new StyleLayerIndex([{
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
        } as any]);
        const workerTile = createWorkerTile();

        const result = await workerTile.parse(
            tile,
            layerIndex,
            [],
            {sendAsync: vi.fn().mockResolvedValue({})},
            SubdivisionGranularitySetting.noSubdivision
        );

        const parsedBucket = result.buckets[0] as LineBucket;
        const legacyLayer = new LineStyleLayer({
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
        legacyLayer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);

        const legacyBucket = new LineBucket({
            layers: [legacyLayer],
            zoom: 0,
            overscaling: 1,
            index: 0
        } as BucketParameters<LineStyleLayer>);
        legacyBucket.populate(
            getFeaturesFromLayer(loadMvtTile(mvtTilePath).layers.gradient),
            createPopulateOptions([]),
            new CanonicalTileID(0, 0, 0)
        );

        expect(featureSpy).not.toHaveBeenCalled();
        expect(parsedBucket.isEmpty()).toBe(false);
        expect(parsedBucket.lineClipsArray).toEqual([{start: 0, end: 1}]);
        expect(parsedBucket.layoutVertexArray.length).toBeGreaterThan(0);
        expect(parsedBucket.layoutVertexArray2.length).toBeGreaterThan(0);
        expect(parsedBucket.layoutVertexArray).toHaveLength(legacyBucket.layoutVertexArray.length);
        expect(parsedBucket.layoutVertexArray2).toHaveLength(legacyBucket.layoutVertexArray2.length);
    });
});
