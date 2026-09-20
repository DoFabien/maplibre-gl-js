import {describe, test, expect} from 'vitest';
import {TileCache, BoundedLRUCache, ByteBoundedLRUCache} from './tile_cache.ts';
import {OverscaledTileID} from './tile_id.ts';

import type {Tile} from './tile.ts';

const idA = new OverscaledTileID(10, 0, 10, 0, 1);
const idB = new OverscaledTileID(10, 0, 10, 0, 2);
const idC = new OverscaledTileID(10, 0, 10, 0, 3);
const idD = new OverscaledTileID(10, 0, 10, 0, 4);
const tileA = {tileID: idA} as Tile;
const tileA2 = {tileID: idA} as Tile;
const tileB = {tileID: idB} as Tile;
const tileC = {tileID: idC} as Tile;
const tileD = {tileID: idD} as Tile;

function keysExpected(cache, ids) {
    expect(cache.order).toEqual(ids.map((id) => id.key));
}
describe('TileCache', () => {
    test('complex flow', () => {
        const cache = new TileCache(10, (removed) => {
            expect(removed).toBe('dc');
        });
        expect(cache.getAndRemove(idC)).toBeNull();
        expect(cache.add(idA, tileA)).toBe(cache);
        keysExpected(cache, [idA]);
        expect(cache.has(idA)).toBe(true);
        expect(cache.getAndRemove(idA)).toBe(tileA);
        expect(cache.getAndRemove(idA)).toBeNull();
        expect(cache.has(idA)).toBe(false);
        keysExpected(cache, []);
    });

    test('get without removing', () => {
        const cache = new TileCache(10, () => {
            throw new Error('test "get without removing" failed');
        });
        expect(cache.add(idA, tileA)).toBe(cache);
        expect(cache.get(idA)).toBe(tileA);
        keysExpected(cache, [idA]);
        expect(cache.get(idA)).toBe(tileA);
    });

    test('duplicate add', () => {
        const cache = new TileCache(10, () => {
            throw new Error('test "duplicate add" failed');
        });
        cache.add(idA, tileA);
        cache.add(idA, tileA2);

        keysExpected(cache, [idA, idA]);
        expect(cache.has(idA)).toBeTruthy();
        expect(cache.getAndRemove(idA)).toBe(tileA);
        expect(cache.has(idA)).toBeTruthy();
        expect(cache.getAndRemove(idA)).toBe(tileA2);
    });

    test('expiry', () => {
        const cache = new TileCache(10, (removed) => {
            expect(cache.has(idB)).toBeTruthy();
            expect(removed).toBe(tileA2);
        });

        cache.add(idB, tileB, 0);
        cache.getAndRemove(idB);
        // removing clears the expiry timeout
        cache.add(idB, null);

        cache.add(idA, tileA);
        cache.add(idA, tileA2, 0); // expires immediately and `onRemove` is called.
    });

    test('remove', () => {
        const cache = new TileCache(10, () => {});

        cache.add(idA, tileA);
        cache.add(idB, tileB);
        cache.add(idC, tileC);

        keysExpected(cache, [idA, idB, idC]);
        expect(cache.has(idB)).toBeTruthy();

        cache.remove(idB);

        keysExpected(cache, [idA, idC]);
        expect(cache.has(idB)).toBeFalsy();

        expect(cache.remove(idB)).toBeTruthy();

    });

    test('overflow', () => {
        const cache = new TileCache(1, (removed) => {
            expect(removed).toBe(tileA);
        });
        cache.add(idA, tileA);
        cache.add(idB, tileB);

        expect(cache.has(idB)).toBeTruthy();
        expect(cache.has(idA)).toBeFalsy();
    });

    test('.reset', () => {
        let called;
        const cache = new TileCache(10, (removed) => {
            expect(removed).toBe(tileA);
            called = true;
        });
        cache.add(idA, tileA);
        expect(cache.reset()).toBe(cache);
        expect(cache.has(idA)).toBe(false);
        expect(called).toBeTruthy();
    });

    test('.setMaxSize', () => {
        let numRemoved = 0;
        const cache = new TileCache(10, () => {
            numRemoved++;
        });
        cache.add(idA, tileA);
        cache.add(idB, tileB);
        cache.add(idC, tileC);
        expect(numRemoved).toBe(0);
        cache.setMaxSize(15);
        expect(numRemoved).toBe(0);
        cache.setMaxSize(1);
        expect(numRemoved).toBe(2);
        cache.add(idD, tileD);
        expect(numRemoved).toBe(3);
    });
});

describe('BoundedLRUCache', () => {
    test('evicts least-recently-used item when capacity exceeded', () => {
        const cache = new BoundedLRUCache<string, number>(2);

        cache.set('a', 1);
        cache.set('b', 2);

        // Access 'a' to make it most-recently-used
        expect(cache.get('a')).toBe(1);

        // Insert 'c' -> should evict 'b' (the least recently used)
        cache.set('c', 3);

        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('a')).toBe(1);
        expect(cache.get('c')).toBe(3);
    });

    test('setting an existing key updates value and makes it most-recently-used', () => {
        const cache = new BoundedLRUCache<string, number>(2);

        cache.set('a', 1);
        cache.set('b', 2);

        // Update 'a' value and it should become most-recently-used
        cache.set('a', 10);
        // Insert 'c' -> should evict 'b'
        cache.set('c', 3);

        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('a')).toBe(10);
        expect(cache.get('c')).toBe(3);
    });

    test('capacity 1 evicts previous entry on new set', () => {
        const cache = new BoundedLRUCache<string, string>(1);

        cache.set('x', 'first');
        expect(cache.get('x')).toBe('first');

        cache.set('y', 'second');
        expect(cache.get('x')).toBeUndefined();
        expect(cache.get('y')).toBe('second');
    });

    test('clear removes all entries', () => {
        const cache = new BoundedLRUCache<number, string>(3);
        cache.set(1, 'one');
        cache.set(2, 'two');

        expect(cache.get(1)).toBe('one');
        expect(cache.get(2)).toBe('two');

        cache.clear();

        expect(cache.get(1)).toBeUndefined();
        expect(cache.get(2)).toBeUndefined();
    });
});

describe('ByteBoundedLRUCache', () => {
    test('evicts least-recently-used values until the byte budget is met', () => {
        const cache = new ByteBoundedLRUCache<string, Uint8Array>(10, (value) => value.byteLength);
        cache.set('a', new Uint8Array(4));
        cache.set('b', new Uint8Array(4));
        expect(cache.get('a')).toHaveLength(4);

        cache.set('c', new Uint8Array(5));

        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('a')).toHaveLength(4);
        expect(cache.get('c')).toHaveLength(5);
        expect(cache.stats).toEqual({hits: 3, misses: 1, evictions: 1, bytes: 9, entries: 2});
    });

    test('updates retained bytes when replacing an entry', () => {
        const cache = new ByteBoundedLRUCache<string, Uint8Array>(10, (value) => value.byteLength);
        cache.set('a', new Uint8Array(8));
        cache.set('a', new Uint8Array(3));
        cache.set('b', new Uint8Array(7));

        expect(cache.stats).toEqual({hits: 0, misses: 0, evictions: 0, bytes: 10, entries: 2});
        expect(cache.get('a')).toHaveLength(3);
        expect(cache.get('b')).toHaveLength(7);
    });

    test('does not retain a value larger than the entire budget', () => {
        const cache = new ByteBoundedLRUCache<string, Uint8Array>(4, (value) => value.byteLength);
        cache.set('oversized', new Uint8Array(5));

        expect(cache.get('oversized')).toBeUndefined();
        expect(cache.stats).toEqual({hits: 0, misses: 1, evictions: 1, bytes: 0, entries: 0});
    });

    test('clears retained values while keeping cumulative metrics', () => {
        const cache = new ByteBoundedLRUCache<string, Uint8Array>(4, (value) => value.byteLength);
        cache.set('a', new Uint8Array(4));
        expect(cache.get('a')).toHaveLength(4);
        cache.clear();

        expect(cache.stats).toEqual({hits: 1, misses: 0, evictions: 0, bytes: 0, entries: 0});
    });

    test('rejects invalid budgets and value sizes', () => {
        expect(() => new ByteBoundedLRUCache<string, string>(-1, (value) => value.length)).toThrow(RangeError);
        const cache = new ByteBoundedLRUCache<string, string>(10, () => Number.NaN);
        expect(() => cache.set('a', 'value')).toThrow(RangeError);
    });
});
