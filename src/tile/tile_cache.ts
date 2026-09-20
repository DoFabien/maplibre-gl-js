import type {OverscaledTileID} from './tile_id.ts';
import type {Tile} from './tile.ts';

/**
 * @internal
 * A [least-recently-used cache](https://en.wikipedia.org/wiki/Cache_algorithms)
 * with hash lookup made possible by keeping a list of keys in parallel to
 * an array of dictionary of values
 *
 * TileManager offloads currently unused tiles to this cache, and when a tile gets used again,
 * it is also removed from this cache. Thus addition is the only operation that counts as "usage"
 * for the purposes of LRU behaviour.
 */
export class TileCache {
    max: number;
    data: {
        [key: string]: Array<{
            value: Tile;
            timeout: ReturnType<typeof setTimeout>;
        }>;
    };
    order: string[];
    onRemove: (element: Tile) => void;
    /**
     * @param max - number of permitted values
     * @param onRemove - callback called with items when they expire
     */
    constructor(max: number, onRemove: (element: Tile) => void) {
        this.max = max;
        this.onRemove = onRemove;
        this.reset();
    }

    /**
     * Clear the cache
     *
     * @returns this cache
     */
    reset(): this {
        for (const key in this.data) {
            for (const removedData of this.data[key]) {
                if (removedData.timeout) clearTimeout(removedData.timeout);
                this.onRemove(removedData.value);
            }
        }

        this.data = {};
        this.order = [];

        return this;
    }

    /**
     * Add a key, value combination to the cache, trimming its size if this pushes
     * it over max length.
     *
     * @param tileID - lookup key for the item
     * @param data - tile data
     *
     * @returns this cache
     */
    add(tileID: OverscaledTileID, data: Tile, expiryTimeout: number | void): this {
        const key = tileID.wrapped().key;
        if (this.data[key] === undefined) {
            this.data[key] = [];
        }

        const dataWrapper = {
            value: data,
            timeout: undefined
        };

        if (expiryTimeout !== undefined) {
            dataWrapper.timeout = setTimeout(() => {
                this.remove(tileID, dataWrapper);
            }, expiryTimeout as number);
        }

        this.data[key].push(dataWrapper);
        this.order.push(key);

        if (this.order.length > this.max) {
            const removedData = this._getAndRemoveByKey(this.order[0]);
            if (removedData) this.onRemove(removedData);
        }

        return this;
    }

    /**
     * Determine whether the value attached to `key` is present
     *
     * @param tileID - the key to be looked-up
     * @returns whether the cache has this value
     */
    has(tileID: OverscaledTileID): boolean {
        return tileID.wrapped().key in this.data;
    }

    /**
     * Get the value attached to a specific key and remove data from cache.
     * If the key is not found, returns `null`
     *
     * @param tileID - the key to look up
     * @returns the tile data, or null if it isn't found
     */
    getAndRemove(tileID: OverscaledTileID): Tile {
        if (!this.has(tileID)) { return null; }
        return this._getAndRemoveByKey(tileID.wrapped().key);
    }

    /*
     * Get and remove the value with the specified key.
     */
    _getAndRemoveByKey(key: string): Tile {
        const data = this.data[key].shift();
        if (data.timeout) clearTimeout(data.timeout);

        if (this.data[key].length === 0) {
            delete this.data[key];
        }
        this.order.splice(this.order.indexOf(key), 1);

        return data.value;
    }

    /*
     * Get the value with the specified (wrapped tile) key.
     */
    getByKey(key: string): Tile {
        const data = this.data[key];
        return data ? data[0].value : null;
    }

    /**
     * Get the value attached to a specific key without removing data
     * from the cache. If the key is not found, returns `null`
     *
     * @param tileID - the key to look up
     * @returns the tile data, or null if it isn't found
     */
    get(tileID: OverscaledTileID): Tile {
        if (!this.has(tileID)) { return null; }

        const data = this.data[tileID.wrapped().key][0];
        return data.value;
    }

    /**
     * Remove a key/value combination from the cache.
     *
     * @param tileID - the key for the pair to delete
     * @param value - If a value is provided, remove that exact version of the value.
     * @returns this cache
     */
    remove(tileID: OverscaledTileID, value?: {
        value: Tile;
        timeout: ReturnType<typeof setTimeout>;
    }): this {
        if (!this.has(tileID)) { return this; }
        const key = tileID.wrapped().key;

        const dataIndex = value === undefined ? 0 : this.data[key].indexOf(value);
        const data = this.data[key][dataIndex];
        this.data[key].splice(dataIndex, 1);
        if (data.timeout) clearTimeout(data.timeout);
        if (this.data[key].length === 0) {
            delete this.data[key];
        }
        this.onRemove(data.value);
        this.order.splice(this.order.indexOf(key), 1);

        return this;
    }

    /**
     * Change the max size of the cache.
     *
     * @param max - the max size of the cache
     * @returns this cache
     */
    setMaxSize(max: number): this {
        this.max = max;

        while (this.order.length > this.max) {
            const removedData = this._getAndRemoveByKey(this.order[0]);
            if (removedData) this.onRemove(removedData);
        }

        return this;
    }

    /**
     * Remove entries that do not pass a filter function. Used for removing
     * stale tiles from the cache.
     *
     * @param filterFn - Determines whether the tile is filtered. If the supplied function returns false, the tile will be filtered out.
     */
    filter(filterFn: (tile: Tile) => boolean): void {
        const removed = [];
        for (const key in this.data) {
            for (const entry of this.data[key]) {
                if (!filterFn(entry.value)) {
                    removed.push(entry);
                }
            }
        }
        for (const r of removed) {
            this.remove(r.value.tileID, r);
        }
    }
}

export class BoundedLRUCache<K, V> {
    private maxEntries: number;
    private map: Map<K, V>;

    constructor(maxEntries: number) {
        this.maxEntries = maxEntries;
        this.map = new Map();
    }

    get(key: K): V | undefined {
        const value = this.map.get(key);
        if (value !== undefined) {
            // Move key to end (most recently used)
            this.map.delete(key);
            this.map.set(key, value);
        }
        return value;
    }

    set(key: K, value: V): void {
        if (this.map.has(key)) {
            this.map.delete(key);
        } else if (this.map.size >= this.maxEntries) {
            // Delete oldest
            const oldestKey = this.map.keys().next().value;
            this.map.delete(oldestKey);
        }
        this.map.set(key, value);
    }

    clear(): void {
        this.map.clear();
    }
}

export type ByteBoundedLRUCacheStats = {
    hits: number;
    misses: number;
    evictions: number;
    bytes: number;
    entries: number;
};

/**
 * LRU cache whose retained values are bounded by an explicit byte budget.
 * The byte-size callback must account for all memory retained by a value.
 */
export class ByteBoundedLRUCache<K, V> {
    private map = new Map<K, {value: V; bytes: number}>();
    private currentBytes = 0;
    private hitCount = 0;
    private missCount = 0;
    private evictionCount = 0;

    constructor(
        readonly maxBytes: number,
        private readonly byteSize: (value: V) => number,
    ) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
            throw new RangeError(`Cache byte budget must be a non-negative safe integer, got ${maxBytes}`);
        }
    }

    get(key: K): V | undefined {
        const entry = this.map.get(key);
        if (!entry) {
            this.missCount++;
            return undefined;
        }

        this.hitCount++;
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.value;
    }

    set(key: K, value: V): void {
        const bytes = this.byteSize(value);
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
            throw new RangeError(`Cached value size must be a non-negative safe integer, got ${bytes}`);
        }

        const previous = this.map.get(key);
        if (previous) {
            this.currentBytes -= previous.bytes;
            this.map.delete(key);
        }

        this.map.set(key, {value, bytes});
        this.currentBytes += bytes;
        while (this.currentBytes > this.maxBytes && this.map.size > 0) {
            const oldestKey = this.map.keys().next().value as K;
            const evicted = this.map.get(oldestKey);
            this.map.delete(oldestKey);
            this.currentBytes -= evicted.bytes;
            this.evictionCount++;
        }
    }

    clear(): void {
        this.map.clear();
        this.currentBytes = 0;
    }

    /** Reaccounts a growing cached value without resurrecting an entry already evicted or replaced. */
    refresh(key: K, value: V): void {
        if (this.map.get(key)?.value === value) this.set(key, value);
    }

    get stats(): ByteBoundedLRUCacheStats {
        return {
            hits: this.hitCount,
            misses: this.missCount,
            evictions: this.evictionCount,
            bytes: this.currentBytes,
            entries: this.map.size,
        };
    }
}
