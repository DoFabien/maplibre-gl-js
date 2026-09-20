import path from 'path';
import {readFileSync} from 'fs';
import {describe, expect, test} from 'vitest';
import filter from './filter';
import {
    BitVector,
    FeatureTable,
    createConstGeometryVector,
    createNullableStringVector,
    createSelectionVector,
    createStringDictionaryVector,
    createStringFlatVector,
    createStringFsstDictionaryVector,
    GEOMETRY_TYPE,
    IntFlatVector,
    BooleanFlatVector,
    TopologyVector,
    type Vector,
} from '@maplibre/mlt';
import {StyleLayerIndex} from '../../../style/style_layer_index';
import {EvaluationParameters} from '../../../style/evaluation_parameters';
import {OverscaledTileID} from '../../../tile/tile_id';
import {MLTVectorTile} from '../../../source/vector_tile_mlt';
import {createColumnarProperties} from '../../bucket/columnar/feature_properties';
import {
    createSyntheticLineFeatureTable,
    createSyntheticPolygonFeatureTable,
    syntheticLineFeatures,
    syntheticPolygonFeatures,
} from '../../../../test/unit/lib/mlt_synthetic';

type LayerType = 'fill' | 'line';
type SyntheticRow = {id: number; properties: Record<string, unknown>};
type StringEncoding = 'flat' | 'dictionary' | 'fsst';
type StyleSpecFilterCase = {
    source: string;
    filterSpecification: any;
    globalState?: Record<string, unknown>;
};

const canonical = new OverscaledTileID(0, 0, 0, 0, 0).canonical;
const evaluationParameters = new EvaluationParameters(0);

const styleSpecFilterCases: StyleSpecFilterCase[] = [
    {source: 'test/integration/expression/tests/get/basic/test.json', filterSpecification: ['==', ['number', ['get', 'x']], 1]},
    {source: 'test/integration/expression/tests/has/basic/test.json', filterSpecification: ['has', ['literal', 'class']]},
    {source: 'test/integration/expression/tests/equal/number/test.json', filterSpecification: ['==', ['number', ['get', 'x']], ['get', 'y']]},
    {source: 'test/integration/expression/tests/not_equal/number/test.json', filterSpecification: ['!=', ['number', ['get', 'x']], ['get', 'y']]},
    {source: 'test/integration/expression/tests/greater/number/test.json', filterSpecification: ['>', ['number', ['get', 'rank']], 2]},
    {source: 'test/integration/expression/tests/greater_or_equal/number/test.json', filterSpecification: ['>=', ['number', ['get', 'rank']], 2]},
    {source: 'test/integration/expression/tests/less/number/test.json', filterSpecification: ['<', ['number', ['get', 'rank']], 3]},
    {source: 'test/integration/expression/tests/less_or_equal/number/test.json', filterSpecification: ['<=', ['number', ['get', 'rank']], 3]},
    {source: 'test/integration/expression/tests/all/basic/test.json', filterSpecification: ['all', ['>=', ['get', 'rank'], 2], ['!=', ['get', 'class'], 'service']]},
    {source: 'test/integration/expression/tests/any/basic/test.json', filterSpecification: ['any', ['==', ['get', 'class'], 'service'], ['==', ['get', 'visible'], true]]},
    {source: 'test/integration/expression/tests/not/basic/test.json', filterSpecification: ['!', ['==', ['get', 'class'], 'service']]},
    {source: 'test/integration/expression/tests/coalesce/basic/test.json', filterSpecification: ['==', ['coalesce', ['get', 'nullableName'], 'fallback'], 'fallback']},
    {source: 'test/integration/expression/tests/coalesce/null/test.json', filterSpecification: ['==', ['coalesce', ['get', 'nullableName'], ['get', 'class'], 'fallback'], 'secondary']},
    {source: 'test/integration/expression/tests/case/basic/test.json', filterSpecification: ['case', ['==', ['get', 'class'], 'primary'], true, false]},
    {source: 'test/integration/expression/tests/case/precedence/test.json', filterSpecification: ['case', ['==', ['get', 'rank'], 1], false, ['==', ['get', 'rank'], 2], true, false]},
    {source: 'test/integration/expression/tests/match/basic/test.json', filterSpecification: ['match', ['get', 'class'], 'primary', true, 'secondary', true, false]},
    {source: 'test/integration/expression/tests/match/label-strings/test.json', filterSpecification: ['==', ['match', ['get', 'class'], ['primary', 'secondary'], 'known', 'other'], 'known']},
    {source: 'test/integration/expression/tests/in/basic-string/test.json', filterSpecification: ['in', 'way', ['downcase', ['get', 'type']]]},
    {source: 'test/integration/expression/tests/in/basic-array/test.json', filterSpecification: ['in', ['get', 'class'], ['literal', ['primary', 'secondary']]]},
    {source: 'test/integration/expression/tests/index-of/basic-string/test.json', filterSpecification: ['>=', ['index-of', 'way', ['downcase', ['get', 'type']]], 0]},
    {source: 'test/integration/expression/tests/index-of/multiple-match-string/test.json', filterSpecification: ['==', ['index-of', 'a', ['downcase', ['get', 'name']], 2], 4]},
    {source: 'test/integration/expression/tests/slice/string-two-indexes/test.json', filterSpecification: ['==', ['slice', ['get', 'name'], 0, 2], 'Al']},
    {source: 'test/integration/expression/tests/slice/string-one-index/test.json', filterSpecification: ['==', ['slice', ['get', 'name'], 1], 'eta']},
    {source: 'test/integration/expression/tests/upcase/basic/test.json', filterSpecification: ['==', ['upcase', ['get', 'class']], 'PRIMARY']},
    {source: 'test/integration/expression/tests/downcase/basic/test.json', filterSpecification: ['==', ['downcase', ['get', 'name']], 'éclair']},
    {source: 'test/integration/expression/tests/concat/basic/test.json', filterSpecification: ['==', ['concat', ['get', 'class'], '-', ['to-string', ['get', 'rank']]], 'primary-1']},
    {source: 'test/integration/expression/tests/length/string/test.json', filterSpecification: ['==', ['length', ['get', 'name']], 4]},
    {source: 'test/integration/expression/tests/to-number/basic/test.json', filterSpecification: ['>', ['to-number', ['get', 'numericText']], 2]},
    {source: 'test/integration/expression/tests/to-number/2-ary/test.json', filterSpecification: ['==', ['to-number', ['get', 'badNumeric'], 7], 7]},
    {source: 'test/integration/expression/tests/to-string/basic/test.json', filterSpecification: ['==', ['to-string', ['get', 'rank']], '2']},
    {source: 'test/integration/expression/tests/to-boolean/basic/test.json', filterSpecification: ['==', ['to-boolean', ['get', 'rank']], true]},
    {source: 'test/integration/expression/tests/boolean/default-value/test.json', filterSpecification: ['boolean', ['get', 'visible'], false]},
    {source: 'test/integration/expression/tests/number/default-value/test.json', filterSpecification: ['==', ['number', ['get', 'missingNumber'], 9], 9]},
    {source: 'test/integration/expression/tests/string/basic/test.json', filterSpecification: ['==', ['string', ['get', 'class']], 'service']},
    {source: 'test/integration/expression/tests/typeof/basic/test.json', filterSpecification: ['==', ['typeof', ['get', 'rank']], 'number']},
    {source: 'test/integration/expression/tests/let/basic/test.json', filterSpecification: ['let', 'r', ['to-number', ['get', 'rank']], ['>', ['var', 'r'], 2]]},
    {source: 'test/integration/expression/tests/plus/basic/test.json', filterSpecification: ['==', ['+', ['get', 'rank'], 1], 3]},
    {source: 'test/integration/expression/tests/minus/basic/test.json', filterSpecification: ['==', ['-', ['get', 'rank'], 1], 2]},
    {source: 'test/integration/expression/tests/times/basic/test.json', filterSpecification: ['==', ['*', ['get', 'rank'], 2], 6]},
    {source: 'test/integration/expression/tests/divide/basic/test.json', filterSpecification: ['==', ['/', ['get', 'rank'], 2], 1]},
    {source: 'test/integration/expression/tests/mod/basic/test.json', filterSpecification: ['==', ['%', ['get', 'rank'], 2], 1]},
    {source: 'test/integration/expression/tests/min/basic/test.json', filterSpecification: ['==', ['min', ['get', 'rank'], 2], 1]},
    {source: 'test/integration/expression/tests/max/basic/test.json', filterSpecification: ['==', ['max', ['get', 'rank'], 2], 4]},
    {source: 'test/integration/expression/tests/step/basic/test.json', filterSpecification: ['==', ['step', ['to-number', ['get', 'rank']], 0, 2, 20, 4, 40], 20]},
    {source: 'test/integration/expression/tests/interpolate/linear-number/test.json', filterSpecification: ['<', ['interpolate', ['linear'], ['to-number', ['get', 'rank']], 0, 0, 5, 50], 30]},
    {source: 'test/integration/expression/tests/global-state/basic/test.json', filterSpecification: ['==', ['global-state', 'targetClass'], ['get', 'class']], globalState: {targetClass: 'primary'}},
    {source: 'test/integration/expression/tests/id/basic/test.json', filterSpecification: ['==', ['id'], 103]},
    {source: 'test/integration/expression/tests/geometry-type/basic/test.json', filterSpecification: ['==', ['geometry-type'], 'LineString']},
];

function createTopology(size: number): TopologyVector {
    const offsets = new Uint32Array(size + 1);
    for (let i = 0; i <= size; i++) {
        offsets[i] = i;
    }
    return new TopologyVector(offsets, offsets, offsets);
}

function createNullableBitVector<T>(values: Array<T | null>): BitVector {
    const bitVector = new BitVector(new Uint8Array(Math.ceil(values.length / 8)), values.length);
    for (let index = 0; index < values.length; index++) {
        const value = values[index];
        if (value !== null) {
            bitVector.set(index, true);
        }
    }
    return bitVector;
}

function createNullableIntVector(name: string, values: Array<number | null>): IntFlatVector {
    const bitVector = createNullableBitVector(values);
    return new IntFlatVector(name, new Int32Array(values.map(value => value ?? 0)), bitVector);
}

function createBooleanVector(name: string, values: boolean[]): BooleanFlatVector {
    const bitVector = new BitVector(new Uint8Array(Math.ceil(values.length / 8)), values.length);
    for (let index = 0; index < values.length; index++) {
        bitVector.set(index, values[index]);
    }
    return new BooleanFlatVector(name, bitVector, values.length);
}

function createNullableBooleanVector(name: string, values: Array<boolean | null>): BooleanFlatVector {
    const bitVector = new BitVector(new Uint8Array(Math.ceil(values.length / 8)), values.length);
    const nullability = createNullableBitVector(values);
    for (let index = 0; index < values.length; index++) {
        bitVector.set(index, values[index] ?? false);
    }
    return new BooleanFlatVector(name, bitVector, nullability);
}

function createStringVector(name: string, values: Array<string | null>, encoding: StringEncoding): Vector {
    switch (encoding) {
        case 'flat':
            return values.some(value => value === null)
                ? createNullableStringVector(values, name)
                : createStringFlatVector(values, name);
        case 'dictionary':
            return createStringDictionaryVector(values, name);
        case 'fsst':
            return createStringFsstDictionaryVector(values, name);
    }
}

function createFeatureTable(
    layerType: LayerType,
    featureCount: number,
    propertyVectors: Vector[],
    ids?: number[],
): FeatureTable {
    const topology = createTopology(featureCount);
    const vertexOffsets = new Int32Array(featureCount + 1);
    for (let i = 0; i <= featureCount; i++) {
        vertexOffsets[i] = i * 2;
    }

    const geometryType = layerType === 'fill' ? GEOMETRY_TYPE.POLYGON : GEOMETRY_TYPE.LINESTRING;
    const geometryVector = createConstGeometryVector(
        featureCount,
        geometryType,
        topology,
        vertexOffsets,
        new Int32Array(featureCount * 2),
    );
    const idVector = ids ? new IntFlatVector('id', new Int32Array(ids), ids.length) : undefined;

    return new FeatureTable('test', geometryVector, idVector, propertyVectors);
}

function selectionToArray(selection: ReturnType<typeof filter>): number[] {
    return Array.from({length: selection.limit}, (_, index) => Number(selection.getIndex(index)));
}

function legacySelectedIndices(layerType: LayerType, rows: SyntheticRow[], featureTable: FeatureTable, filterSpecification: any, globalState?: Record<string, unknown>): number[] {
    const layerIndex = new StyleLayerIndex([{
        id: `${layerType}-parity`,
        source: 'source',
        'source-layer': 'test',
        type: layerType,
        filter: filterSpecification
    }], globalState);
    const layer = layerIndex.familiesBySource.source.test[0][0];
    const featureType = layerType === 'fill' ? 3 : 2;

    return rows.flatMap((row, index) => {
        const matches = layer._featureFilter.filter(
            evaluationParameters,
            {
                id: row.id,
                type: featureType,
                properties: createColumnarProperties(featureTable, index),
                geometry: []
            } as any,
            canonical
        );

        return matches ? [index] : [];
    });
}

function expectParity(
    layerType: LayerType,
    rows: SyntheticRow[],
    featureTable: FeatureTable,
    filterSpecification: any,
    globalState?: Record<string, unknown>,
) {
    expect(selectionToArray(filter(featureTable, filterSpecification, globalState)))
        .toEqual(legacySelectedIndices(layerType, rows, featureTable, filterSpecification, globalState));
}

describe.each(['fill', 'line'] as const)('MLT filter parity for %s layers', (layerType) => {
    test('shared synthetic fixture filters match legacy feature filtering', () => {
        const features = layerType === 'fill' ? syntheticPolygonFeatures() : syntheticLineFeatures();
        const rows = features.map(feature => ({
            id: feature.id ?? undefined,
            properties: feature.properties
        })) as any as SyntheticRow[];
        const featureTable = layerType === 'fill'
            ? createSyntheticPolygonFeatureTable()
            : createSyntheticLineFeatureTable();
        const geometryType = layerType === 'fill' ? 'Polygon' : 'LineString';
        const numericProperty = layerType === 'fill' ? 'height' : 'width';
        const globalState = {enabled: true};

        for (const filterSpecification of [
            ['==', ['get', 'kind'], layerType === 'fill' ? 'land' : 'primary'],
            ['has', 'opacity'],
            ['==', ['geometry-type'], geometryType],
            ['match', ['get', 'kind'], layerType === 'fill' ? ['land', 'park'] : ['primary', 'secondary'], true, false],
            ['case', ['>=', ['get', numericProperty], 6], true, false],
            ['let', 'value', ['get', numericProperty], ['>=', ['var', 'value'], 6]],
            ['>', ['coalesce', ['get', numericProperty], 0], 4],
            ['==', ['slice', ['upcase', ['get', 'kind']], 0, 4], layerType === 'fill' ? 'LAND' : 'PRIM'],
            ['==', ['global-state', 'enabled'], true],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification, globalState);
        }
    });

    test.each(styleSpecFilterCases)('style-spec expression fixture subset matches legacy filtering: $source', ({filterSpecification, globalState}) => {
        const rows: SyntheticRow[] = [
            {id: 101, properties: {x: 1, y: 1, rank: 1}},
            {id: 102, properties: {x: 2, y: 3, rank: 2}},
            {id: 103, properties: {x: 3, y: 2, rank: 3}},
            {id: 104, properties: {x: null, y: 4, rank: 4}},
            {id: 105, properties: {x: -1, y: -1, rank: null}},
            {id: 106, properties: {x: 0, y: null, rank: 0}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableIntVector('x', [1, 2, 3, null, -1, 0]),
                createNullableIntVector('y', [1, 3, 2, 4, -1, null]),
                createNullableIntVector('rank', [1, 2, 3, 4, null, 0]),
                createNullableIntVector('other', [1, 3, 3, 4, null, 0]),
                createNullableStringVector(['primary', 'secondary', 'service', 'primary', null, 'tertiary'], 'class'),
                createNullableStringVector(['Footway', 'Cycleway', 'Path', 'Service', null, ''], 'type'),
                createNullableStringVector(['Alpha', 'Beta', 'Gamma', 'Éclair', null, ''], 'name'),
                createNullableStringVector(['1', '2.5', '3', 'bad', null, '0'], 'numericText'),
                createNullableStringVector(['bad', '7', null, '8', 'bad', null], 'badNumeric'),
                createNullableStringVector(['oak', null, 'pine', null, null, ''], 'nullableName'),
                createNullableBooleanVector('visible', [true, false, null, true, false, null]),
                createNullableBooleanVector('fallbackVisible', [false, true, true, false, true, false]),
            ],
            rows.map(row => row.id),
        );

        expectParity(layerType, rows, featureTable, filterSpecification, globalState);
    });

    test('numeric comparison operators match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 10, properties: {rank: 1}},
            {id: 11, properties: {rank: 2}},
            {id: 12, properties: {rank: 3}},
            {id: 13, properties: {rank: 4}},
            {id: 14, properties: {rank: 5}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [createNullableIntVector('rank', [1, 2, 3, 4, 5])],
            rows.map(row => row.id),
        );

        for (const filterSpecification of [
            ['==', 'rank', 3],
            ['!=', 'rank', 3],
            ['<', 'rank', 3],
            ['<=', 'rank', 3],
            ['>', 'rank', 3],
            ['>=', 'rank', 3],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test.each(['flat', 'dictionary', 'fsst'] as const)(
        'string operators match legacy feature filtering for %s vectors',
        (encoding) => {
            const rows: SyntheticRow[] = [
                {id: 20, properties: {name: 'alpha', class: 'land'}},
                {id: 21, properties: {name: 'beta', class: 'water'}},
                {id: 22, properties: {name: 'gamma', class: 'road'}},
                {id: 23, properties: {name: 'delta', class: 'water'}},
            ];
            const featureTable = createFeatureTable(
                layerType,
                rows.length,
                [
                    createStringVector('name', ['alpha', 'beta', 'gamma', 'delta'], encoding),
                    createStringVector('class', ['land', 'water', 'road', 'water'], encoding),
                ],
                rows.map(row => row.id),
            );

            for (const filterSpecification of [
                ['in', 'name', 'beta', 'delta'],
                ['!in', 'name', 'alpha'],
                ['>=', 'name', 'beta'],
                ['<', 'name', 'delta'],
                ['match', ['get', 'class'], ['water', 'road'], true, false],
            ]) {
                expectParity(layerType, rows, featureTable, filterSpecification);
            }
        }
    );

    test('null, missing and compound operators match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 30, properties: {rank: 1, optional: 'oak'}},
            {id: 31, properties: {rank: 2}},
            {id: 32, properties: {rank: 3, optional: 'pine'}},
            {id: 33, properties: {rank: 4}},
            {id: 34, properties: {rank: 5}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableIntVector('rank', [1, 2, 3, 4, 5]),
                createNullableStringVector(['oak', null, 'pine', null, null], 'optional'),
            ],
            rows.map(row => row.id),
        );

        for (const filterSpecification of [
            ['has', 'optional'],
            ['!has', 'optional'],
            ['!in', 'optional', 'oak'],
            ['all', ['!has', 'optional'], ['>=', 'rank', 2]],
            ['any', ['==', 'optional', 'oak'], ['==', 'rank', 4]],
            ['none', ['has', 'optional'], ['==', 'rank', 4]],
            ['has', 'missing'],
            ['!has', 'missing'],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test('boolean, id and geometry type filters match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 50, properties: {visible: true, rank: 1}},
            {id: 51, properties: {visible: false, rank: 2}},
            {id: 52, properties: {visible: true, rank: 3}},
            {id: 53, properties: {visible: false, rank: 4}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createBooleanVector('visible', [true, false, true, false]),
                createNullableIntVector('rank', [1, 2, 3, 4]),
            ],
            rows.map(row => row.id),
        );
        const geometryType = layerType === 'fill' ? 'Polygon' : 'LineString';

        for (const filterSpecification of [
            ['==', 'visible', true],
            ['!=', 'visible', true],
            ['in', 'visible', true],
            ['!in', 'visible', true],
            ['==', '$id', rows[1].id],
            ['in', '$id', rows[0].id, rows[2].id],
            ['has', '$id'],
            ['==', '$type', geometryType],
            ['!=', '$type', geometryType],
            ['in', '$type', geometryType],
            ['!in', '$type', geometryType],
            ['has', '$type'],
            ['!has', '$type'],
            ['==', ['geometry-type'], geometryType],
            ['in', ['geometry-type'], ['literal', [geometryType]]],
            ['boolean', ['get', 'visible'], false],
            ['to-boolean', ['get', 'rank']],
            ['literal', true],
            ['literal', false],
            ['all', ['==', ['get', 'visible'], true], ['!', ['==', ['get', 'rank'], 3]]],
            ['any', ['in', 'rank'], ['in', 'rank', 2, 2, 2]],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test('missing id filters match legacy feature filtering', () => {
        const rows = [
            {id: undefined, properties: {rank: 1}},
            {id: undefined, properties: {rank: 2}},
        ] as any as SyntheticRow[];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [createNullableIntVector('rank', [1, 2])],
        );

        for (const filterSpecification of [
            ['==', '$id', 1],
            ['!=', '$id', 1],
            ['in', '$id', 1, 2],
            ['!in', '$id', 1, 2],
            ['has', '$id'],
            ['!has', '$id'],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test('expression-style property accessors match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 40, properties: {rank: 1, name: 'alpha', optional: 'oak'}},
            {id: 41, properties: {rank: 2, name: 'beta'}},
            {id: 42, properties: {rank: 3, name: 'gamma', optional: 'pine'}},
            {id: 43, properties: {rank: 4, name: 'delta'}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableIntVector('rank', [1, 2, 3, 4]),
                createStringVector('name', ['alpha', 'beta', 'gamma', 'delta'], 'dictionary'),
                createNullableStringVector(['oak', null, 'pine', null], 'optional'),
            ],
            rows.map(row => row.id),
        );

        for (const filterSpecification of [
            ['==', ['get', 'rank'], 3],
            ['>=', ['get', 'rank'], 2],
            ['in', ['get', 'name'], ['literal', ['beta', 'delta']]],
            ['all', ['>=', ['get', 'rank'], 2], ['!=', ['get', 'name'], 'gamma']],
            ['!', ['any', ['==', ['get', 'name'], 'beta'], ['==', ['get', 'name'], 'delta']]],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test('expression-style has filters match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 100, properties: {key: 'optional', optional: 'oak'}},
            {id: 101, properties: {key: 'optional'}},
            {id: 102, properties: {key: 'rank', rank: 3}},
            {id: 103, properties: {key: 'absent', optional: 'pine'}},
            {id: 104, properties: {optional: 'spruce'}},
            {id: 105, properties: {key: 'key'}},
            {id: 106, properties: {key: 'nullable'}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableStringVector(['optional', 'optional', 'rank', 'absent', null, 'key', 'nullable'], 'key'),
                createNullableStringVector(['oak', null, null, 'pine', 'spruce', null, null], 'optional'),
                createNullableIntVector('rank', [null, null, 3, null, null, null, null]),
                createNullableStringVector([null, null, null, null, null, null, null], 'nullable'),
            ],
            rows.map(row => row.id),
        );

        for (const filterSpecification of [
            ['has', ['literal', 'optional']],
            ['!has', ['literal', 'optional']],
            ['has', ['get', 'key']],
            ['!', ['has', ['get', 'key']]],
            ['all', ['has', ['get', 'key']], ['!=', ['get', 'key'], 'rank']],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test('dynamic has filters with non-string property names match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 110, properties: {key: 1, optional: 'oak'}},
            {id: 111, properties: {key: 2}},
            {id: 112, properties: {key: 3, optional: 'pine'}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableIntVector('key', [1, 2, 3]),
                createNullableStringVector(['oak', null, 'pine'], 'optional'),
            ],
            rows.map(row => row.id),
        );

        for (const filterSpecification of [
            ['has', ['get', 'key']],
            ['!', ['has', ['get', 'key']]],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test('match variants match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 60, properties: {class: 'primary', rank: 1}},
            {id: 61, properties: {class: 'secondary', rank: 2}},
            {id: 62, properties: {class: 'tertiary', rank: 3}},
            {id: 63, properties: {class: 'primary', rank: 4}},
            {id: 64, properties: {rank: 5}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableStringVector(['primary', 'secondary', 'tertiary', 'primary', null], 'class'),
                createNullableIntVector('rank', [1, 2, 3, 4, 5]),
            ],
            rows.map(row => row.id),
        );

        for (const filterSpecification of [
            ['match', ['get', 'class'], ['primary', 'secondary'], false, true],
            ['match', ['get', 'rank'], [1, 3], true, false],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test('global-state values match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 70, properties: {rank: 1, class: 'primary', visible: true}},
            {id: 71, properties: {rank: 2, class: 'secondary', visible: false}},
            {id: 72, properties: {rank: 3, class: 'primary', visible: true}},
            {id: 73, properties: {rank: 4, class: 'tertiary', visible: false}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableIntVector('rank', [1, 2, 3, 4]),
                createStringVector('class', ['primary', 'secondary', 'primary', 'tertiary'], 'dictionary'),
                createBooleanVector('visible', [true, false, true, false]),
            ],
            rows.map(row => row.id),
        );
        const globalState = {
            targetRank: 3,
            hiddenClass: 'secondary',
            minRank: 2,
            visible: true,
            showFeatures: false,
            visibleClasses: ['primary', 'tertiary'],
            typeSearch: 'primary-tertiary',
        };

        for (const filterSpecification of [
            ['==', ['get', 'rank'], ['global-state', 'targetRank']],
            ['!=', ['get', 'class'], ['global-state', 'hiddenClass']],
            ['all', ['==', ['get', 'visible'], ['global-state', 'visible']], ['>=', ['get', 'rank'], ['global-state', 'minRank']]],
            ['global-state', 'showFeatures'],
            ['!', ['global-state', 'showFeatures']],
            ['coalesce', ['get', 'visible'], ['global-state', 'showFeatures']],
            ['in', ['get', 'class'], ['global-state', 'visibleClasses']],
            ['in', ['get', 'class'], ['global-state', 'typeSearch']],
            ['==', ['in', ['get', 'class'], ['global-state', 'visibleClasses']], true],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification, globalState);
        }
    });

    test('trivial case filters match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 80, properties: {rank: 1, class: 'primary'}},
            {id: 81, properties: {rank: 2, class: 'secondary'}},
            {id: 82, properties: {rank: 3, class: 'primary'}},
            {id: 83, properties: {rank: 4, class: 'tertiary'}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableIntVector('rank', [1, 2, 3, 4]),
                createStringVector('class', ['primary', 'secondary', 'primary', 'tertiary'], 'dictionary'),
            ],
            rows.map(row => row.id),
        );

        for (const filterSpecification of [
            ['case', ['==', ['get', 'rank'], 2], true, false],
            ['case', ['==', ['get', 'rank'], 2], false, true],
            ['case', ['==', ['get', 'rank'], 1], true, ['==', ['get', 'rank'], 3], true, false],
            ['case', ['==', ['get', 'class'], 'primary'], false, ['==', ['get', 'class'], 'secondary'], false, true],
            ['case', ['==', ['get', 'rank'], 1], true, ['==', ['get', 'rank'], 2], false, true],
            ['case', ['==', ['get', 'rank'], 1], false, ['==', ['get', 'rank'], 2], true, false],
            ['case', true, true, false],
            ['case', ['==', ['get', 'rank'], 1], true, true],
            ['case', ['==', ['get', 'rank'], 1], false, false],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test('boolean coalesce filters match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 90, properties: {rank: 1, class: 'primary', visible: true, fallbackVisible: false}},
            {id: 91, properties: {rank: 2, class: 'secondary', visible: false, fallbackVisible: true}},
            {id: 92, properties: {rank: 3, class: 'primary', visible: null, fallbackVisible: true}},
            {id: 93, properties: {rank: 4, class: 'tertiary', fallbackVisible: false}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableIntVector('rank', [1, 2, 3, 4]),
                createStringVector('class', ['primary', 'secondary', 'primary', 'tertiary'], 'dictionary'),
                createNullableBooleanVector('visible', [true, false, null, null]),
                createNullableBooleanVector('fallbackVisible', [false, true, true, false]),
            ],
            rows.map(row => row.id),
        );

        for (const filterSpecification of [
            ['coalesce', ['==', ['get', 'rank'], 2], false],
            ['coalesce', false, ['==', ['get', 'rank'], 2]],
            ['coalesce', true, false],
            ['coalesce', ['get', 'visible'], false],
            ['coalesce', ['get', 'visible'], ['literal', false]],
            ['coalesce', ['get', 'visible']],
            ['coalesce', ['get', 'visible'], true],
            ['coalesce', ['get', 'visible'], ['==', ['get', 'rank'], 3]],
            ['coalesce', ['get', 'visible'], ['boolean', ['get', 'fallbackVisible'], false]],
            ['case', ['coalesce', ['==', ['get', 'class'], 'primary'], false], true, false],
            ['case', ['coalesce', ['get', 'visible'], false], true, false],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test('scalar coercions and scalar coalesce comparisons match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 120, properties: {rank: 1, numericText: '1', badText: 'bad', name: 'alpha', visible: true}},
            {id: 121, properties: {rank: 2, numericText: '2', badText: '7', name: null, visible: false}},
            {id: 122, properties: {rank: 3, numericText: '3.5', badText: null, name: 'gamma', visible: null}},
            {id: 123, properties: {rank: null, numericText: null, badText: 'bad', name: null}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableIntVector('rank', [1, 2, 3, null]),
                createNullableStringVector(['1', '2', '3.5', null], 'numericText'),
                createNullableStringVector(['bad', '7', null, 'bad'], 'badText'),
                createNullableStringVector(['alpha', null, 'gamma', null], 'name'),
                createNullableBooleanVector('visible', [true, false, null, null]),
            ],
            rows.map(row => row.id),
        );

        for (const filterSpecification of [
            ['==', ['to-number', ['get', 'numericText']], 2],
            ['>', ['to-number', ['get', 'numericText']], 2],
            ['==', ['to-number', ['get', 'badText'], 7], 7],
            ['==', ['to-number', ['get', 'missing'], 7], 0],
            ['==', ['to-string', ['get', 'rank']], '3'],
            ['==', ['to-string', ['get', 'missing']], ''],
            ['==', ['to-boolean', ['get', 'visible']], true],
            ['==', ['to-boolean', ['get', 'numericText']], true],
            ['<', ['coalesce', ['get', 'rank'], 999], 4],
            ['==', ['coalesce', ['get', 'name'], 'fallback'], 'fallback'],
            ['==', ['to-number', ['coalesce', ['get', 'numericText'], '5']], 5],
            ['all', ['>=', ['to-number', ['get', 'numericText']], 2], ['<', ['coalesce', ['get', 'rank'], 999], 4]],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test('numeric, length and concat scalar comparisons match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 130, properties: {rank: 1, numericText: '1', name: 'a'}},
            {id: 131, properties: {rank: 2, numericText: '2', name: 'beta'}},
            {id: 132, properties: {rank: 3, numericText: '3', name: 'éclair'}},
            {id: 133, properties: {rank: 0, numericText: 'bad', name: null}},
            {id: 134, properties: {rank: null, numericText: null}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableIntVector('rank', [1, 2, 3, 0, null]),
                createNullableStringVector(['1', '2', '3', 'bad', null], 'numericText'),
                createNullableStringVector(['a', 'beta', 'éclair', null, null], 'name'),
            ],
            rows.map(row => row.id),
        );

        for (const filterSpecification of [
            ['==', ['+', ['get', 'rank'], 1], 3],
            ['==', ['+', ['get', 'rank'], ['to-number', ['get', 'numericText']]], 4],
            ['==', ['-', ['get', 'rank'], 1], 2],
            ['==', ['-', ['get', 'rank']], -2],
            ['==', ['*', ['get', 'rank'], 2], 6],
            ['==', ['/', ['get', 'rank'], 2], 1],
            ['>', ['/', ['get', 'rank'], 0], 0],
            ['==', ['%', ['get', 'rank'], 2], 1],
            ['==', ['%', ['to-number', ['id']], 10], 2],
            ['==', ['min', ['get', 'rank'], 2], 1],
            ['==', ['max', ['get', 'rank'], 2], 3],
            ['==', ['length', ['get', 'name']], 4],
            ['==', ['concat', ['get', 'name'], '-', ['to-string', ['get', 'rank']]], 'beta-2'],
            ['==', ['concat', ['get', 'missing'], 'fallback'], 'fallback'],
            ['all', ['>', ['+', ['to-number', ['get', 'numericText']], 1], 3], ['<', ['max', ['get', 'rank'], 2], 4]],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test('let and var scalar comparisons match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 140, properties: {rank: 1, other: 1, numericText: '1', name: 'alpha', class: 'primary'}},
            {id: 141, properties: {rank: 2, other: 3, numericText: '2', name: 'beta', class: 'secondary'}},
            {id: 142, properties: {rank: 3, other: 3, numericText: '3', name: 'gamma', class: 'primary'}},
            {id: 143, properties: {rank: null, other: null, numericText: null, name: null, class: 'tertiary'}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableIntVector('rank', [1, 2, 3, null]),
                createNullableIntVector('other', [1, 3, 3, null]),
                createNullableStringVector(['1', '2', '3', null], 'numericText'),
                createNullableStringVector(['alpha', 'beta', 'gamma', null], 'name'),
                createStringVector('class', ['primary', 'secondary', 'primary', 'tertiary'], 'dictionary'),
            ],
            rows.map(row => row.id),
        );

        for (const filterSpecification of [
            ['==', ['let', 'r', ['to-number', ['get', 'rank']], ['var', 'r']], 2],
            ['==', ['let', 'r', ['to-number', ['get', 'rank']], ['+', ['var', 'r'], 1]], 4],
            ['==', ['let', 'r', 1, ['let', 'r', 2, ['var', 'r']]], 2],
            ['==', ['get', 'rank'], ['get', 'other']],
            ['==', ['get', 'rank'], ['let', 'target', ['to-number', ['get', 'numericText']], ['var', 'target']]],
            ['case', ['<', ['let', 'r', ['to-number', ['get', 'rank']], ['var', 'r']], 3], true, false],
            ['let', 'r', ['to-number', ['get', 'rank']], ['<', ['var', 'r'], 3]],
            ['all', ['let', 'r', ['to-number', ['get', 'rank']], ['<', ['var', 'r'], 4]], ['==', ['get', 'class'], 'primary']],
            ['!', ['let', 'label', ['concat', ['get', 'class'], '-', ['to-string', ['get', 'rank']]], ['==', ['var', 'label'], 'primary-1']]],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test('scalar case, scalar match and dynamic membership expressions match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 160, properties: {rank: 1, class: 'primary', type: 'Footway', visible: true}},
            {id: 161, properties: {rank: 2, class: 'secondary', type: 'Cycleway', visible: false}},
            {id: 162, properties: {rank: 3, class: 'service', type: 'Service', visible: true}},
            {id: 163, properties: {rank: 4, class: 'primary', type: 'Path', visible: null}},
            {id: 164, properties: {rank: null, class: null, type: null}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableIntVector('rank', [1, 2, 3, 4, null]),
                createNullableStringVector(['primary', 'secondary', 'service', 'primary', null], 'class'),
                createNullableStringVector(['Footway', 'Cycleway', 'Service', 'Path', null], 'type'),
                createNullableBooleanVector('visible', [true, false, true, null, null]),
            ],
            rows.map(row => row.id),
        );

        for (const filterSpecification of [
            ['<', ['case', ['==', ['get', 'class'], 'primary'], ['+', ['get', 'rank'], 1], 99], 5],
            ['==', ['case', ['all', ['==', ['get', 'class'], 'primary'], ['>=', ['get', 'rank'], 4]], 'late-primary', ['in', 'way', ['downcase', ['get', 'type']]], 'way', 'other'], 'way'],
            ['==', ['match', ['get', 'class'], 'primary', 1, 'secondary', 2, 0], 1],
            ['==', ['match', ['to-string', ['get', 'rank']], ['1', '2'], 'low', ['3', '4'], 'high', 'missing'], 'high'],
            ['==', ['case', ['==', ['get', 'rank'], 1], ['all', ['==', ['get', 'class'], 'primary'], ['has', 'type']], false], true],
            ['case', ['in', 'way', ['downcase', ['get', 'type']]], true, false],
            ['case', ['in', ['literal', 'way'], ['downcase', ['get', 'type']]], true, false],
            ['==', ['in', ['get', 'class'], ['literal', ['primary', 'secondary']]], true],
            ['==', ['in', ['get', 'missing'], ['literal', [null]]], true],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test('step, interpolate, assertions and string scalar comparisons match legacy feature filtering', () => {
        const rows: SyntheticRow[] = [
            {id: 150, properties: {rank: 1, numericText: '1', name: 'Alpha', class: 'primary', visible: true}},
            {id: 151, properties: {rank: 5, numericText: '5', name: 'Beta', class: 'secondary', visible: false}},
            {id: 152, properties: {rank: 10, numericText: '10', name: 'Gamma', class: 'tertiary', visible: null}},
            {id: 153, properties: {rank: null, numericText: 'bad', name: null, class: null}},
            {id: 154, properties: {numericText: null, name: 'Éclair'}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableIntVector('rank', [1, 5, 10, null, null]),
                createNullableStringVector(['1', '5', '10', 'bad', null], 'numericText'),
                createNullableStringVector(['Alpha', 'Beta', 'Gamma', null, 'Éclair'], 'name'),
                createNullableStringVector(['primary', 'secondary', 'tertiary', null, null], 'class'),
                createNullableBooleanVector('visible', [true, false, null, null, null]),
            ],
            rows.map(row => row.id),
        );

        for (const filterSpecification of [
            ['==', ['step', ['to-number', ['get', 'numericText']], 0, 5, 10, 10, 20], 10],
            ['==', ['step', ['coalesce', ['get', 'rank'], 999], 0, 5, 10, 10, 20], 20],
            ['<', ['interpolate', ['linear'], ['to-number', ['get', 'numericText']], 0, 0, 10, 100], 60],
            ['<', ['interpolate', ['exponential', 2], ['to-number', ['get', 'numericText']], 0, 0, 10, 100], 60],
            ['==', ['typeof', ['get', 'rank']], 'number'],
            ['==', ['typeof', ['get', 'missing']], 'null'],
            ['==', ['number', ['get', 'rank'], 0], 0],
            ['==', ['string', ['get', 'class'], 'fallback'], 'fallback'],
            ['==', ['boolean', ['get', 'visible'], false], false],
            ['==', ['literal', 'primary'], ['get', 'class']],
            ['==', ['slice', ['get', 'class'], 0, 3], 'pri'],
            ['==', ['slice', ['get', 'name'], 0], 'Beta'],
            ['>=', ['index-of', 'ar', ['get', 'class']], 0],
            ['==', ['index-of', 'a', ['downcase', ['get', 'name']], 2], 4],
            ['==', ['upcase', ['get', 'class']], 'PRIMARY'],
            ['==', ['downcase', ['get', 'name']], 'éclair'],
            ['all', ['==', ['typeof', ['get', 'class']], 'string'], ['==', ['slice', ['get', 'class'], 0, 1], 'p']],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });

    test('robust boolean expressions and evaluation errors parity', () => {
        const rows: SyntheticRow[] = [
            {id: 200, properties: {rank: 1, text: 'abc'}},
            {id: 201, properties: {rank: 2, text: 'def'}},
            {id: 202, properties: {rank: null, text: 'ghi'}},
        ];
        const featureTable = createFeatureTable(
            layerType,
            rows.length,
            [
                createNullableIntVector('rank', [1, 2, null]),
                createNullableStringVector(['abc', 'def', 'ghi'], 'text'),
            ],
            rows.map(row => row.id),
        );

        for (const filterSpecification of [
            ['!', ['==', ['string', ['get', 'rank'], 'fallback-if-missing-but-this-fails-assertion-since-it-is-a-number'], 'abc']],
            ['all', ['==', ['get', 'rank'], 1], ['==', ['string', ['get', 'rank']], '1']],
            ['any', ['==', ['get', 'rank'], 1], ['==', ['string', ['get', 'rank']], '1']],
            // Comparaisons calculées : types mixtes
            ['==', ['get', 'rank'], 'abc'],
            ['!=', ['get', 'rank'], 'abc'],
            ['<', ['get', 'rank'], 'abc'],
            ['<=', ['get', 'rank'], 'abc'],
            ['>', ['get', 'rank'], 'abc'],
            ['>=', ['get', 'rank'], 'abc'],
            // Comparaisons calculées : null / absent
            ['==', ['get', 'rank'], null],
            ['!=', ['get', 'rank'], null],
            // Comparaisons calculées : assertions échouées
            ['==', ['string', ['get', 'rank']], 'abc'],
            ['<', ['string', ['get', 'rank']], 'abc'],
            ['!=', ['length', ['string', ['get', 'rank']]], 0],
            ['!=', ['+', ['get', 'text'], 1], 0],
            // Match complexes
            ['match', ['to-string', ['get', 'rank']], '1', true, '2', true, false],
            ['match', ['get', 'text'], 'abc', ['==', ['get', 'rank'], 1], false],
            ['match', ['get', 'text'], 'abc', ['==', ['string', ['get', 'rank']], '1'], false],
            ['==', ['match', ['get', 'text'], 'def', 5, 0], 5],
            ['==', ['match', ['get', 'text'], 'abc', ['string', ['get', 'rank']], 'fallback'], 'fallback'],
            ['==', ['match', ['get', 'text'], 'missing', ['string', ['get', 'rank']], 'fallback'], 'fallback'],
            // Case complexes
            ['case', ['==', ['get', 'text'], 'abc'], ['==', ['get', 'rank'], 1], false],
            ['case', ['==', ['get', 'text'], 'abc'], true, ['==', ['get', 'text'], 'def'], ['==', ['get', 'rank'], 2], false],
            ['==', ['case', ['==', ['string', ['get', 'rank']], '1'], 1, 2], 2],
            ['==', ['case', ['==', ['get', 'text'], 'missing'], 1, ['==', ['string', ['get', 'rank']], '1'], 2, 3], 3],
            ['let', 'visible', ['==', ['get', 'text'], 'abc'], ['case', ['var', 'visible'], ['==', ['get', 'rank'], 1], false]],
            ['==', ['let', 'bad', ['string', ['get', 'rank']], 'ok', 1, ['var', 'ok']], 1],
            ['==', ['let', 'bad', ['string', ['get', 'rank']], ['var', 'bad']], '1'],
        ]) {
            expectParity(layerType, rows, featureTable, filterSpecification);
        }
    });
});

describe('MLT filter parity on a real corpus tile', () => {
    test('columnar selections match the legacy materialized path on a real MLT tile', () => {
        let corpusLayer:
            | {
                tilePath: string;
                name: string;
                layerType: LayerType;
                mltLayer: FeatureTable;
                propertyName: string;
                sampleValue: string | number | boolean;
            }
            | undefined;

        const candidateTilePaths = [
            path.join(__dirname, '../../../../test/integration/assets/tiles/mlt/5/17/10.mlt'),
            path.join(__dirname, '../../../../test/integration/assets/tiles/mlt/5/22/12.mlt'),
            path.join(__dirname, '../../../../test/integration/assets/tiles/mlt/14/8716/5685.mlt'),
            path.join(__dirname, '../../../../test/integration/assets/tiles/mlt/14/8717/5679.mlt'),
        ];

        for (const tilePath of candidateTilePaths) {
            const rawTile = readFileSync(tilePath);
            const mltTile = new MLTVectorTile(rawTile.buffer.slice(rawTile.byteOffset, rawTile.byteOffset + rawTile.byteLength));

            for (const [name, layer] of Object.entries(mltTile.layers)) {
                const featureTable = (layer as any).featureTable as FeatureTable | undefined;
                if (!featureTable || featureTable.numFeatures === 0) continue;

                const materialized = Array.from({length: Math.min(featureTable.numFeatures, 8)}, (_, index) => layer.feature(index));
                const hasLineGeometry = materialized.some(feature => feature.type === 2);
                const hasFillGeometry = materialized.some(feature => feature.type === 3);
                const layerType = hasLineGeometry ? 'line' : hasFillGeometry ? 'fill' : null;
                if (!layerType) {
                    continue;
                }

                for (const propertyVector of featureTable.propertyVectors ?? []) {
                    if (!propertyVector) continue;

                    for (let index = 0; index < featureTable.numFeatures; index++) {
                        const value = propertyVector.getValue(index);
                        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                            corpusLayer = {
                                tilePath,
                                name,
                                layerType,
                                mltLayer: featureTable,
                                propertyName: propertyVector.name,
                                sampleValue: value
                            };
                            break;
                        }
                    }

                    if (corpusLayer) break;
                }

                if (corpusLayer) break;
            }

            if (corpusLayer) break;
        }

        expect(corpusLayer).toBeDefined();

        const materializedFeatures = corpusLayer.mltLayer.getFeaturesForSelection(
            createSelectionVector(corpusLayer.mltLayer.numFeatures)
        );
        const layerIndex = new StyleLayerIndex([{
            id: 'corpus-line',
            source: 'source',
            'source-layer': corpusLayer.name,
            type: corpusLayer.layerType,
            filter: ['has', corpusLayer.propertyName]
        }]);
        const layer = layerIndex.familiesBySource.source[corpusLayer.name][0][0];
        const featureType = corpusLayer.layerType === 'line' ? 2 : 3;

        const legacyHasProperty = materializedFeatures.flatMap((feature, index) => {
            const matches = layer._featureFilter.filter(
                evaluationParameters,
                {
                    id: feature.id,
                    type: featureType,
                    properties: feature.properties ?? {},
                    geometry: []
                } as any,
                canonical
            );

            return matches ? [index] : [];
        });

        expect(selectionToArray(filter(corpusLayer.mltLayer, ['has', corpusLayer.propertyName])))
            .toEqual(legacyHasProperty);

        const equalityFilter = ['==', corpusLayer.propertyName, corpusLayer.sampleValue];
        const equalityLayerIndex = new StyleLayerIndex([{
            id: 'corpus-line-eq',
            source: 'source',
            'source-layer': corpusLayer.name,
            type: corpusLayer.layerType,
            filter: equalityFilter as any
        }]);
        const equalityLayer = equalityLayerIndex.familiesBySource.source[corpusLayer.name][0][0];
        const legacyEqualValue = materializedFeatures.flatMap((feature, index) => {
            const matches = equalityLayer._featureFilter.filter(
                evaluationParameters,
                {
                    id: feature.id,
                    type: featureType,
                    properties: feature.properties ?? {},
                    geometry: []
                } as any,
                canonical
            );

            return matches ? [index] : [];
        });

        expect(selectionToArray(filter(corpusLayer.mltLayer, equalityFilter as any))).toEqual(legacyEqualValue);
        expect(legacyEqualValue.length).toBeGreaterThan(0);
    });
});
