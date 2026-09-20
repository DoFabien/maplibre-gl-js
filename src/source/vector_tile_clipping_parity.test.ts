import {expect, test, vi} from 'vitest';
import Point from '@mapbox/point-geometry';
import {createConstGeometryVector, FeatureTable, GEOMETRY_TYPE, sliceFeatureTableGeometry, TopologyVector} from '@maplibre/mlt';
import {CanonicalTileID} from '../tile/tile_id.ts';
import {sliceVectorTileLayer} from './vector_tile_overzoomed.ts';

test.each([false, true])('preserves MVT clipping order and rounding with indexed vertices=%s', indexed => {
    const lines = [
        [[-65, -1], [-61, 0]], [[0, -65], [1, -61]],
        [[-64, -64], [-64, 2112], [2112, 2112], [2112, -64]],
        [[-100, -100], [2300, 2400], [-200, 2000], [200, -200], [100, 100]],
        [[-65, 0], [-64, 0], [-65, 1]], [[2113, 0], [2112, 0], [2113, 1]],
        [[0, 0], [0, 0]], [[5000, 5000]], [[0, 0]],
    ];
    expectClippingParity(2, lines, indexed);
    expectClippingParity(1, lines.flat().map(point => [point]), indexed);
    expectClippingParity(3, [
        [[-100, -100], [2200, -100], [2200, 2200], [-100, 2200]],
        [[100, 100], [100, 400], [400, 400], [400, 100]],
        [[1900, 1900], [1900, 2400], [2400, 2400], [2400, 1900]],
    ], indexed);
});

test('matches MVT for deterministic multipart paths crossing both clipping axes', () => {
    let seed = 0x5a17;
    function next(): number { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; }
    for (let sample = 0; sample < 160; sample++) {
        const parts = Array.from({length: 1 + next() % 3}, () => Array.from({length: 3 + next() % 12}, () =>
            [Number(next() % 3200) - 600, Number(next() % 3200) - 600]));
        expectClippingParity(sample % 2 ? 2 : 3, parts, sample % 3 === 0);
    }
});

/** Builds identical numeric MLT and legacy MVT inputs; only the public result may materialize geometry. */
function expectClippingParity(type: 1 | 2 | 3, parts: number[][][], indexed: boolean): void {
    const offsets = [0];
    for (const part of parts) offsets.push(offsets[offsets.length - 1] + part.length);
    const points = parts.flat();
    const vertices = new Int32Array((indexed ? points.toReversed() : points).flat());
    const vertexOffsets = indexed ? Uint32Array.from(points, (_, i) => points.length - 1 - i) : undefined;
    const geometryType = type === 3 ? GEOMETRY_TYPE.POLYGON : type === 2 ? GEOMETRY_TYPE.MULTILINESTRING : GEOMETRY_TYPE.MULTIPOINT;
    const topology = new TopologyVector(new Uint32Array([0, type === 3 ? 1 : parts.length]),
        new Uint32Array(type === 3 ? [0, parts.length] : offsets), type === 3 ? new Uint32Array(offsets) : undefined);
    const geometry = createConstGeometryVector(1, geometryType, topology, vertexOffsets, vertices);
    const saved = vertices.slice();
    vi.spyOn(geometry, 'getGeometries').mockImplementation(() => { throw new Error('Input geometry materialized'); });
    const parent = new CanonicalTileID(14, 0, 0); const child = new CanonicalTileID(15, 0, 0);
    const sliced = sliceFeatureTableGeometry(new FeatureTable('test', geometry), parent, child);
    const legacy = sliceVectorTileLayer({name: 'test', version: 2, extent: 4096, length: 1,
        feature: () => ({type, extent: 4096, id: 42, properties: {}, loadGeometry: () => parts.map(part => {
            const ring = part.map(([x, y]) => new Point(x, y));
            if (type === 3) ring.push(ring[0].clone());
            return ring;
        })})}, parent, child);
    const expected = Array.from({length: legacy.length}, (_, i) => legacy.feature(i).loadGeometry());
    expect(JSON.stringify(sliced.geometryVector.getGeometries())).toBe(JSON.stringify(expected));
    expect(Array.from(sliced.sourceIndices)).toEqual(legacy.length ? [0] : []);
    expect(vertices).toEqual(saved);
    expect(geometry.getGeometries).not.toHaveBeenCalled();
}
