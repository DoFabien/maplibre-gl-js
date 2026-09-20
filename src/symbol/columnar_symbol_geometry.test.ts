import {describe, expect, test} from 'vitest';
import {
    createConstGeometryVector,
    FeatureTable,
    GEOMETRY_TYPE,
    TopologyVector,
} from '@maplibre/mlt';
import {clipLineFlat} from './clip_line.ts';
import {
    forEachClippedColumnarSymbolLine,
    forEachColumnarSymbolLine,
    forEachColumnarSymbolPolygon,
    type ColumnarGeometryFeature,
} from './columnar_symbol_geometry.ts';
import {findPoleOfInaccessibility} from '../util/find_pole_of_inaccessibility.ts';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../util/mlt_materialization_stats.ts';

function collectLines(feature: ColumnarGeometryFeature): Array<{line: number[]; partIndex: number}> {
    const lines: Array<{line: number[]; partIndex: number}> = [];
    forEachColumnarSymbolLine(feature, (line, partIndex) => lines.push({line, partIndex}));
    return lines;
}

function encodeMorton(x: number, y: number, numBits: number): number {
    let code = 0;
    for (let bit = 0; bit < numBits; bit++) {
        code |= ((x >> bit) & 1) << (2 * bit);
        code |= ((y >> bit) & 1) << (2 * bit + 1);
    }
    return code;
}

describe('columnar symbol geometry', () => {
    test('polygon placement preserves holes and multipolygon boundaries without materializing vertices', () => {
        const geometry = createConstGeometryVector(1, GEOMETRY_TYPE.MULTIPOLYGON,
            new TopologyVector(new Uint32Array([0, 2]), new Uint32Array([0, 2, 3]), new Uint32Array([0, 4, 8, 12])),
            null, new Int32Array([
                0, 0, 10, 0, 10, 10, 0, 10,
                2, 2, 2, 8, 8, 8, 8, 2,
                20, 0, 30, 0, 30, 10, 20, 10
            ]));
        const table = new FeatureTable('polygons', geometry, undefined, undefined, 8192);
        const stats = createMltMaterializationStats({strict: true});
        const deactivate = activateMltMaterializationStats(stats);
        const counts: number[] = [];
        const anchors: number[] = [];
        try {
            forEachColumnarSymbolPolygon({index: 0, columnarFeatureTable: table}, (polygon, outer) => {
                counts.push(polygon.partCount);
                expect(outer).toHaveLength(10);
                expect(polygon.getX(0, 4)).toBe(polygon.getX(0, 0));
                anchors.push(findPoleOfInaccessibility(polygon, 0.1).x);
            });
        } finally {
            deactivate();
        }
        expect(counts).toEqual([2, 1]);
        expect(anchors[0]).not.toBe(5);
        expect(anchors[1]).toBe(25);
        expect(stats.counters.geometryPartsMaterialized).toBe(0);
        expect(stats.counters.pointObjects).toBe(0);
    });

    test('reads VEC_2 vertex offsets and scales a non-4096 extent once', () => {
        const geometryVector = createConstGeometryVector(
            1,
            GEOMETRY_TYPE.LINESTRING,
            new TopologyVector(null, new Uint32Array([0, 3]), null),
            new Uint32Array([2, 0, 1]),
            new Int32Array([
                4096, 0,
                4096, 4096,
                0, 0,
            ])
        );
        const featureTable = new FeatureTable('offsets', geometryVector, undefined, undefined, 16384);

        expect(collectLines({index: 0, columnarFeatureTable: featureTable})).toEqual([{
            line: [0, 0, 2048, 0, 2048, 2048],
            partIndex: 0,
        }]);
    });

    test('decodes Morton coordinates through vertex offsets without coordinate tuples', () => {
        const numBits = 15;
        const coordinateShift = 16;
        const encode = (x: number, y: number) => encodeMorton(x + coordinateShift, y + coordinateShift, numBits);
        const geometryVector = createConstGeometryVector(
            1,
            GEOMETRY_TYPE.LINESTRING,
            new TopologyVector(null, new Uint32Array([0, 3]), null),
            new Uint32Array([2, 0, 1]),
            new Int32Array([
                encode(1024, 512),
                encode(4096, 2048),
                encode(0, 0),
            ])
        );
        Object.defineProperty(geometryVector, 'mortonSettings', {
            value: {numBits, coordinateShift},
        });
        const featureTable = new FeatureTable('morton', geometryVector, undefined, undefined, 16384);

        expect(collectLines({index: 0, columnarFeatureTable: featureTable})).toEqual([{
            line: [0, 0, 512, 256, 2048, 1024],
            partIndex: 0,
        }]);
    });

    test('preserves multipart boundaries while streaming directly into clipping output', () => {
        const geometryVector = createConstGeometryVector(
            1,
            GEOMETRY_TYPE.MULTILINESTRING,
            new TopologyVector(
                new Uint32Array([0, 2]),
                new Uint32Array([0, 3, 6]),
                null
            ),
            null,
            new Int32Array([
                -100, 100, 100, 100, 4200, 100,
                100, -100, 100, 2000, 100, 4200,
            ])
        );
        const feature = {
            index: 0,
            columnarFeatureTable: new FeatureTable('multipart', geometryVector, undefined, undefined, 8192),
        };
        const actual: Array<{line: number[]; partIndex: number}> = [];
        forEachClippedColumnarSymbolLine(feature, 0, 0, 4096, 4096, (line, partIndex) => {
            actual.push({line, partIndex});
        });

        const sourceParts = [
            [-100, 100, 100, 100, 4200, 100],
            [100, -100, 100, 2000, 100, 4200],
        ];
        const expected = sourceParts.flatMap((source, partIndex) =>
            clipLineFlat(source, 0, 0, 4096, 4096).map(line => ({line, partIndex}))
        );
        expect(actual).toEqual(expected);
    });
});
