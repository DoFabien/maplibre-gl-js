import {expect, test} from 'vitest';
import Point from '@mapbox/point-geometry';
import {createConstGeometryVector, FeatureTable, GEOMETRY_TYPE, IntFlatVector, TopologyVector} from '@maplibre/mlt';
import {createFlatGeometryVector} from '@maplibre/mlt/dist/vector/geometry/flatGeometryVector';
import {WorkerTile} from './worker_tile';
import {MLTVectorTile} from './vector_tile_mlt';
import {OverscaledTileID} from '../tile/tile_id';
import {StyleLayerIndex} from '../style/style_layer_index';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings';
import {MercatorTransform} from '../geo/projection/mercator_transform';
import {EvaluationParameters} from '../style/evaluation_parameters';
import {DictionaryCoder} from '../util/dictionary_coder';
import {serialize, deserialize} from '../util/web_worker_transfer';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../util/mlt_materialization_stats';

import type {WorkerTileParameters} from './worker_source';
import type {VectorTileLike} from '@maplibre/vt-pbf';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {FeatureIndex} from '../data/feature_index';
import type {LineBucket} from '../data/bucket/line_bucket';

type Geometry = {type: GEOMETRY_TYPE; parts: Array<Array<[number, number]>>};
const farLine: Geometry = {type: GEOMETRY_TYPE.LINESTRING, parts: [[[500, 500], [600, 600]]]};

/** Uses typed topology for both a mixed road layer and constant-type fast paths. */
function table(geometries: Geometry[], mixed: boolean): FeatureTable {
    const geometryOffsets = [0]; const partOffsets = [0]; const coordinates: number[] = [];
    for (const geometry of geometries) {
        for (const part of geometry.parts) {
            for (const vertex of part) coordinates.push(...vertex);
            partOffsets.push(coordinates.length / 2);
        }
        geometryOffsets.push(partOffsets.length - 1);
    }
    const topology = new TopologyVector(new Uint32Array(geometryOffsets), new Uint32Array(partOffsets));
    const vertices = new Int32Array(coordinates);
    const vector = mixed ? createFlatGeometryVector(new Int32Array(geometries.map(geometry => geometry.type)), topology, undefined, vertices) :
        createConstGeometryVector(geometries.length, geometries[0].type, topology, undefined, vertices);
    return new FeatureTable('road', vector, new IntFlatVector('id', new Int32Array(geometries.map((_, index) => index + 1)), geometries.length));
}

function legacy(geometries: Geometry[]): VectorTileLike {
    return {layers: {road: {version: 2, name: 'road', extent: 4096, length: geometries.length, feature(index) {
        const geometry = geometries[index];
        return {id: index + 1, extent: 4096, properties: {},
            type: geometry.type === GEOMETRY_TYPE.POINT || geometry.type === GEOMETRY_TYPE.MULTIPOINT ? 1 : 2,
            loadGeometry: () => geometry.parts.map(part => part.map(([x, y]) => new Point(x, y)))};
    }}}};
}

test.each([
    {name: 'point in a mixed road layer', mixed: true, geometries: [{type: GEOMETRY_TYPE.POINT, parts: [[[10, 20]]]}, farLine], hits: [1]},
    {name: 'constant points', mixed: false, geometries: [{type: GEOMETRY_TYPE.POINT, parts: [[[10, 20]]]}, {type: GEOMETRY_TYPE.POINT, parts: [[[500, 500]]]}], hits: [1]},
    {name: 'multipoint', mixed: false, geometries: [{type: GEOMETRY_TYPE.MULTIPOINT, parts: [[[10, 20]], [[500, 500]]]}], hits: [1]},
    {name: 'collapsed line', mixed: false, geometries: [{type: GEOMETRY_TYPE.LINESTRING, parts: [[[10, 20], [10, 20], [10, 20]]]}, farLine], hits: [1]},
    {name: 'degenerate part beside a drawable part', mixed: false,
        geometries: [{type: GEOMETRY_TYPE.MULTILINESTRING, parts: [[[10, 20], [10, 20]], [[500, 500], [600, 600]]]}], hits: [1]},
    {name: 'empty part', mixed: false, geometries: [{type: GEOMETRY_TYPE.LINESTRING, parts: [[]]}, farLine], hits: []}
] as Array<{name: string; mixed: boolean; geometries: Geometry[]; hits: number[]}>)('preserves line query parity for $name without worker materialization', async ({geometries, mixed, hits}) => {
    const tileID = new OverscaledTileID(0, 0, 0, 0, 0);
    const layerSpec: LayerSpecification = {id: 'roads', source: 'source', 'source-layer': 'road', type: 'line', paint: {'line-width': 3}};
    const data = {mvt: legacy(geometries), mlt: MLTVectorTile.fromFeatureTables([table(geometries, mixed)])};
    const results: Array<{ids: number[]; vertices: number; triangles: number}> = [];
    for (const encoding of ['mvt', 'mlt'] as const) {
        const worker = new WorkerTile({tileID, uid: encoding, source: 'source', zoom: 0, tileSize: 512, pixelRatio: 1, encoding} as WorkerTileParameters);
        const stats = createMltMaterializationStats({strict: true});
        const restore = encoding === 'mlt' ? activateMltMaterializationStats(stats) : () => {};
        let parsed: Awaited<ReturnType<WorkerTile['parse']>>;
        try {
            parsed = await worker.parse(data[encoding], new StyleLayerIndex([layerSpec]), [], {sendAsync: async () => ({})}, SubdivisionGranularitySetting.noSubdivision);
            for (const counter of stats.forbiddenCounters) expect(stats.counters[counter]).toBe(0);
            expect(stats.counters.propertyProxyMisses).toBe(0);
        } finally { restore(); }
        const index = deserialize(serialize(parsed.featureIndex)) as FeatureIndex;
        index.encoding = encoding; index.rawTileData = new ArrayBuffer(0); index.vtLayers = data[encoding].layers;
        index.sourceLayerCoder = new DictionaryCoder(['road']);
        const layer = new StyleLayerIndex([layerSpec]).familiesBySource.source.road[0][0];
        layer.recalculate(new EvaluationParameters(0), []);
        const transform = new MercatorTransform(); transform.resize(512, 512);
        const queryGeometry = [new Point(0, 0), new Point(100, 0), new Point(100, 100), new Point(0, 100), new Point(0, 0)];
        const queried = index.query({scale: 1, tileSize: 512, queryPadding: 0, queryGeometry, cameraQueryGeometry: queryGeometry,
            params: {}, transform, pixelPosMatrix: undefined, getElevation: undefined}, {roads: layer}, {roads: layerSpec}, undefined);
        results.push({ids: (queried.roads ?? []).map(item => Number(item.feature.id)).sort(),
            vertices: parsed.buckets.reduce((sum, bucket) => sum + (bucket as LineBucket).layoutVertexArray.length, 0),
            triangles: parsed.buckets.reduce((sum, bucket) => sum + (bucket as LineBucket).indexArray.length, 0)});
    }
    expect(results[0].ids).toEqual(hits);
    expect(results[1]).toEqual(results[0]);
});
