import {afterEach, beforeEach, expect, test} from 'vitest';
import {fakeServer, type FakeServer} from 'nise';
import {createConstGeometryVector, encodeFeatureTables, FeatureTable, GEOMETRY_TYPE, IntFlatVector, TopologyVector} from '@maplibre/mlt';
import {VectorTileSource} from './vector_tile_source.ts';
import {VectorTileWorkerSource} from './vector_tile_worker_source.ts';
import {StyleLayerIndex} from '../style/style_layer_index.ts';
import {Tile} from '../tile/tile.ts';
import {OverscaledTileID} from '../tile/tile_id.ts';
import {RequestManager} from '../util/request_manager.ts';
import {MessageType} from '../util/actor_messages.ts';
import {serialize, deserialize} from '../util/web_worker_transfer.ts';
import {SubdivisionGranularitySetting} from '../render/subdivision_granularity_settings.ts';
import {setPerformance, waitForMetadataEvent} from '../util/test/util.ts';
import {getMltFeatureTable} from './vector_tile_mlt.ts';

import type {WorkerTileWithData} from './worker_source.ts';

let server: FakeServer;
beforeEach(() => { global.fetch = null; setPerformance(); server = fakeServer.create(); server.autoRespond = true; server.autoRespondAfter = 0; });
afterEach(() => server.restore());

test('shares parent query data across public source loads, omits acknowledged bytes and preserves old versions', async () => {
    let raw = lineBytes(42);
    server.respondWith(request => { request.respond(200, {}, raw as any); return true; });
    const layers = new StyleLayerIndex([{id: 'line', type: 'line', source: 'source', 'source-layer': 'roads', paint: {'line-width': ['get', 'width']}}]);
    const worker = new VectorTileWorkerSource({sendAsync: async () => ({})}, layers, []);
    const wires = [];
    const actor = {sendAsync: async ({type, data}) => {
        if (type === MessageType.removeTile) return worker.removeTile(data);
        const result = (type === MessageType.reloadTile ? await worker.reloadTile(data) : await worker.loadTile(data)) as WorkerTileWithData;
        wires.push({known: data.mltParentId, id: result.mltParentId, bytes: result.rawTileData?.byteLength ?? 0});
        const transferables: Transferable[] = [];
        const encoded = serialize(result, transferables);
        return deserialize(structuredClone(encoded, {transfer: [...new Set(transferables)]}));
    }};
    const source = new VectorTileSource('source', {type: 'vector', encoding: 'mlt', maxzoom: 14,
        tiles: ['http://localhost/{z}-{x}-{y}.mlt']}, {waitForInitComplete: async () => {}, getReadyActor: () => actor} as any, undefined);
    source.onAdd({_requestManager: new RequestManager(), getPixelRatio: () => 1, _zoomLevelsToOverscale: [1],
        style: {projection: {subdivisionGranularity: SubdivisionGranularitySetting.noSubdivision}},
        painter: {style: {hasLayer: () => true, getLayer: () => layers.familiesBySource.source.roads[0][0]}},
    } as any);
    await waitForMetadataEvent(source);
    const first = new Tile(new OverscaledTileID(15, 0, 15, 0, 0), 512);
    const same = new Tile(new OverscaledTileID(15, 0, 15, 0, 0), 512);
    const sibling = new Tile(new OverscaledTileID(15, 0, 15, 1, 0), 512);
    await source.loadTile(first); await source.loadTile(same); await source.loadTile(sibling);
    expect(wires.map(wire => wire.bytes)).toEqual([raw.byteLength, 0, 0]);
    expect(first.latestRawTileData).toBe(same.latestRawTileData);
    expect(first.latestFeatureIndex.mltTileData).toBe(sibling.latestFeatureIndex.mltTileData);
    const firstTable = getMltFeatureTable(first.latestFeatureIndex.loadVTLayers().roads);
    const siblingTable = getMltFeatureTable(sibling.latestFeatureIndex.loadVTLayers().roads);
    expect(firstTable.idVector.getValue(0)).toBe(42);
    expect(siblingTable.idVector.getValue(0)).toBe(43);
    expect(siblingTable.getPropertyVector('hidden').getValue(0)).toBe(74);
    await source.loadTile(first);
    expect(first.latestFeatureIndex.mltTileData).toBe(sibling.latestFeatureIndex.mltTileData);
    raw = lineBytes(100);
    const changed = new Tile(new OverscaledTileID(15, 0, 15, 0, 0), 512);
    await source.loadTile(changed);
    expect(wires.at(-1).bytes).toBe(raw.byteLength);
    expect(changed.latestFeatureIndex.mltTileData).not.toBe(first.latestFeatureIndex.mltTileData);
    expect(getMltFeatureTable(changed.latestFeatureIndex.loadVTLayers().roads).idVector.getValue(0)).toBe(100);
    expect(getMltFeatureTable(first.latestFeatureIndex.loadVTLayers().roads).idVector.getValue(0)).toBe(42);
    await source.unloadTile(first); await source.unloadTile(same); await source.unloadTile(sibling); await source.unloadTile(changed);
    source.onRemove();
});

function lineBytes(id: number): ArrayBuffer {
    return encodeFeatureTables([new FeatureTable('roads', createConstGeometryVector(2, GEOMETRY_TYPE.LINESTRING,
        new TopologyVector(undefined, new Uint32Array([0, 2, 4])), undefined, new Int32Array([100, 10, 1400, 10, 2500, 10, 4000, 10])),
    new IntFlatVector('id', new Int32Array([id, id + 1]), 2), [
        new IntFlatVector('width', new Int32Array([2, 3]), 2), new IntFlatVector('hidden', new Int32Array([73, 74]), 2),
    ])]);
}
