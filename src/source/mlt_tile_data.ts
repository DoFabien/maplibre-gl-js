import {applyFeatureTableSlice, sliceFeatureTableGeometry, StringDictionaryVector, StringFsstDictionaryVector,
    type FeatureTable, type SlicedGeometryVector, type TileLike, type Vector} from '@maplibre/mlt';
import {getMltFeatureTable, MLTVectorTile, type MLTVectorTileOptions} from './vector_tile_mlt.ts';
import {recordMltMaterialization} from '../util/mlt_materialization_stats.ts';
import {ByteBoundedLRUCache} from '../tile/tile_cache.ts';

/** IDs are scoped to a worker/source owner; receivers must also scope them by the sending actor. */
let nextParentId = 0;

type CachedSlice = {slice: SlicedGeometryVector; byteLength: number};

/** Content lookup accelerator only: equality is always checked against the complete payload. */
export function mltPayloadKey(raw: ArrayBuffer): string {
    const words = new Uint32Array(raw, 0, raw.byteLength >>> 2);
    let hash = 2166136261;
    for (const word of words) hash = Math.imul(hash ^ word, 16777619);
    const tail = new Uint8Array(raw, words.byteLength);
    for (const byte of tail) hash = Math.imul(hash ^ byte, 16777619);
    return `mlt:${raw.byteLength}:${hash >>> 0}`;
}

/** Exact byte comparison also protects changed-URL data and non-cryptographic lookup collisions. */
export function equalMltPayload(first: ArrayBuffer, second: ArrayBuffer): boolean {
    if (first === second) return true;
    if (first.byteLength !== second.byteLength) return false;
    const a = new Uint32Array(first, 0, first.byteLength >>> 2); const b = new Uint32Array(second, 0, second.byteLength >>> 2);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    const ta = new Uint8Array(first, a.byteLength); const tb = new Uint8Array(second, b.byteLength);
    for (let i = 0; i < ta.length; i++) if (ta[i] !== tb[i]) return false;
    return true;
}

/**
 * Owns one immutable payload, lazily decoded parent columns and style-independent child plans.
 * Child columns are indexed views; resolving one style never eagerly binds another style's columns.
 * byteLength budgets backing buffers plus estimated object/string storage, not exact V8 heap.
 */
export class MltTileData {
    readonly id: number;
    readonly tile: MLTVectorTile;
    private baseBytes = 256;
    private tables = new Map<string, FeatureTable>();
    private slices: ByteBoundedLRUCache<string, CachedSlice>;
    private accounted = new WeakSet<object>();

    constructor(readonly rawData: ArrayBuffer, private readonly changed: () => void = () => {}, id?: number, maxSliceBytes: number = 8 * 1024 * 1024) {
        this.id = id ?? ++nextParentId;
        this.slices = new ByteBoundedLRUCache(maxSliceBytes, entry => entry.byteLength);
        this.tile = new MLTVectorTile(rawData, {deferPropertyColumns: true});
        this.account(rawData);
        this.baseBytes += Object.keys(this.tile.layers).reduce((sum, name) => sum + 512 + name.length * 2, 0);
    }

    get byteLength(): number { return this.baseBytes + this.slices.stats.bytes; }

    /** Resolves only requested layers and columns; clipping is reusable across styles and world copies. */
    createView(from: TileLike, to: TileLike, options: MLTVectorTileOptions = {}): MLTVectorTile {
        const layerNames = [...(options.layerNames ?? Object.keys(this.tile.layers))].filter(name => Object.hasOwn(this.tile.layers, name));
        return MLTVectorTile.fromFeatureTableResolver(layerNames, name => {
            const table = this.getTable(name);
            const columns = options.propertyColumnNamesByLayer;
            const requested = columns instanceof Map ? columns.get(name) : columns?.[name];
            const propertyNames = options.deferPropertyColumns ? new Set<string>() : requested == null ? undefined : new Set<string>(requested);
            table.materializePropertyVectors(propertyNames);
            const slice = this.getSlice(name, table, from, to);
            return applyFeatureTableSlice(table, slice, {deferProperties: true, propertyNames, columnMode: 'indexed'});
        });
    }

    private getTable(name: string): FeatureTable {
        let table = this.tables.get(name);
        if (table) return table;
        table = getMltFeatureTable(this.tile.layers[name]);
        this.tables.set(name, table);
        this.account(table.geometryVector); this.account(table.idVector);
        for (const vector of table.propertyVectors) this.accountColumn(vector);
        table.onPropertyVectorsResolved(vectors => {
            for (const vector of vectors) this.accountColumn(vector);
            this.changed();
        });
        this.baseBytes += 512 + table.availablePropertyNames.reduce((sum, key) => sum + key.length * 2 + 128, 0);
        this.changed();
        return table;
    }

    private getSlice(name: string, table: FeatureTable, from: TileLike, to: TileLike): SlicedGeometryVector {
        const scale = 2 ** (to.z - from.z);
        const key = JSON.stringify([name, scale, to.x - from.x * scale, to.y - from.y * scale]);
        const cached = this.slices.get(key);
        if (cached) return cached.slice;
        const slice = sliceFeatureTableGeometry(table, from, to);
        this.slices.set(key, {slice, byteLength: estimateMltStorage(slice, new WeakSet()) + key.length * 2 + 128});
        recordMltMaterialization('overzoomFeaturesClipped', slice.sourceIndices.length, {sourceLayerId: name});
        this.changed();
        return slice;
    }

    /** Reserves caches that string vectors allocate later, without eagerly decoding their dictionaries. */
    private accountColumn(vector: Vector): void {
        if (this.accounted.has(vector)) return;
        this.account(vector); this.baseBytes += 256;
        if (!(vector instanceof StringDictionaryVector || vector instanceof StringFsstDictionaryVector)) return;
        const bytes = vector.offset[vector.offset.length - 1];
        const count = vector.offset.length - 1;
        if (bytes <= 1024 * 1024 && count <= 65536) this.baseBytes += count * 40 + bytes * 2;
        if (vector instanceof StringFsstDictionaryVector) this.baseBytes += bytes + estimateMltStorage(vector, new WeakSet());
    }

    /** Visits newly allocated numeric/vector objects once; shared buffers are charged once per parent. */
    private account(value: unknown): void {
        this.baseBytes += estimateMltStorage(value, this.accounted);
    }
}

/** Estimates object slots and strings while charging each retained backing buffer only once. */
function estimateMltStorage(value: unknown, seen: WeakSet<object>): number {
    if (typeof value === 'string') return value.length * 2 + 16;
    if (!value || typeof value !== 'object' || seen.has(value)) return 0;
    seen.add(value);
    if (ArrayBuffer.isView(value)) return 64 + estimateMltStorage(value.buffer, seen);
    if (value instanceof ArrayBuffer) return value.byteLength + 32;
    return Object.values(value).reduce<number>((sum, item) => sum + 8 + estimateMltStorage(item, seen), 64);
}
