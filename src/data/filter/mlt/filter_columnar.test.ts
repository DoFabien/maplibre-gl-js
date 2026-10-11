import {describe, expect, test} from 'vitest';
import filter from './filter';
import {
    type Vector,
    FeatureTable,
    IntFlatVector,
    BooleanFlatVector,
    BitVector,
    createStringDictionaryVector,
    createConstGeometryVector,
    TopologyVector,
    GEOMETRY_TYPE,
} from '@maplibre/mlt';

function createTopology(n: number): TopologyVector {
    const o = new Uint32Array(n + 1);
    for (let i = 0; i <= n; i++) o[i] = i;
    return new TopologyVector(o, o, o);
}

const int = (v: number[], name: string) => new IntFlatVector(name, new Int32Array(v), v.length);
const strDict = (v: Array<string | null>, name: string) => createStringDictionaryVector(v, name);
function bool(v: boolean[], name: string): BooleanFlatVector {
    const bv = new BitVector(new Uint8Array(Math.ceil(v.length / 8)), v.length);
    for (let i = 0; i < v.length; i++) {
        if (v[i]) bv.set(i, true);
    }
    return new BooleanFlatVector(name, bv, v.length);
}

function ft(n: number, props: Vector[] = [], geoType?: GEOMETRY_TYPE): FeatureTable {
    const t = createTopology(n);
    const vo = new Uint32Array(n + 1);
    for (let i = 0; i <= n; i++) vo[i] = i * 2;
    const gv = createConstGeometryVector(n, geoType ?? GEOMETRY_TYPE.POINT, t, vo, new Int32Array(n * 2));
    return new FeatureTable('test', gv, undefined, props);
}

function ftWithId(n: number, ids: number[], props: Vector[] = []): FeatureTable {
    const t = createTopology(n);
    const vo = new Uint32Array(n + 1);
    for (let i = 0; i <= n; i++) vo[i] = i * 2;
    const gv = createConstGeometryVector(n, GEOMETRY_TYPE.POINT, t, vo, new Int32Array(n * 2));
    const idVector = new IntFlatVector('id', new Int32Array(ids), n);
    return new FeatureTable('test', gv, idVector, props);
}

describe('filter', () => {
    describe('Null handling in !in operator', () => {
        test('!in includes null values', () => {
            const v = int([1, null, 2], 'v');
            const result = filter(ft(3, [v]), ['!in', 'v', 1] as never);
            expect(result.limit).toBe(2);
        });

        test('!in with compound filter includes nulls', () => {
            const v = int([1, null, 3], 'v');
            const result = filter(ft(3, [v]), ['all', ['>=', 'v', 0], ['!in', 'v', 1]] as never);
            expect(result.limit).toBe(2);
        });
    });

    describe('Duplicate prevention in \'in\' operator', () => {
        test('in with duplicate search values produces unique indices', () => {
            const v = int([1, 2, 3], 'v');
            const result = filter(ft(3, [v]), ['in', 'v', 1, 1, 1] as never);
            expect(result.limit).toBe(1);
        });

        test('in with compound filter no duplicates', () => {
            const v = int([1, 2, 3], 'v');
            const result = filter(
                ft(3, [v]),
                ['all', ['>=', 'v', 1], ['in', 'v', 2, 2, 2]] as never
            );
            expect(result.limit).toBe(1);
        });
    });

    describe('> operator', () => {
        test('IntVector with > operator', () => {
            const result = filter(ft(5, [int([1, 2, 3, 3, 5], 'v')]), ['>', 'v', 3]);
            expect(result.limit).toBe(1);
        });

        test('> with compound filter', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v'), int([1, 1, 1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['>', 'v', 2]]
            );
            expect(result.limit).toBe(3);
        });

        test('StringDictionaryVector with >', () => {
            const result = filter(ft(3, [strDict(['a', 'b', 'c'], 's')]), ['>', 's', 'a']);
            expect(result.limit).toBe(2);
        });
    });

    describe('<= operator standalone', () => {
        test('<= returns indices <= value', () => {
            const result = filter(ft(3, [int([1, 2, 3], 'v')]), ['<=', 'v', 2]);
            expect(result.limit).toBe(2);
        });
    });

    describe('< operator', () => {
        test('IntVector with < operator', () => {
            const result = filter(ft(5, [int([1, 2, 3, 3, 5], 'v')]), ['<', 'v', 3]);
            expect(result.limit).toBe(2);
        });

        test('< with compound filter', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v'), int([1, 1, 1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['<', 'v', 4]]
            );
            expect(result.limit).toBe(3);
        });

        test('StringDictionaryVector with <', () => {
            const result = filter(ft(3, [strDict(['a', 'b', 'c'], 's')]), ['<', 's', 'c']);
            expect(result.limit).toBe(2);
        });
    });

    describe('Compound filter path selection', () => {
        test('all with early exit on empty result', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['all', ['==', 'v', 99], ['>=', 'v', 2]]
            );
            expect(result.limit).toBe(0);
        });

        test('any with single child takes optimized path', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['any', ['==', 'v', 3]]
            );
            expect(result.limit).toBe(1);
        });

        test('any with all children returning empty', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['any', ['==', 'v', 99], ['==', 'v', 98]]
            );
            expect(result.limit).toBe(0);
        });

        test('nested compound: all inside any', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['any', ['all', ['>=', 'v', 2], ['<=', 'v', 3]], ['==', 'v', 5]]
            );
            expect(result.limit).toBe(3);
        });

        test('nested compound: any inside all', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['all', ['any', ['==', 'v', 2], ['==', 'v', 3]], ['>=', 'v', 2]]
            );
            expect(result.limit).toBe(2);
        });

        test('narrows a geometry type selection with property filters', () => {
            const result = filter(
                ft(3, [int([1, 2, 3], 'v')], GEOMETRY_TYPE.POINT),
                ['all', ['==', '$type', 'Point'], ['>=', 'v', 2], ['<=', 'v', 3]]
            );
            expect(result.limit).toBe(2);
        });
    });

    describe('Expression-style property accessors', () => {
        test('supports equality with ["get", property]', () => {
            const result = filter(ft(4, [int([1, 2, 3, 4], 'rank')]), ['==', ['get', 'rank'], 3] as never);
            expect(result.limit).toBe(1);
        });

        test('supports range comparisons with ["get", property]', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'rank')]),
                ['all', ['>=', ['get', 'rank'], 2], ['<', ['get', 'rank'], 5]] as never
            );
            expect(result.limit).toBe(3);
        });

        test('supports in with ["get", property] and ["literal", values]', () => {
            const result = filter(
                ft(4, [strDict(['alpha', 'beta', 'gamma', 'delta'], 'name')]),
                ['in', ['get', 'name'], ['literal', ['beta', 'delta']]] as never
            );
            expect(result.limit).toBe(2);
        });

        test('supports none with expression-style accessors', () => {
            const result = filter(
                ft(4, [strDict(['alpha', 'beta', 'gamma', 'delta'], 'name')]),
                ['!', ['any', ['==', ['get', 'name'], 'beta'], ['==', ['get', 'name'], 'delta']]] as never
            );
            expect(result.limit).toBe(2);
        });
    });

    describe('Geometry type filter path selection', () => {
        test('in with multiple geometry types uses union path', () => {
            const result = filter(
                ft(5, [], GEOMETRY_TYPE.POINT),
                ['in', '$type', 'Point', 'LineString'] as never
            );
            expect(result.limit).toBe(5);
        });

        test('in with duplicate geometry types uses deduplication path', () => {
            const result = filter(
                ft(5, [], GEOMETRY_TYPE.POINT),
                ['in', '$type', 'Point', 'Point', 'Point'] as never
            );
            expect(result.limit).toBe(5);
        });

        test('!= geometry type with selection uses intersect path', () => {
            const result = filter(
                ft(3, [int([1, 2, 3], 'v')], GEOMETRY_TYPE.POINT),
                ['all', ['>=', 'v', 2], ['!=', '$type', 'LineString']]
            );
            expect(result.limit).toBe(2);
        });

        test('in geometry type with single type uses optimized path', () => {
            const result = filter(
                ft(5, [], GEOMETRY_TYPE.LINESTRING),
                ['in', '$type', 'LineString'] as never
            );
            expect(result.limit).toBe(5);
        });

        test('in geometry type with single type and selection', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')], GEOMETRY_TYPE.POINT),
                ['all', ['>', 'v', 2], ['in', '$type', 'Point'] as never]
            );
            expect(result.limit).toBe(3);
        });
    });

    describe('Missing property/id vector path selection', () => {
        test('missing id with == takes empty path', () => {
            const result = filter(ft(5), ['==', '$id', 123]);
            expect(result.limit).toBe(0);
        });

        test('missing id with != takes full path', () => {
            const result = filter(ft(5), ['!=', '$id', 123]);
            expect(result.limit).toBe(5);
        });

        test('missing id with in takes empty path', () => {
            const result = filter(ft(5), ['in', '$id', 1, 2] as never);
            expect(result.limit).toBe(0);
        });

        test('missing id with !in takes full path', () => {
            const result = filter(ft(5), ['!in', '$id', 1, 2] as never);
            expect(result.limit).toBe(5);
        });

        test('missing id with has takes empty path', () => {
            const result = filter(ft(5), ['has', '$id']);
            expect(result.limit).toBe(0);
        });

        test('missing id with !has takes full path', () => {
            const result = filter(ft(5), ['!has', '$id'] as never);
            expect(result.limit).toBe(5);
        });
    });

    describe('Empty values array', () => {
        test('in with empty values returns empty', () => {
            const result = filter(ft(3, [int([1, 2, 3], 'v')]), ['in', 'v'] as never);
            expect(result.limit).toBe(0);
        });

        test('!in with empty values returns all', () => {
            const result = filter(ft(3, [int([1, 2, 3], 'v')]), ['!in', 'v'] as never);
            expect(result.limit).toBe(3);
        });

        test('in with empty values in compound filter', () => {
            const result = filter(
                ft(3, [int([1, 2, 3], 'v')]),
                ['all', ['>=', 'v', 1], ['in', 'v'] as never]
            );
            expect(result.limit).toBe(0);
        });
    });

    describe('any operator with empty child results', () => {
        test('any skips children with empty results (limit === 0)', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['any', ['==', 'v', 99], ['==', 'v', 98], ['==', 'v', 3]]
            );
            expect(result.limit).toBe(1);
        });

        test('any with nested compound children', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['any', ['all', ['>=', 'v', 1], ['<=', 'v', 2]], ['==', 'v', 99], ['==', 'v', 5]]
            );
            expect(result.limit).toBe(3);
        });
    });

    describe('none operator', () => {
        test('! operator translates to none', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['!', ['==', ['get', 'v'], 2]]
            );
            expect(result.limit).toBe(4);
        });
    });

    describe('geometry type != without selectionVector', () => {
        test('!= geometry type without prior selection', () => {
            const result = filter(
                ft(5, [], GEOMETRY_TYPE.POINT),
                ['!=', '$type', 'LineString']
            );
            expect(result.limit).toBe(5);
        });
    });

    describe('ordering and existence on geometry type', () => {
        test('legacy >= on geometry type is not a valid style filter', () => {
            expect(() => {
                filter(ft(5, [], GEOMETRY_TYPE.POINT), ['>=', '$type', 'Point']);
            }).toThrow('Unknown expression "filter-type->="');
        });

        test('expression >= on geometry type compares type names', () => {
            expect(filter(ft(5, [], GEOMETRY_TYPE.POINT), ['>=', ['geometry-type'], 'Point']).limit).toBe(5);
            expect(filter(ft(5, [], GEOMETRY_TYPE.POINT), ['>=', ['geometry-type'], 'Polygon']).limit).toBe(0);
        });

        test('has $type matches every feature', () => {
            expect(filter(ft(5, [], GEOMETRY_TYPE.POINT), ['has', '$type']).limit).toBe(5);
        });
    });

    describe('missing id with selectionVector', () => {
        test('missing id with != and prior selection returns selectionVector', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['all', ['>', 'v', 2], ['!=', '$id', 123]]
            );
            expect(result.limit).toBe(3);
        });
    });

    describe('missing property with selectionVector', () => {
        test('missing property with != and prior selection returns selectionVector', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['all', ['>', 'v', 2], ['!=', 'missing_prop', 123]]
            );
            expect(result.limit).toBe(3);
        });

        test('missing property without selectionVector', () => {
            const result = filter(ft(3), ['!=', 'missing', 123]);
            expect(result.limit).toBe(3);
        });

        test('missing property with == in compound returns empty', () => {
            const result = filter(
                ft(3, [int([1, 2, 3], 'v')]),
                ['all', ['==', 'v', 1], ['==', 'missing', 99]]
            );
            expect(result.limit).toBe(0);
        });
    });

    describe('Geometry type variations', () => {
        test('matches no feature for multi-part geometry type names, which vector tile filters never see', () => {
            expect(filter(ft(3, [], GEOMETRY_TYPE.POINT), ['==', '$type', 'MultiPoint']).limit).toBe(0);
            expect(filter(ft(3, [], GEOMETRY_TYPE.LINESTRING), ['==', '$type', 'MultiLineString']).limit).toBe(0);
        });

        test('handles Polygon geometry type', () => {
            const result = filter(
                ft(3, [], GEOMETRY_TYPE.POLYGON),
                ['==', '$type', 'Polygon']
            );
            expect(result.limit).toBe(3);
        });

        test('handles geometry-type accessor', () => {
            const result = filter(
                ft(3, [], GEOMETRY_TYPE.POINT),
                ['==', ['geometry-type'], 'Point']
            );
            expect(result.limit).toBe(3);
        });
    });

    describe('Property accessor variations', () => {
        test('handles get accessor', () => {
            const result = filter(
                ft(3, [int([1, 2, 3], 'v')]),
                ['==', ['get', 'v'], 2]
            );
            expect(result.limit).toBe(1);
        });

        test('handles id accessor', () => {
            const result = filter(ft(3), ['has', ['id']]);
            expect(result.limit).toBe(0);
        });
    });

    describe('Match expression', () => {
        test('match with true output and false fallback', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['match', ['get', 'v'], 2, true, 3, true, false]
            );
            expect(result.limit).toBe(2);
        });

        test('match with false output and true fallback', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['match', ['get', 'v'], 2, false, 3, false, true]
            );
            expect(result.limit).toBe(3);
        });

        test('match with array labels', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['match', ['get', 'v'], [1, 2], true, [4, 5], true, false]
            );
            expect(result.limit).toBe(4);
        });

        test('match with mixed array and single labels', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['match', ['get', 'v'], [1, 2], false, 3, false, true]
            );
            expect(result.limit).toBe(2);
        });
    });

    describe('has/!has with nullable vector', () => {
        test('has returns non-null indices', () => {
            const result = filter(ft(3, [strDict(['a', null, 'c'], 's')]), ['has', 's']);
            expect(result.limit).toBe(2);
        });

        test('!has returns null indices', () => {
            const result = filter(ft(3, [strDict(['a', null, 'c'], 's')]), ['!has', 's'] as never);
            expect(result.limit).toBe(1);
        });
    });

    describe('Selected path correctness', () => {
        test('!= with selection filters within selection', () => {
            const result = filter(ft(5, [int([1, 2, 3, 4, 5], 'v')]), ['all', ['>', 'v', 1], ['!=', 'v', 3]]);
            expect(result.limit).toBe(3);
        });

        test('has with selection filters within selection', () => {
            const result = filter(
                ft(3, [strDict(['a', null, 'c'], 's'), int([1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['has', 's']]
            );
            expect(result.limit).toBe(2);
        });

        test('!has with selection filters within selection', () => {
            const result = filter(
                ft(3, [strDict(['a', null, 'c'], 's'), int([1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['!has', 's']] as never
            );
            expect(result.limit).toBe(1);
        });
    });

    describe('$id filter with idVector', () => {
        test('== matches id', () => {
            const result = filter(ftWithId(3, [100, 200, 300]), ['==', '$id', 200]);
            expect(result.limit).toBe(1);
        });

        test('!= excludes id', () => {
            const result = filter(ftWithId(3, [100, 200, 300]), ['!=', '$id', 200]);
            expect(result.limit).toBe(2);
        });

        test('in on id', () => {
            const result = filter(ftWithId(3, [100, 200, 300]), ['in', '$id', 100, 300] as never);
            expect(result.limit).toBe(2);
        });

        test('has on id', () => {
            const result = filter(ftWithId(3, [100, 200, 300]), ['has', '$id']);
            expect(result.limit).toBe(3);
        });

        test('== id with compound filter', () => {
            const result = filter(
                ftWithId(3, [100, 200, 300], [int([1, 2, 3], 'v')]),
                ['all', ['>=', 'v', 2], ['==', '$id', 200]]
            );
            expect(result.limit).toBe(1);
        });
    });

    describe('Edge cases and error handling', () => {
        test('empty filter returns all features', () => {
            const result = filter(ft(5), null);
            expect(result.limit).toBe(5);
        });

        test('unsupported filter operator throws error', () => {
            expect(() => {
                filter(ft(3), ['unsupported'] as any);
            }).toThrow('Unknown expression "unsupported"');
        });

        test('unsupported accessor throws error', () => {
            expect(() => {
                filter(ft(3), ['==', ['unsupported'], 1] as any);
            }).toThrow('Unknown expression "unsupported"');
        });

        test('unknown and multi-part geometry type names match no feature', () => {
            expect(filter(ft(3), ['==', '$type', 'InvalidType']).limit).toBe(0);
            expect(filter(ft(3), ['!=', '$type', 'InvalidType']).limit).toBe(3);
            expect(filter(ft(3), ['==', '$type', 'MultiPoint']).limit).toBe(0);
        });
    });

    describe('BooleanFlatVector through filter', () => {
        test('== filters boolean values', () => {
            const result = filter(ft(4, [bool([true, false, true, false], 'b')]), ['==', 'b', true]);
            expect(result.limit).toBe(2);
        });

        test('!= filters boolean values', () => {
            const result = filter(ft(4, [bool([true, false, true, false], 'b')]), ['!=', 'b', true]);
            expect(result.limit).toBe(2);
        });

        test('in matches boolean values', () => {
            const result = filter(ft(3, [bool([true, false, true], 'b')]), ['in', 'b', true] as never);
            expect(result.limit).toBe(2);
        });

        test('!in excludes boolean values', () => {
            const result = filter(ft(3, [bool([true, false, true], 'b')]), ['!in', 'b', true] as never);
            expect(result.limit).toBe(1);
        });

        test('legacy >= and <= compare booleans', () => {
            expect(filter(ft(3, [bool([true, false, true], 'b')]), ['>=', 'b', true] as never).limit).toBe(2);
            expect(filter(ft(3, [bool([true, false, true], 'b')]), ['<=', 'b', true] as never).limit).toBe(3);
        });

        test('== boolean with compound filter (selected path)', () => {
            const result = filter(
                ft(4, [bool([true, false, true, false], 'b'), int([1, 1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['==', 'b', true]]
            );
            expect(result.limit).toBe(2);
        });

        test('!= boolean with compound filter (selected path)', () => {
            const result = filter(
                ft(4, [bool([true, false, true, false], 'b'), int([1, 1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['!=', 'b', true]]
            );
            expect(result.limit).toBe(2);
        });

        test('in boolean with compound filter (selected path)', () => {
            const result = filter(
                ft(3, [bool([true, false, true], 'b'), int([1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['in', 'b', false] as never]
            );
            expect(result.limit).toBe(1);
        });

        test('!in boolean with compound filter (selected path)', () => {
            const result = filter(
                ft(3, [bool([true, false, true], 'b'), int([1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['!in', 'b', false] as never]
            );
            expect(result.limit).toBe(2);
        });
    });

    describe('Literal array in values', () => {
        test('in operator with literal array', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['in', ['get', 'v'], ['literal', [2, 3]]] as any
            );
            expect(result.limit).toBe(2);
        });

        test('!in with an expression target is a legacy filter of a property that does not exist', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['!in', ['get', 'v'], ['literal', [2, 3]]] as any
            );
            expect(result.limit).toBe(5);
        });

        test('in operator with a bare array haystack is not a valid style filter', () => {
            expect(() => {
                filter(ft(3, [int([1, 2, 3], 'v')]), ['in', ['get', 'v'], [2, 3]] as any);
            }).toThrow('Expression name must be a string');
        });
    });
});
