import {expect, test} from 'vitest';
import {featureFilter, type FilterSpecification, type ExpressionSpecification, type Feature} from '@maplibre/maplibre-gl-style-spec';
import {FeatureTable, IntFlatVector, BooleanFlatVector, BitVector, createStringDictionaryVector,
    createConstGeometryVector, TopologyVector, GEOMETRY_TYPE, sliceFeatureTable, IndexedVector} from '@maplibre/mlt';
import filter from './filter';

test('indexed child rows keep MVT filter semantics for dictionaries, nulls, ids and compound selections', () => {
    const source = new FeatureTable('places', createConstGeometryVector(5, GEOMETRY_TYPE.POINT,
        new TopologyVector(undefined, new Uint32Array([0, 1, 2, 3, 4, 5])), undefined,
        new Int32Array([3000, 3000, 100, 100, 3000, 3000, 200, 200, 300, 300])),
    new IntFlatVector('id', new Int32Array([40, 41, 42, 43, 44]), 5), [
        createStringDictionaryVector(['dropped', 'main', 'dropped', 'service', null], 'class'),
        new IntFlatVector('rank', new Int32Array([99, 1, 99, 3, 0]), new BitVector(new Uint8Array([0b01111]), 5)),
        new BooleanFlatVector('visible', new BitVector(new Uint8Array([0b00010]), 5), new BitVector(new Uint8Array([0b01111]), 5)),
    ]);
    const child = sliceFeatureTable(source, {z: 0, x: 0, y: 0}, {z: 1, x: 0, y: 0}, {columnMode: 'indexed'});
    expect(child.numFeatures).toBe(3);
    expect(child.getPropertyVector('class')).toBeInstanceOf(IndexedVector);
    const rows: Feature[] = [
        {id: 41, type: 1, properties: {class: 'main', rank: 1, visible: true}},
        {id: 43, type: 1, properties: {class: 'service', rank: 3, visible: false}},
        {id: 44, type: 1, properties: {}},
    ];
    const cases: FilterSpecification[] = [
        ['==', 'class', 'main'], ['!=', 'class', 'main'], ['in', 'class', 'main', 'service'], ['!in', 'class', 'main'],
        ['has', 'visible'], ['!has', 'class'], ['>=', 'rank', 3], ['==', '$id', 43],
        ['!in', 'rank', 1], ['!in', 'visible', true],
        ['all', ['>=', '$id', 41], ['!in', 'rank', 1]],
        ['all', ['>=', '$id', 41], ['!in', 'class', 'main']],
        ['all', ['>=', 'rank', 1], ['!=', 'class', 'main']],
        ['all', ['has', 'class'], ['in', 'class', 'main', 'service']],
        ['any', ['==', 'visible', true], ['!has', 'class']],
        ['==', ['coalesce', ['get', 'class'], 'missing'], 'missing'],
        ['all', ['has', 'visible'], ['==', ['get', 'visible'], false]],
    ];
    for (const specification of cases) {
        const selected = filter(child, specification as ExpressionSpecification);
        const mvt = featureFilter(specification, 'layers[0].filter');
        const expected = rows.flatMap((row, index) => mvt.filter({zoom: 1}, row) ? [index] : []);
        expect(Array.from({length: selected.limit}, (_, index) => selected.getIndex(index)), JSON.stringify(specification)).toEqual(expected);
    }
});
