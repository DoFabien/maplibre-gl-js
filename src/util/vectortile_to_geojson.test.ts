import {describe, expect, test, vi} from 'vitest';
import fs from 'node:fs';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {
    BitVector,
    createConstGeometryVector,
    createStringFlatVector,
    FeatureTable,
    GEOMETRY_TYPE,
    IntFlatVector,
    TopologyVector,
    type Vector,
} from '@maplibre/mlt';
import {GeoJSONFeature} from './vectortile_to_geojson.ts';
import {JSON_PREFIX} from './util.ts';
import {activateMltMaterializationStats, createMltMaterializationStats} from './mlt_materialization_stats.ts';
import {getMltFeatureTable, MLTVectorTile} from '../source/vector_tile_mlt.ts';

function pointTable(columns: Vector[]): FeatureTable {
    return new FeatureTable(
        'points',
        createConstGeometryVector(2, GEOMETRY_TYPE.POINT, new TopologyVector(null, null, null), null, new Int32Array([1024, 1024, 2048, 2048])),
        undefined,
        columns,
    );
}

describe('direct columnar GeoJSON properties', () => {
    test('keeps properties lazy and creates plain values without per-property descriptors', () => {
        const names = createStringFlatVector(['first', 'second'], 'name');
        const readName = vi.spyOn(names, 'getValue');
        const table = pointTable([
            names,
            new IntFlatVector('zero', new Int32Array([0, 0]), 2),
            new IntFlatVector('optional', new Int32Array([0, 2]), new BitVector(new Uint8Array([2]), 2)),
        ]);
        const resolveColumns = vi.spyOn(table, 'materializePropertyVectors');
        const stats = createMltMaterializationStats();
        const deactivate = activateMltMaterializationStats(stats);
        try {
            const first = GeoJSONFeature.fromFeatureTable(table, 0, 0, 0, 0, 1);
            const second = GeoJSONFeature.fromFeatureTable(table, 1, 0, 0, 0, 2);
            expect(Object.keys(first)).toContain('properties');
            expect(Object.getOwnPropertyDescriptor(first, 'properties')?.get).toBeTypeOf('function');
            expect(readName).not.toHaveBeenCalled();
            expect(resolveColumns).not.toHaveBeenCalled();
            expect(stats.counters.propertyObjects).toBe(0);

            expect(first.properties).toEqual({name: 'first', zero: 0});
            expect(second.properties).toEqual({name: 'second', optional: 2, zero: 0});
            expect(resolveColumns).toHaveBeenCalledTimes(1);
            expect(readName).toHaveBeenCalledTimes(2);
            expect(Object.getOwnPropertyDescriptor(first.properties, 'name')).toEqual({
                value: 'first', enumerable: true, configurable: true, writable: true,
            });
            expect(first.properties).toBe(first.properties);
            expect(stats.counters.propertyObjects).toBe(2);
            expect(stats.counters.propertyDescriptors).toBe(0);
            expect(stats.counters.vectorTileFeatureWrappers).toBe(0);
            expect(stats.counters.geometryPartsMaterialized).toBe(0);
            expect(stats.counters.pointObjects).toBe(0);
        } finally {
            deactivate();
        }
    });

    test('parses JSON values once per output and preserves independent mutable graphs', () => {
        const table = pointTable([
            createStringFlatVector([`${JSON_PREFIX}{"items":[1,2]}`, `${JSON_PREFIX}{"items":[3]}`], 'metadata'),
        ]);
        const first = GeoJSONFeature.fromFeatureTable(table, 0, 0, 0, 0, 1);
        const another = GeoJSONFeature.fromFeatureTable(table, 0, 0, 0, 0, 1);
        const properties = first.properties;
        expect(properties.metadata).toEqual({items: [1, 2]});
        expect(properties.metadata).toBe(properties.metadata);
        properties.metadata.items.push(4);
        expect(another.properties.metadata).toEqual({items: [1, 2]});
        delete properties.metadata;
        properties.custom = 'local';
        expect(first.properties).toEqual({custom: 'local'});
        expect(another.properties).not.toHaveProperty('custom');
        expect(JSON.parse(JSON.stringify(another)).properties).toEqual({metadata: {items: [1, 2]}});
    });

    test('preserves prototype-like column names as own writable data properties', () => {
        const table = pointTable([
            createStringFlatVector([`${JSON_PREFIX}{"value":1}`, 'plain'], '__proto__'),
            createStringFlatVector(['custom constructor', 'second'], 'constructor'),
            createStringFlatVector(['custom toString', 'second'], 'toString'),
        ]);
        const feature = GeoJSONFeature.fromFeatureTable(table, 0, 0, 0, 0, 1);
        const properties = feature.properties;
        expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
        expect(Object.hasOwn(properties, '__proto__')).toBe(true);
        expect(properties.__proto__).toEqual({value: 1});
        expect(properties.constructor).toBe('custom constructor');
        expect(properties.toString).toBe('custom toString');
        expect(Object.getOwnPropertyDescriptor(properties, '__proto__')).toEqual({
            value: {value: 1}, enumerable: true, configurable: true, writable: true,
        });
        properties.__proto__ = 'replacement';
        expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
        expect(properties.__proto__).toBe('replacement');
    });

    test('allows replacing public properties before reading the table', () => {
        const table = pointTable([createStringFlatVector(['first', 'second'], 'name')]);
        const resolveColumns = vi.spyOn(table, 'materializePropertyVectors');
        const feature = GeoJSONFeature.fromFeatureTable(table, 0, 0, 0, 0, 1);
        const replacement = {custom: true};
        feature.properties = replacement;
        expect(feature.properties).toBe(replacement);
        expect(resolveColumns).not.toHaveBeenCalled();
        expect(Object.getOwnPropertyDescriptor(feature, 'properties')).toEqual({
            value: replacement, enumerable: true, configurable: true, writable: true,
        });
    });
});

describe('direct columnar GeoJSON geometry', () => {
    test('matches every corpus geometry in reverse order without Point intermediates', () => {
        for (const x of [8802, 8803]) for (const y of [5374, 5375]) {
            const name = `14-${x}-${y}`;
            const mvt = new VectorTile(new PbfReader(fs.readFileSync(`test/integration/assets/tiles/${name}.mvt`)));
            const raw = fs.readFileSync(`test/integration/assets/tiles/mlt/gl-js/${name}.mlt`);
            const mlt = new MLTVectorTile(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
            const stats = createMltMaterializationStats();
            const deactivate = activateMltMaterializationStats(stats);
            try {
                for (const name of Object.keys(mvt.layers)) {
                    const table = getMltFeatureTable(mlt.layers[name]);
                    for (let index = table.numFeatures - 1; index >= 0; index--) {
                        const actual = GeoJSONFeature.fromFeatureTable(table, index, 14, x, y, index);
                        const expected = new GeoJSONFeature(mvt.layers[name].feature(index), 14, x, y, index);
                        expect(actual.geometry).toEqual(expected.geometry);
                        expect(actual.geometry).toBe(actual.geometry);
                    }
                }
            } finally {
                deactivate();
            }
            expect(stats.counters.pointObjects).toBe(0);
            expect(stats.counters.geometryPartsMaterialized).toBe(0);
            expect(stats.counters.propertyObjects).toBe(0);
        }
    }, 20000);

    test.each([
        {name: 'empty polygon', rings: []},
        {name: 'single degenerate ring', rings: [[[10, 10], [20, 20], [30, 30]]]},
        {name: 'all degenerate rings', rings: [[[10, 10], [20, 20]], [[30, 30], [40, 40]]]},
        {name: 'outer rings, hole and degenerate ring', rings: [
            [[0, 0], [100, 0], [100, 100], [0, 100]],
            [[20, 20], [20, 80], [80, 80], [80, 20]],
            [[10, 10], [20, 20]],
            [[200, 0], [300, 0], [300, 100], [200, 100]]
        ]}
    ])('preserves MVT classification for $name and independent writable output', ({rings}) => {
        const offsets = [0];
        for (const ring of rings) offsets.push(offsets.at(-1) + ring.length);
        const table = new FeatureTable('polygons', createConstGeometryVector(1, GEOMETRY_TYPE.POLYGON,
            new TopologyVector(undefined, new Uint32Array([0, rings.length]), Uint32Array.from(offsets)),
            undefined, Int32Array.from(rings.flat(2))));
        const adapter = MLTVectorTile.fromFeatureTables([table]).layers.polygons;
        const expected = new GeoJSONFeature(adapter.feature(0), 0, 0, 0, 1).geometry;
        const first = GeoJSONFeature.fromFeatureTable(table, 0, 0, 0, 0, 1);
        const second = GeoJSONFeature.fromFeatureTable(table, 0, 0, 0, 0, 1);
        expect(first.geometry).toEqual(expected);
        expect(second.geometry).toEqual(expected);
        expect(first.geometry).not.toBe(second.geometry);
        (first.geometry as GeoJSON.Polygon).coordinates.pop();
        expect(second.geometry).toEqual(expected);
        first.geometry = {type: 'Point', coordinates: [42, 7]};
        expect(first.toJSON().geometry).toEqual({type: 'Point', coordinates: [42, 7]});
    });
});
