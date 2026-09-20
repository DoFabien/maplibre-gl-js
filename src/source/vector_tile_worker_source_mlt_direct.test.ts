import {readFileSync} from 'node:fs';
import {afterEach, beforeEach, expect, test} from 'vitest';
import {fakeServer, type FakeServer} from 'nise';
import {VectorTileWorkerSource} from './vector_tile_worker_source.ts';
import {StyleLayerIndex} from '../style/style_layer_index.ts';
import {CanonicalTileID, OverscaledTileID} from '../tile/tile_id.ts';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';
import {setPerformance} from '../util/test/util.ts';
import {serialize, deserialize} from '../util/web_worker_transfer.ts';
import {GeoJSONFeature} from '../util/vectortile_to_geojson.ts';
import {createConstGeometryVector, encodeFeatureTables, FeatureTable, GEOMETRY_TYPE, IntFlatVector, TopologyVector} from '@maplibre/mlt';
import {getMltFeatureTable} from './vector_tile_mlt.ts';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../util/mlt_materialization_stats.ts';

import type {LineBucket} from '../data/bucket/line_bucket.ts';
import type {WorkerTileParameters, WorkerTileWithData} from './worker_source.ts';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {FeatureIndex} from '../data/feature_index.ts';

let server: FakeServer;
beforeEach(() => { global.fetch = null; server = fakeServer.create(); setPerformance(); });
afterEach(() => server.restore());

test.each(['gzip', 'truncated'])('keeps URL and decode diagnostics for %s MLT overzoom responses', async kind => {
    const raw = kind === 'gzip' ? new Uint8Array([0x1f, 0x8b]).buffer : lineBytes(1800, 42).slice(0, -1);
    server.respondWith(request => { request.respond(200, {}, raw as any); return true; });
    const source = new VectorTileWorkerSource({sendAsync: async () => ({})}, new StyleLayerIndex([{
        id: 'line', source: 'source', 'source-layer': 'road', type: 'line', paint: {'line-width': ['get', 'width']},
    }]), []);
    const pending = source.loadTile({uid: kind, encoding: 'mlt', source: 'source', zoom: 15, tileSize: 512, pixelRatio: 1,
        tileID: new OverscaledTileID(15, 0, 15, 0, 0), subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision,
        overzoomParameters: {maxZoomTileID: new CanonicalTileID(14, 0, 0), overzoomRequest: {url: 'http://localhost/parent'}}
    } as WorkerTileParameters);
    server.respond();
    await expect(pending).rejects.toThrow(kind === 'gzip'
        ? 'Unable to parse the tile at http://localhost/parent, please make sure the data is not gzipped'
        : 'Unable to parse the tile at http://localhost/parent, got error:');
});

test.each([
    {type: 'fill', layer: 'building'}, {type: 'fill-extrusion', layer: 'building'},
    {type: 'line', layer: 'road'}, {type: 'circle', layer: 'poi_label'}, {type: 'heatmap', layer: 'poi_label'},
] as const)('preserves real MVT $type geometry buffers and queries through cold/cached MLT overzoom', async ({type, layer}) => {
    const snapshots: unknown[] = [];
    let raw: ArrayBuffer;
    server.respondWith(request => { request.respond(200, {}, raw as any); return true; });
    for (const encoding of ['mvt', 'mlt'] as const) {
        const bytes = readFileSync(`test/integration/assets/tiles/${encoding === 'mlt' ? 'mlt/gl-js/' : ''}14-8802-5374.${encoding}`);
        raw = Uint8Array.from(bytes).buffer;
        const url = `http://localhost/parent-${encoding}`;
        const layerSpec = {id: 'tested', source: 'source', 'source-layer': layer, type} as LayerSpecification;
        const source = new VectorTileWorkerSource({sendAsync: async () => ({})}, new StyleLayerIndex([layerSpec]), []);
        for (const uid of ['cold', 'cached']) {
            const stats = createMltMaterializationStats({strict: true});
            const restore = encoding === 'mlt' ? activateMltMaterializationStats(stats) : () => {};
            let result: WorkerTileWithData;
            try {
                const pending = source.loadTile({uid, encoding, source: 'source', zoom: 15, tileSize: 512, pixelRatio: 1,
                    tileID: new OverscaledTileID(15, 0, 15, 17604, 10748),
                    subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision,
                    overzoomParameters: {maxZoomTileID: new CanonicalTileID(14, 8802, 5374), overzoomRequest: {url}}
                } as WorkerTileParameters);
                server.respond(); result = await pending as WorkerTileWithData;
                for (const counter of stats.forbiddenCounters) expect(stats.counters[counter]).toBe(0);
                expect(stats.counters.propertyProxyMisses).toBe(0);
            } finally { restore(); }
            expect(result.buckets.length).toBeGreaterThan(0);
            const buffers = result.buckets.map(bucket => {
                const geometry = bucket as unknown as {layoutVertexArray: StructArray; indexArray: StructArray};
                return {vertices: arrayBytes(geometry.layoutVertexArray), indices: arrayBytes(geometry.indexArray)};
            });
            const index = deserialize(serialize(result.featureIndex)) as FeatureIndex;
            index.rawTileData = result.rawTileData; index.encoding = encoding;
            const vtLayer = index.loadVTLayers()[layer];
            expect(stats.counters.overzoomFeaturesClipped).toBe(encoding === 'mlt' && uid === 'cold' ? vtLayer.length : 0);
            const queries = Array.from({length: vtLayer.length}, (_, i) => {
                const feature = vtLayer.feature(i);
                return canonical(new GeoJSONFeature(feature, 15, 17604, 10748, feature.id).toJSON());
            });
            snapshots.push({buffers, queries: queries.map(feature => JSON.stringify(feature)).sort()});
        }
    }
    for (const snapshot of snapshots.slice(1)) expect(snapshot).toEqual(snapshots[0]);
});

test('reloads state-dependent properties and invalidates clipping when the same URL returns changed bytes', async () => {
    let raw = lineBytes(1800, 42);
    server.respondWith(request => { request.respond(200, {}, raw as any); return true; });
    const source = new VectorTileWorkerSource({sendAsync: async () => ({})}, new StyleLayerIndex([{
        id: 'line', source: 'source', 'source-layer': 'road', type: 'line', paint: {'line-width': ['get', 'width']},
    }]), []);
    const params = {uid: 'cold', encoding: 'mlt', source: 'source', zoom: 15, tileSize: 512, pixelRatio: 1,
        tileID: new OverscaledTileID(15, 0, 15, 0, 0), subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision,
        overzoomParameters: {maxZoomTileID: new CanonicalTileID(14, 0, 0), overzoomRequest: {url: 'http://localhost/parent'}}
    } as WorkerTileParameters;
    const stats = createMltMaterializationStats({strict: true}); const restore = activateMltMaterializationStats(stats);
    let changed: WorkerTileWithData;
    try {
        const pending = source.loadTile(params); server.respond();
        const first = await pending as WorkerTileWithData;
        expect(stats.counters.decodedColumns).toBe(3);
        source.layerIndex = new StyleLayerIndex([{
            id: 'line', source: 'source', 'source-layer': 'road', type: 'line',
            paint: {'line-width': ['case', ['boolean', ['feature-state', 'active'], false], ['get', 'hidden'], 1]},
        }]);
        const reloaded = await source.reloadTile(params) as WorkerTileWithData;
        expect(reloaded.rawTileData).toBeUndefined();
        expect(reloaded.featureIndex.mltOverzoom).toEqual(first.featureIndex.mltOverzoom);
        const bucket = deserialize(serialize(reloaded.buckets[0])) as LineBucket;
        const layer = source.layerIndex.familiesBySource.source.road[0][0] as typeof bucket.layers[0];
        bucket.layers = [layer]; bucket.stateDependentLayers = [layer];
        expect(bucket.programConfigurations.columnarFeatureStateData.propertyNames).toEqual(['hidden']);
        expect(bucket.programConfigurations.columnarFeatureStateData.getFeatureProvider()(0).properties.hidden).toBe(73);
        bucket.update([{id: '42', state: {active: true}}], undefined, {});
        const paint = (bucket.programConfigurations.get('line').binders['line-width'] as unknown as {paintVertexArray: StructArray}).paintVertexArray;
        const values = new Float32Array(paint.arrayBuffer, 0, paint.length * paint.bytesPerElement / 4);
        expect(values.length).toBeGreaterThan(0); expect(new Set(values)).toEqual(new Set([73]));
        raw = lineBytes(1700, 43);
        const changedPending = source.loadTile({...params, uid: 'changed'}); server.respond();
        changed = await changedPending as WorkerTileWithData;
        expect(stats.counters.overzoomFeaturesClipped).toBe(2);
        for (const counter of stats.forbiddenCounters) expect(stats.counters[counter]).toBe(0);
    } finally { restore(); }
    changed.featureIndex.rawTileData = changed.rawTileData; changed.featureIndex.encoding = 'mlt';
    const table = getMltFeatureTable(changed.featureIndex.loadVTLayers().road);
    expect(table.idVector.getValue(0)).toBe(43);
    expect(Array.from(table.geometryVector.vertexBuffer)).toEqual([3400, 20, 4224, 20]);
    expect(table.getPropertyVector('hidden').getValue(0)).toBe(73);
});

/** Encodes input fixtures only; production rendering must not encode a child tile. */
function lineBytes(x: number, id: number): ArrayBuffer {
    return encodeFeatureTables([new FeatureTable('road', createConstGeometryVector(1, GEOMETRY_TYPE.LINESTRING,
        new TopologyVector(undefined, new Uint32Array([0, 2])), undefined, new Int32Array([x, 10, 2300, 10])),
    new IntFlatVector('id', new Int32Array([id]), 1), [
        new IntFlatVector('width', new Int32Array([2]), 1), new IntFlatVector('hidden', new Int32Array([73]), 1),
    ])]);
}

type StructArray = {length: number; bytesPerElement: number; arrayBuffer: ArrayBuffer};
function arrayBytes(array: StructArray): number[] { return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement)); }
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
}
