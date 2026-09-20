import {describe, expect, test} from 'vitest';
import fs from 'node:fs';
import Point from '@mapbox/point-geometry';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {fromVectorTileJs, type VectorTileLayerLike} from '@maplibre/vt-pbf';
import {sliceFeatureTable} from '@maplibre/mlt';
import {CanonicalTileID} from '../tile/tile_id.ts';
import {getMltFeatureTable, MLTVectorTile} from './vector_tile_mlt.ts';
import {sliceVectorTileLayer} from './vector_tile_overzoomed.ts';

function singleFeatureLayer(type: 2 | 3, coordinates: number[][]): VectorTileLayerLike {
    return {
        name: 'test', version: 2, extent: 4096, length: 1,
        feature: () => ({
            type, extent: 4096, id: 42, properties: {name: 'clipped'},
            loadGeometry: () => [coordinates.map(([x, y]) => new Point(x, y))]
        })
    };
}

function coordinates(layer: VectorTileLayerLike, index = 0): number[][][] {
    return layer.feature(index).loadGeometry().map(part => part.map(({x, y}) => [x, y]));
}

describe('overzoom integer coordinates', () => {
    test.each([
        {
            name: 'split line with negative and positive fractional intersections', type: 2 as const,
            input: [[-100, -60], [200, 100], [2200, 500], [2100, 200]],
            expected: [[[-128, -82], [400, 200], [4224, 965]], [[4224, 472], [4200, 400]]]
        },
        {
            name: 'negative half-integer rounds toward positive infinity', type: 2 as const,
            input: [[-65, -1], [-61, 0]], expected: [[[-128, -1], [-122, 0]]]
        },
        {
            name: 'positive half-integer after clipping the y axis', type: 2 as const,
            input: [[0, -65], [1, -61]], expected: [[[1, -128], [2, -122]]]
        },
        {
            name: 'closed polygon', type: 3 as const,
            input: [[-100, -60], [200, 100], [200, 1000], [-100, -60]],
            expected: [[[-128, -82], [400, 200], [400, 2000], [-128, 134], [-128, -82]]]
        }
    ])('$name is identical before and after MVT encoding', ({type, input, expected}) => {
        const layer = singleFeatureLayer(type, input);
        const sliced = sliceVectorTileLayer(layer, new CanonicalTileID(14, 0, 0), new CanonicalTileID(15, 0, 0));
        const decoded = new VectorTile(new PbfReader(fromVectorTileJs({layers: {test: sliced}}))).layers.test;
        expect(coordinates(sliced)).toEqual(expected);
        expect(coordinates(decoded)).toEqual(expected);
        expect(decoded.feature(0).properties).toEqual({name: 'clipped'});
        expect(decoded.feature(0).id).toBe(42);
        expect(coordinates(layer)).toEqual([input]);
    });

    test.each([1, 2])('matches native MLT clipping across the real corpus at z+%s', dz => {
        for (const x of [8802, 8803]) for (const y of [5374, 5375]) {
            const name = `14-${x}-${y}`;
            const mvt = new VectorTile(new PbfReader(fs.readFileSync(`test/integration/assets/tiles/${name}.mvt`)));
            const raw = fs.readFileSync(`test/integration/assets/tiles/mlt/gl-js/${name}.mlt`);
            const mlt = new MLTVectorTile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
            const parent = new CanonicalTileID(14, x, y);
            const child = new CanonicalTileID(14 + dz, x * 2 ** dz + 1, y * 2 ** dz);
            for (const name of Object.keys(mvt.layers)) {
                const sliced = sliceVectorTileLayer(mvt.layers[name], parent, child);
                const native = MLTVectorTile.fromFeatureTables([sliceFeatureTable(getMltFeatureTable(mlt.layers[name]), parent, child)]).layers[name];
                const decoded = new VectorTile(new PbfReader(fromVectorTileJs({layers: {[name]: sliced}}))).layers[name];
                expect(native).toHaveLength(sliced.length);
                for (let index = 0; index < sliced.length; index++) {
                    expect(coordinates(sliced, index)).toEqual(coordinates(native, index));
                    expect(coordinates(decoded, index)).toEqual(coordinates(native, index));
                }
            }
        }
    }, 20000);
});
