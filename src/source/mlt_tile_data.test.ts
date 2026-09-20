import {expect, test} from 'vitest';
import {createConstGeometryVector, encodeFeatureTables, FeatureTable, GEOMETRY_TYPE, IntFlatVector, TopologyVector} from '@maplibre/mlt';
import {MltTileData, mltPayloadKey, equalMltPayload} from './mlt_tile_data.ts';
import {MltParentRegistry} from './mlt_parent_registry.ts';
import {getMltFeatureTable} from './vector_tile_mlt.ts';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../util/mlt_materialization_stats.ts';
import {ByteBoundedLRUCache} from '../tile/tile_cache.ts';

test('shares decoded parent and clipping while projecting each style independently', () => {
    const raw = parentBytes();
    const parent = new MltTileData(raw);
    const from = {z: 0, x: 0, y: 0}; const to = {z: 1, x: 0, y: 0};
    const stats = createMltMaterializationStats({strict: true}); const restore = activateMltMaterializationStats(stats);
    try {
        const first = getMltFeatureTable(parent.createView(from, to, {propertyColumnNamesByLayer: {places: ['width']}}).layers.places);
        const second = getMltFeatureTable(parent.createView(from, to, {propertyColumnNamesByLayer: {places: ['height']}}).layers.places);
        expect(first.geometryVector).toBe(second.geometryVector);
        expect(first.propertyVectors.map(vector => vector.name)).toEqual(['width']);
        expect(second.propertyVectors.map(vector => vector.name)).toEqual(['height']);
        expect(first.getPropertyVector('height').getValue(0)).toBe(8);
        expect(stats.counters).toMatchObject({decodedLayers: 1, decodedColumns: 4, overzoomFeaturesClipped: 1});
        const lazy = getMltFeatureTable(parent.createView(from, to, {deferPropertyColumns: true}).layers.places);
        expect(lazy.propertyVectors).toEqual([]);
        expect(lazy.getPropertyVector('unused').getValue(0)).toBe(200);
        expect(stats.counters.decodedColumns).toBe(5);
        for (const key of stats.forbiddenCounters) expect(stats.counters[key]).toBe(0);
    } finally { restore(); }
});

test('bounds growing parent/plan caches without resurrecting evicted parents', () => {
    const raw = parentBytes(); const cache = new ByteBoundedLRUCache<string, MltTileData>(raw.byteLength + 1000, parent => parent.byteLength);
    const parent = new MltTileData(raw, () => cache.refresh('parent', parent), undefined, 0);
    cache.set('parent', parent);
    expect(cache.get('parent')).toBe(parent);
    const initialBytes = parent.byteLength;
    const first = getMltFeatureTable(parent.createView({z: 0, x: 0, y: 0}, {z: 1, x: 0, y: 0}).layers.places);
    const second = getMltFeatureTable(parent.createView({z: 0, x: 0, y: 0}, {z: 1, x: 0, y: 0}).layers.places);
    expect(first.geometryVector).not.toBe(second.geometryVector);
    expect(parent.byteLength).toBeGreaterThan(initialBytes);
    expect(cache.stats).toMatchObject({entries: 0, bytes: 0, evictions: 1});
    cache.refresh('parent', parent);
    expect(cache.stats.entries).toBe(0);
});

test('uses exact payload equality and actor-scoped parent references across eviction and directory clearing', () => {
    const raw = parentBytes(); const copy = raw.slice(0); const changed = raw.slice(0);
    new Uint8Array(changed)[changed.byteLength - 1] ^= 1;
    expect(mltPayloadKey(copy)).toBe(mltPayloadKey(raw));
    expect(equalMltPayload(raw, copy)).toBe(true);
    expect(equalMltPayload(raw, changed)).toBe(false);
    expect(equalMltPayload(raw, new ArrayBuffer(0))).toBe(false);
    const actor = {sendAsync: async () => undefined}; const other = {sendAsync: async () => undefined};
    const registry = new MltParentRegistry();
    const first = registry.receive(actor, 'first', 1, raw);
    expect(registry.receive(other, 'first', 99, copy).data).toBe(first.data);
    expect(registry.get(other, 'first').id).toBe(99);
    expect(registry.receive(actor, 'second', 1, undefined, first).data).toBe(first.data);
    expect(() => registry.receive(actor, 'first', 1, changed)).toThrow('version changed');
    expect(() => registry.receive(other, 'absent', 1)).toThrow('Missing retained');
    for (let i = 0; i < 257; i++) registry.receive(actor, `key-${i}`, i + 10, copy);
    expect(registry.get(actor, 'first')).toBeUndefined();
    registry.clear();
    expect(registry.receive(actor, 'held-by-request', 1, undefined, first).data).toBe(first.data);
});

function parentBytes(): ArrayBuffer {
    return encodeFeatureTables([new FeatureTable('places', createConstGeometryVector(2, GEOMETRY_TYPE.POINT,
        new TopologyVector(undefined, new Uint32Array([0, 1, 2])), undefined, new Int32Array([3000, 3000, 100, 100])),
    new IntFlatVector('id', new Int32Array([41, 42]), 2), [
        new IntFlatVector('width', new Int32Array([1, 2]), 2), new IntFlatVector('height', new Int32Array([7, 8]), 2),
        new IntFlatVector('unused', new Int32Array([100, 200]), 2),
    ])]);
}
