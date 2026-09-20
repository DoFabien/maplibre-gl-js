import {describe, test, expect} from 'vitest';
import {mergeLines} from './merge_lines.ts';
import Point from '@mapbox/point-geometry';
import {createConstGeometryVector, FeatureTable, GEOMETRY_TYPE, TopologyVector} from '@maplibre/mlt';
import {forEachColumnarSymbolLine} from './columnar_symbol_geometry.ts';

import type {SymbolFeature} from '../data/bucket/symbol_bucket.ts';

function makeFeatures(lines) {
    const features = [];
    for (const line of lines) {
        const points = [];
        for (let j = 1; j < line.length; j++) {
            points.push(new Point(line[j], 0));
        }
        features.push({text: line[0], geometry: [points]});
    }
    return features;
}

function makeColumnarFeatures(segments: Array<[number, number]>, text = 'a'): SymbolFeature[] {
    const partOffsets = new Uint32Array(segments.length + 1);
    const vertices = new Int32Array(segments.length * 4);
    for (let i = 0; i < segments.length; i++) {
        partOffsets[i + 1] = (i + 1) * 2;
        vertices[i * 4] = segments[i][0];
        vertices[i * 4 + 2] = segments[i][1];
    }
    const featureTable = new FeatureTable(
        'test',
        createConstGeometryVector(
            segments.length,
            GEOMETRY_TYPE.LINESTRING,
            new TopologyVector(null, partOffsets, null),
            null,
            vertices
        ),
        undefined,
        undefined,
        8192
    );
    return Array.from({length: segments.length}, (_, index) => ({
        text,
        icon: undefined,
        geometry: [],
        columnarFeatureTable: featureTable,
        index,
        sourceLayerIndex: 0,
        properties: {},
        type: 'LineString',
        sortKey: undefined
    }) as unknown as SymbolFeature);
}

function collectFirstColumnarLine(feature: SymbolFeature): number[] {
    let firstLine: number[] | undefined;
    forEachColumnarSymbolLine(feature, (line, partIndex) => {
        if (partIndex === 0) firstLine = line;
    });
    return firstLine ?? [];
}

describe('mergeLines', () => {
    test('mergeLines merges lines with the same text', () => {
        expect(
            mergeLines(makeFeatures([['a', 0, 1, 2], ['b', 4, 5, 6], ['a', 8, 9], ['a', 2, 3, 4], ['a', 6, 7, 8], ['a', 5, 6]]))
        ).toEqual(makeFeatures([['a', 0, 1, 2, 3, 4], ['b', 4, 5, 6], ['a', 5, 6, 7, 8, 9]]));
    });

    test('mergeLines handles merge from both ends', () => {
        expect(mergeLines(makeFeatures([['a', 0, 1, 2], ['a', 4, 5, 6], ['a', 2, 3, 4]]))).toEqual(makeFeatures([['a', 0, 1, 2, 3, 4, 5, 6]]));
    });

    test('mergeLines handles circular lines', () => {
        expect(mergeLines(makeFeatures([['a', 0, 1, 2], ['a', 2, 3, 4], ['a', 4, 0]]))).toEqual(makeFeatures([['a', 0, 1, 2, 3, 4, 0]]));
    });

    test('mergeLines merges columnar lines from both ends', () => {
        const featureTable = new FeatureTable(
            'test',
            createConstGeometryVector(
                3,
                GEOMETRY_TYPE.MULTILINESTRING,
                new TopologyVector(
                    new Uint32Array([0, 2, 3, 4]),
                    new Uint32Array([0, 3, 5, 8, 11]),
                    null
                ),
                null,
                new Int32Array([
                    0, 0, 1, 0, 2, 0,
                    100, 0, 101, 0,
                    4, 0, 5, 0, 6, 0,
                    2, 0, 3, 0, 4, 0
                ])
            ),
            undefined,
            undefined,
            8192
        );
        const features = Array.from({length: 3}, (_, index) => ({
            text: 'a',
            icon: undefined,
            geometry: [],
            columnarFeatureTable: featureTable,
            index,
            sourceLayerIndex: 0,
            properties: {},
            type: 'LineString',
            sortKey: undefined
        }) as unknown as SymbolFeature);

        const merged = mergeLines(features);
        const lines: number[][] = [];
        forEachColumnarSymbolLine(merged[0], line => lines.push(line));

        expect(merged).toHaveLength(1);
        expect(lines).toEqual([
            [0, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0],
            [100, 0, 101, 0]
        ]);
        expect(merged[0].geometry).toHaveLength(0);
    });

    test.each([
        {
            name: 'right',
            segments: [[0, 2], [2, 4]] as Array<[number, number]>,
            expected: [0, 0, 2, 0, 4, 0]
        },
        {
            name: 'left',
            segments: [[2, 4], [0, 2]] as Array<[number, number]>,
            expected: [0, 0, 2, 0, 4, 0]
        },
        {
            name: 'both sides',
            segments: [[0, 2], [4, 6], [2, 4]] as Array<[number, number]>,
            expected: [0, 0, 2, 0, 4, 0, 6, 0]
        },
        {
            name: 'cycle',
            segments: [[0, 2], [2, 4], [4, 0]] as Array<[number, number]>,
            expected: [0, 0, 2, 0, 4, 0, 0, 0]
        }
    ])('mergeLines merges columnar lines from the $name', ({segments, expected}) => {
        const merged = mergeLines(makeColumnarFeatures(segments));
        expect(merged).toHaveLength(1);
        expect(collectFirstColumnarLine(merged[0])).toEqual(expected);
    });

    test('mergeLines keeps a several-thousand-segment columnar chain linear', () => {
        const segmentCount = 5000;
        const segments = Array.from({length: segmentCount}, (_, index) => [index, index + 1] as [number, number]);
        const merged = mergeLines(makeColumnarFeatures(segments));
        const line = collectFirstColumnarLine(merged[0]);

        expect(merged).toHaveLength(1);
        expect(line).toHaveLength((segmentCount + 1) * 2);
        expect(line.slice(0, 4)).toEqual([0, 0, 1, 0]);
        expect(line.slice(-4)).toEqual([segmentCount - 1, 0, segmentCount, 0]);
    });

    test('mergeLines merges a chain arriving in order', () => {
        expect(
            mergeLines(makeFeatures([['a', 0, 1], ['a', 1, 2], ['a', 2, 3], ['a', 3, 4], ['a', 4, 5]]))
        ).toEqual(makeFeatures([['a', 0, 1, 2, 3, 4, 5]]));
    });

    test('mergeLines merges a chain arriving in reverse order', () => {
        expect(
            mergeLines(makeFeatures([['a', 4, 5], ['a', 3, 4], ['a', 2, 3], ['a', 1, 2], ['a', 0, 1]]))
        ).toEqual(makeFeatures([['a', 0, 1, 2, 3, 4, 5]]));
    });

    test('mergeLines merges a chain that arrives interleaved', () => {
        expect(
            mergeLines(makeFeatures([['a', 0, 1], ['a', 2, 3], ['a', 4, 5], ['a', 1, 2], ['a', 3, 4]]))
        ).toEqual(makeFeatures([['a', 0, 1, 2, 3, 4, 5]]));
    });

    test('mergeLines leaves a feature with no geometry alone', () => {
        const feature = {text: null, geometry: []};
        expect(mergeLines([feature] as any)).toEqual([feature]);
        expect(feature.geometry).toEqual([]);
    });
});
