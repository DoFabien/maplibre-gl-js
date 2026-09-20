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
import {CircleStyleLayer} from '../style/style_layer/circle_style_layer';

import type {WorkerTileParameters} from './worker_source';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {BucketParameters} from '../data/bucket';
import type {EvaluationParameters} from '../style/evaluation_parameters';
import type {ZoomHistory} from '../style/zoom_history';

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

function loadMltTile(tilePath: string): MLTVectorTile {
    const rawTile = fs.readFileSync(tilePath);
    return new MLTVectorTile(rawTile.buffer.slice(rawTile.byteOffset, rawTile.byteOffset + rawTile.byteLength));
}

function loadMvtTile(tilePath: string): VectorTile {
    return new VectorTile(new PbfReader(fs.readFileSync(tilePath)));
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

function compareCircleBucketToLegacy(columnar: CircleBucket<CircleStyleLayer>, legacy: CircleBucket<CircleStyleLayer>) {
    expect(structArrayBytes(columnar.layoutVertexArray as any)).toEqual(structArrayBytes(legacy.layoutVertexArray as any));
    expect(structArrayBytes(columnar.indexArray as any)).toEqual(structArrayBytes(legacy.indexArray as any));
    expect(columnar.segments.get()).toEqual(legacy.segments.get());
    expect(compressRuns(getPaintArrayValues(legacy as any, legacy.layerIds[0], 'circle-radius')))
        .toEqual(compressRuns(getPaintArrayValues(columnar as any, columnar.layerIds[0], 'circle-radius')));
}

function createLegacyCircleBucket(layerSpec: LayerSpecification, zoom: number): CircleBucket<CircleStyleLayer> {
    const layer = new CircleStyleLayer(layerSpec, {});
    layer.recalculate({zoom, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return new CircleBucket({
        layers: [layer],
        zoom,
        overscaling: 1,
        index: 0
    } as BucketParameters<CircleStyleLayer>);
}

describe('OMT MLT circle parity', () => {
    const canonical = new CanonicalTileID(0, 0, 0);

    test('matches equivalent MVT rendering for the real OMT place circle layer', async () => {
        const mltTilePath = path.join(__dirname, '../../test/integration/assets/tiles/mlt/omt/3/4/2.mlt');
        const mvtTilePath = path.join(__dirname, '../../test/integration/assets/tiles/omt/3/4/2.mvt');
        const layerSpec = {
            id: 'omt-place-circles-real',
            source: 'source',
            'source-layer': 'place',
            type: 'circle',
            filter: [
                'any',
                ['==', ['get', 'class'], 'country'],
                ['==', ['get', 'class'], 'city']
            ],
            paint: {
                'circle-radius': [
                    'match',
                    ['get', 'class'],
                    'country',
                    10,
                    7
                ],
                'circle-color': [
                    'match',
                    ['get', 'class'],
                    'country',
                    '#f97316',
                    '#2563eb'
                ],
                'circle-stroke-width': 2
            }
        } as LayerSpecification;

        const tile = loadMltTile(mltTilePath);
        const featureSpy = vi.spyOn(tile.layers.place, 'feature');
        const layerIndex = new StyleLayerIndex([layerSpec]);
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
        const legacyBucket = createLegacyCircleBucket(layerSpec, 3.1);
        legacyBucket.populate(getFeaturesFromLayer(loadMvtTile(mvtTilePath).layers.place), createPopulateOptions([]), canonical);

        compareCircleBucketToLegacy(columnarBucket, legacyBucket);
    });

    test('matches equivalent MVT rendering for the real OMT poi circle layer', async () => {
        const mltTilePath = path.join(__dirname, '../../test/integration/assets/tiles/mlt/omt/14/8299/5635.mlt');
        const mvtTilePath = path.join(__dirname, '../../test/integration/assets/tiles/omt/14/8299/5635.mvt');
        const layerSpec = {
            id: 'omt-poi-circles-real',
            source: 'source',
            'source-layer': 'poi',
            type: 'circle',
            filter: [
                'any',
                ['==', ['get', 'class'], 'railway'],
                ['==', ['get', 'class'], 'bus'],
                ['==', ['get', 'class'], 'hospital']
            ],
            paint: {
                'circle-radius': [
                    'match',
                    ['get', 'class'],
                    'railway',
                    6,
                    'hospital',
                    5,
                    4
                ],
                'circle-color': [
                    'match',
                    ['get', 'class'],
                    'railway',
                    '#2563eb',
                    'hospital',
                    '#ef4444',
                    '#22c55e'
                ],
                'circle-stroke-width': 1.5,
                'circle-opacity': 0.95
            }
        } as LayerSpecification;

        const tile = loadMltTile(mltTilePath);
        const featureSpy = vi.spyOn(tile.layers.poi, 'feature');
        const layerIndex = new StyleLayerIndex([layerSpec]);
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
        const legacyBucket = createLegacyCircleBucket(layerSpec, 14.2);
        legacyBucket.populate(getFeaturesFromLayer(loadMvtTile(mvtTilePath).layers.poi), createPopulateOptions([]), canonical);

        compareCircleBucketToLegacy(columnarBucket, legacyBucket);
    });
});
