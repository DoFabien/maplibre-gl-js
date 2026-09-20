import {describe, it, expect} from 'vitest';
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
    const vo = new Int32Array(n + 1);
    for (let i = 0; i <= n; i++) vo[i] = i * 2;
    const gv = createConstGeometryVector(n, geoType ?? GEOMETRY_TYPE.POINT, t, vo, new Int32Array(n * 2));
    return new FeatureTable('test', gv, undefined, props);
}

function ftWithId(n: number, ids: number[], props: Vector[] = []): FeatureTable {
    const t = createTopology(n);
    const vo = new Int32Array(n + 1);
    for (let i = 0; i <= n; i++) vo[i] = i * 2;
    const gv = createConstGeometryVector(n, GEOMETRY_TYPE.POINT, t, vo, new Int32Array(n * 2));
    const idVector = new IntFlatVector('id', new Int32Array(ids), n);
    return new FeatureTable('test', gv, idVector, props);
}

describe('filter', () => {
    describe('Null handling in !in operator', () => {
        it('!in includes null values', () => {
            const v = int([1, null, 2], 'v');
            const result = filter(ft(3, [v]), ['!in', 'v', 1] as never);
            expect(result.limit).toBe(2);
        });

        it('!in with compound filter includes nulls', () => {
            const v = int([1, null, 3], 'v');
            const result = filter(ft(3, [v]), ['all', ['>=', 'v', 0], ['!in', 'v', 1]] as never);
            expect(result.limit).toBe(2);
        });
    });

    describe('Duplicate prevention in \'in\' operator', () => {
        it('in with duplicate search values produces unique indices', () => {
            const v = int([1, 2, 3], 'v');
            const result = filter(ft(3, [v]), ['in', 'v', 1, 1, 1] as never);
            expect(result.limit).toBe(1);
        });

        it('in with compound filter no duplicates', () => {
            const v = int([1, 2, 3], 'v');
            const result = filter(
                ft(3, [v]),
                ['all', ['>=', 'v', 1], ['in', 'v', 2, 2, 2]] as never
            );
            expect(result.limit).toBe(1);
        });
    });

    describe('> operator', () => {
        it('IntVector with > operator', () => {
            const result = filter(ft(5, [int([1, 2, 3, 3, 5], 'v')]), ['>', 'v', 3]);
            expect(result.limit).toBe(1);
        });

        it('> with compound filter', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v'), int([1, 1, 1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['>', 'v', 2]]
            );
            expect(result.limit).toBe(3);
        });

        it('StringDictionaryVector with >', () => {
            const result = filter(ft(3, [strDict(['a', 'b', 'c'], 's')]), ['>', 's', 'a']);
            expect(result.limit).toBe(2);
        });
    });

    describe('<= operator standalone', () => {
        it('<= returns indices <= value', () => {
            const result = filter(ft(3, [int([1, 2, 3], 'v')]), ['<=', 'v', 2]);
            expect(result.limit).toBe(2);
        });
    });

    describe('< operator', () => {
        it('IntVector with < operator', () => {
            const result = filter(ft(5, [int([1, 2, 3, 3, 5], 'v')]), ['<', 'v', 3]);
            expect(result.limit).toBe(2);
        });

        it('< with compound filter', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v'), int([1, 1, 1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['<', 'v', 4]]
            );
            expect(result.limit).toBe(3);
        });

        it('StringDictionaryVector with <', () => {
            const result = filter(ft(3, [strDict(['a', 'b', 'c'], 's')]), ['<', 's', 'c']);
            expect(result.limit).toBe(2);
        });
    });

    describe('Compound filter path selection', () => {
        it('all with early exit on empty result', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['all', ['==', 'v', 99], ['>=', 'v', 2]]
            );
            expect(result.limit).toBe(0);
        });

        it('any with single child takes optimized path', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['any', ['==', 'v', 3]]
            );
            expect(result.limit).toBe(1);
        });

        it('any with all children returning empty', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['any', ['==', 'v', 99], ['==', 'v', 98]]
            );
            expect(result.limit).toBe(0);
        });

        it('nested compound: all inside any', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['any', ['all', ['>=', 'v', 2], ['<=', 'v', 3]], ['==', 'v', 5]]
            );
            expect(result.limit).toBe(3);
        });

        it('nested compound: any inside all', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['all', ['any', ['==', 'v', 2], ['==', 'v', 3]], ['>=', 'v', 2]]
            );
            expect(result.limit).toBe(2);
        });

        it('ConstSelectionVector materialization path', () => {
            const result = filter(
                ft(3, [int([1, 2, 3], 'v')], GEOMETRY_TYPE.POINT),
                ['all', ['==', '$type', 'Point'], ['>=', 'v', 2], ['<=', 'v', 3]]
            );
            expect(result.limit).toBe(2);
        });
    });

    describe('Expression-style property accessors', () => {
        it('supports equality with ["get", property]', () => {
            const result = filter(ft(4, [int([1, 2, 3, 4], 'rank')]), ['==', ['get', 'rank'], 3] as never);
            expect(result.limit).toBe(1);
        });

        it('supports range comparisons with ["get", property]', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'rank')]),
                ['all', ['>=', ['get', 'rank'], 2], ['<', ['get', 'rank'], 5]] as never
            );
            expect(result.limit).toBe(3);
        });

        it('supports in with ["get", property] and ["literal", values]', () => {
            const result = filter(
                ft(4, [strDict(['alpha', 'beta', 'gamma', 'delta'], 'name')]),
                ['in', ['get', 'name'], ['literal', ['beta', 'delta']]] as never
            );
            expect(result.limit).toBe(2);
        });

        it('supports none with expression-style accessors', () => {
            const result = filter(
                ft(4, [strDict(['alpha', 'beta', 'gamma', 'delta'], 'name')]),
                ['!', ['any', ['==', ['get', 'name'], 'beta'], ['==', ['get', 'name'], 'delta']]] as never
            );
            expect(result.limit).toBe(2);
        });
    });

    describe('Geometry type filter path selection', () => {
        it('in with multiple geometry types uses union path', () => {
            const result = filter(
                ft(5, [], GEOMETRY_TYPE.POINT),
                ['in', '$type', 'Point', 'LineString'] as never
            );
            expect(result.limit).toBe(5);
        });

        it('in with duplicate geometry types uses deduplication path', () => {
            const result = filter(
                ft(5, [], GEOMETRY_TYPE.POINT),
                ['in', '$type', 'Point', 'Point', 'Point'] as never
            );
            expect(result.limit).toBe(5);
        });

        it('!= geometry type with selection uses intersect path', () => {
            const result = filter(
                ft(3, [int([1, 2, 3], 'v')], GEOMETRY_TYPE.POINT),
                ['all', ['>=', 'v', 2], ['!=', '$type', 'LineString']]
            );
            expect(result.limit).toBe(2);
        });

        it('in geometry type with single type uses optimized path', () => {
            const result = filter(
                ft(5, [], GEOMETRY_TYPE.LINESTRING),
                ['in', '$type', 'LineString'] as never
            );
            expect(result.limit).toBe(5);
        });

        it('in geometry type with single type and selection', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')], GEOMETRY_TYPE.POINT),
                ['all', ['>', 'v', 2], ['in', '$type', 'Point'] as never]
            );
            expect(result.limit).toBe(3);
        });
    });

    describe('Missing property/id vector path selection', () => {
        it('missing id with == takes empty path', () => {
            const result = filter(ft(5), ['==', '$id', 123]);
            expect(result.limit).toBe(0);
        });

        it('missing id with != takes full path', () => {
            const result = filter(ft(5), ['!=', '$id', 123]);
            expect(result.limit).toBe(5);
        });

        it('missing id with in takes empty path', () => {
            const result = filter(ft(5), ['in', '$id', 1, 2] as never);
            expect(result.limit).toBe(0);
        });

        it('missing id with !in takes full path', () => {
            const result = filter(ft(5), ['!in', '$id', 1, 2] as never);
            expect(result.limit).toBe(5);
        });

        it('missing id with has takes empty path', () => {
            const result = filter(ft(5), ['has', '$id']);
            expect(result.limit).toBe(0);
        });

        it('missing id with !has takes full path', () => {
            const result = filter(ft(5), ['!has', '$id'] as never);
            expect(result.limit).toBe(5);
        });
    });

    describe('Empty values array', () => {
        it('in with empty values returns empty', () => {
            const result = filter(ft(3, [int([1, 2, 3], 'v')]), ['in', 'v'] as never);
            expect(result.limit).toBe(0);
        });

        it('!in with empty values returns all', () => {
            const result = filter(ft(3, [int([1, 2, 3], 'v')]), ['!in', 'v'] as never);
            expect(result.limit).toBe(3);
        });

        it('in with empty values in compound filter', () => {
            const result = filter(
                ft(3, [int([1, 2, 3], 'v')]),
                ['all', ['>=', 'v', 1], ['in', 'v'] as never]
            );
            expect(result.limit).toBe(0);
        });
    });

    describe('any operator with empty child results', () => {
        it('any skips children with empty results (limit === 0)', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['any', ['==', 'v', 99], ['==', 'v', 98], ['==', 'v', 3]]
            );
            expect(result.limit).toBe(1);
        });

        it('any with nested compound children', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['any', ['all', ['>=', 'v', 1], ['<=', 'v', 2]], ['==', 'v', 99], ['==', 'v', 5]]
            );
            expect(result.limit).toBe(3);
        });
    });

    describe('none operator', () => {
        it('! operator translates to none', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['!', ['==', 'v', 2]]
            );
            expect(result.limit).toBe(4);
        });
    });

    describe('geometry type != without selectionVector', () => {
        it('!= geometry type without prior selection', () => {
            const result = filter(
                ft(5, [], GEOMETRY_TYPE.POINT),
                ['!=', '$type', 'LineString']
            );
            expect(result.limit).toBe(5);
        });
    });

    describe('unsupported operator on geometry type', () => {
        it('>= operator on geometry type throws error', () => {
            expect(() => {
                filter(ft(5, [], GEOMETRY_TYPE.POINT), ['>=', '$type', 'Point']);
            }).toThrow('not supported on geometry type');
        });

        it('has operator on geometry type throws error', () => {
            expect(() => {
                filter(ft(5, [], GEOMETRY_TYPE.POINT), ['has', '$type']);
            }).toThrow('not supported on geometry type');
        });
    });

    describe('missing id with selectionVector', () => {
        it('missing id with != and prior selection returns selectionVector', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['all', ['>', 'v', 2], ['!=', '$id', 123]]
            );
            expect(result.limit).toBe(3);
        });
    });

    describe('missing property with selectionVector', () => {
        it('missing property with != and prior selection returns selectionVector', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['all', ['>', 'v', 2], ['!=', 'missing_prop', 123]]
            );
            expect(result.limit).toBe(3);
        });

        it('missing property without selectionVector', () => {
            const result = filter(ft(3), ['!=', 'missing', 123]);
            expect(result.limit).toBe(3);
        });

        it('missing property with == in compound returns empty', () => {
            const result = filter(
                ft(3, [int([1, 2, 3], 'v')]),
                ['all', ['==', 'v', 1], ['==', 'missing', 99]]
            );
            expect(result.limit).toBe(0);
        });
    });

    describe('Geometry type variations', () => {
        it('handles MultiPoint geometry type', () => {
            const result = filter(
                ft(3, [], GEOMETRY_TYPE.POINT),
                ['==', '$type', 'MultiPoint']
            );
            expect(result.limit).toBe(3);
        });

        it('handles MultiLineString geometry type', () => {
            const result = filter(
                ft(3, [], GEOMETRY_TYPE.LINESTRING),
                ['==', '$type', 'MultiLineString']
            );
            expect(result.limit).toBe(3);
        });

        it('handles MultiPolygon geometry type', () => {
            const result = filter(
                ft(3, [], GEOMETRY_TYPE.POLYGON),
                ['==', '$type', 'Polygon']
            );
            expect(result.limit).toBe(3);
        });

        it('handles geometry-type accessor', () => {
            const result = filter(
                ft(3, [], GEOMETRY_TYPE.POINT),
                ['==', ['geometry-type'], 'Point']
            );
            expect(result.limit).toBe(3);
        });
    });

    describe('Property accessor variations', () => {
        it('handles get accessor', () => {
            const result = filter(
                ft(3, [int([1, 2, 3], 'v')]),
                ['==', ['get', 'v'], 2]
            );
            expect(result.limit).toBe(1);
        });

        it('handles id accessor', () => {
            const result = filter(ft(3), ['has', ['id']]);
            expect(result.limit).toBe(0);
        });
    });

    describe('Match expression', () => {
        it('match with true output and false fallback', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['match', ['get', 'v'], 2, true, 3, true, false]
            );
            expect(result.limit).toBe(2);
        });

        it('match with false output and true fallback', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['match', ['get', 'v'], 2, false, 3, false, true]
            );
            expect(result.limit).toBe(3);
        });

        it('match with array labels', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['match', ['get', 'v'], [1, 2], true, [4, 5], true, false]
            );
            expect(result.limit).toBe(4);
        });

        it('match with mixed array and single labels', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['match', ['get', 'v'], [1, 2], false, 3, false, true]
            );
            expect(result.limit).toBe(2);
        });
    });

    describe('has/!has with nullable vector', () => {
        it('has returns non-null indices', () => {
            const result = filter(ft(3, [strDict(['a', null, 'c'], 's')]), ['has', 's']);
            expect(result.limit).toBe(2);
        });

        it('!has returns null indices', () => {
            const result = filter(ft(3, [strDict(['a', null, 'c'], 's')]), ['!has', 's'] as never);
            expect(result.limit).toBe(1);
        });
    });

    describe('Selected path correctness', () => {
        it('!= with selection filters within selection', () => {
            const result = filter(ft(5, [int([1, 2, 3, 4, 5], 'v')]), ['all', ['>', 'v', 1], ['!=', 'v', 3]]);
            expect(result.limit).toBe(3);
        });

        it('has with selection filters within selection', () => {
            const result = filter(
                ft(3, [strDict(['a', null, 'c'], 's'), int([1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['has', 's']]
            );
            expect(result.limit).toBe(2);
        });

        it('!has with selection filters within selection', () => {
            const result = filter(
                ft(3, [strDict(['a', null, 'c'], 's'), int([1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['!has', 's']] as never
            );
            expect(result.limit).toBe(1);
        });
    });

    describe('$id filter with idVector', () => {
        it('== matches id', () => {
            const result = filter(ftWithId(3, [100, 200, 300]), ['==', '$id', 200]);
            expect(result.limit).toBe(1);
        });

        it('!= excludes id', () => {
            const result = filter(ftWithId(3, [100, 200, 300]), ['!=', '$id', 200]);
            expect(result.limit).toBe(2);
        });

        it('in on id', () => {
            const result = filter(ftWithId(3, [100, 200, 300]), ['in', '$id', 100, 300] as never);
            expect(result.limit).toBe(2);
        });

        it('has on id', () => {
            const result = filter(ftWithId(3, [100, 200, 300]), ['has', '$id']);
            expect(result.limit).toBe(3);
        });

        it('== id with compound filter', () => {
            const result = filter(
                ftWithId(3, [100, 200, 300], [int([1, 2, 3], 'v')]),
                ['all', ['>=', 'v', 2], ['==', '$id', 200]]
            );
            expect(result.limit).toBe(1);
        });
    });

    describe('Edge cases and error handling', () => {
        it('empty filter returns all features', () => {
            const result = filter(ft(5), null);
            expect(result.limit).toBe(5);
        });

        it('unsupported filter operator throws error', () => {
            expect(() => {
                filter(ft(3), ['unsupported'] as any);
            }).toThrow('Unsupported filter operator');
        });

        it('unsupported accessor throws error', () => {
            expect(() => {
                filter(ft(3), ['==', ['unsupported'], 1] as any);
            }).toThrow('Unsupported accessor');
        });

        it('invalid geometry type throws error', () => {
            expect(() => {
                filter(ft(3), ['==', '$type', 'InvalidType']);
            }).toThrow('Invalid geometry type');
        });
    });

    describe('BooleanFlatVector through filter', () => {
        it('== filters boolean values', () => {
            const result = filter(ft(4, [bool([true, false, true, false], 'b')]), ['==', 'b', true]);
            expect(result.limit).toBe(2);
        });

        it('!= filters boolean values', () => {
            const result = filter(ft(4, [bool([true, false, true, false], 'b')]), ['!=', 'b', true]);
            expect(result.limit).toBe(2);
        });

        it('in matches boolean values', () => {
            const result = filter(ft(3, [bool([true, false, true], 'b')]), ['in', 'b', true] as never);
            expect(result.limit).toBe(2);
        });

        it('!in excludes boolean values', () => {
            const result = filter(ft(3, [bool([true, false, true], 'b')]), ['!in', 'b', true] as never);
            expect(result.limit).toBe(1);
        });

        it('>= on boolean throws', () => {
            expect(() => {
                filter(ft(3, [bool([true, false, true], 'b')]), ['>=', 'b', true] as never);
            }).toThrow('not supported for boolean');
        });

        it('<= on boolean throws', () => {
            expect(() => {
                filter(ft(3, [bool([true, false, true], 'b')]), ['<=', 'b', true] as never);
            }).toThrow('not supported for boolean');
        });

        it('== boolean with compound filter (selected path)', () => {
            const result = filter(
                ft(4, [bool([true, false, true, false], 'b'), int([1, 1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['==', 'b', true]]
            );
            expect(result.limit).toBe(2);
        });

        it('!= boolean with compound filter (selected path)', () => {
            const result = filter(
                ft(4, [bool([true, false, true, false], 'b'), int([1, 1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['!=', 'b', true]]
            );
            expect(result.limit).toBe(2);
        });

        it('in boolean with compound filter (selected path)', () => {
            const result = filter(
                ft(3, [bool([true, false, true], 'b'), int([1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['in', 'b', false] as never]
            );
            expect(result.limit).toBe(1);
        });

        it('!in boolean with compound filter (selected path)', () => {
            const result = filter(
                ft(3, [bool([true, false, true], 'b'), int([1, 1, 1], 'f')]),
                ['all', ['==', 'f', 1], ['!in', 'b', false] as never]
            );
            expect(result.limit).toBe(2);
        });
    });

    describe('Literal array in values', () => {
        it('in operator with literal array', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['in', ['get', 'v'], ['literal', [2, 3]]] as any
            );
            expect(result.limit).toBe(2);
        });

        it('!in operator with literal array', () => {
            const result = filter(
                ft(5, [int([1, 2, 3, 4, 5], 'v')]),
                ['!in', ['get', 'v'], ['literal', [2, 3]]] as any
            );
            expect(result.limit).toBe(3);
        });

        it('in operator with non-literal expression value treats as single value', () => {
            const result = filter(
                ft(3, [int([1, 2, 3], 'v')]),
                ['in', ['get', 'v'], [2, 3]] as any
            );
            expect(result.limit).toBe(0);
        });
    });
});
