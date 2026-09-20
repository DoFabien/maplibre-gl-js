import {describe, expect, test, vi} from 'vitest';
import {createSyntheticMltTile, syntheticPolygonLayer} from '../../../../test/unit/lib/mlt_synthetic.ts';
import {getMltFeatureTable} from '../../../source/vector_tile_mlt.ts';
import {loadGeometry} from '../../load_geometry.ts';
import {ColumnarGeometryView, getColumnarGeometryView, loadFeatureGeometry} from './geometry_traversal.ts';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../../../util/mlt_materialization_stats.ts';
import {createConstGeometryVector, FeatureTable, GEOMETRY_TYPE, GeometryTopologyCursor, TopologyVector} from '@maplibre/mlt';

describe('ColumnarGeometryView', () => {
    test('resolves the current part once and survives interleaved public geometry reads', () => {
        const table = new FeatureTable('lines', createConstGeometryVector(
            2, GEOMETRY_TYPE.MULTILINESTRING,
            new TopologyVector(new Uint32Array([0, 2, 3]), new Uint32Array([0, 3, 5, 7])),
            undefined, new Int32Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140])
        ));
        const seek = vi.spyOn(GeometryTopologyCursor.prototype, 'seek');
        try {
            const view = getColumnarGeometryView(table, 0);
            expect(view.getPartLength(0)).toBe(3);
            const resolved = seek.mock.calls.length;
            for (let i = 0; i < 10; i++) {
                expect(view.getX(0, 1)).toBe(60);
                expect(view.getY(0, 1)).toBe(80);
            }
            expect(seek).toHaveBeenCalledTimes(resolved);
            expect(loadFeatureGeometry(table, 1)[0][0]).toEqual({x: 110, y: 120});
            expect(view.getX(0, 2)).toBe(100);
            expect(view.getY(0, 2)).toBe(120);
            expect(view.getPartLength(1)).toBe(2);
            expect(view.getX(1, 0)).toBe(140);
            expect(view.getY(1, 1)).toBe(200);
            const other = new ColumnarGeometryView(table).setIndex(1);
            expect(other.getX(0, 0)).toBe(220);
            expect(view.getX(1, 0)).toBe(140);
            expect(view.getX(0, 0)).toBe(20);
            view.setIndex(1);
            expect(view.getX(0, 0)).toBe(220);
            view.setIndex(0);
            expect(view.getX(0, 0)).toBe(20);
            for (const part of [-1, 2, NaN]) expect(() => view.getX(part, 0)).toThrow(RangeError);
            for (const vertex of [-1, 3]) expect(() => view.getY(0, vertex)).toThrow(RangeError);
        } finally {
            seek.mockRestore();
        }
    });

    test('keeps virtual closure and coordinate scaling when cached parts change', () => {
        const table = new FeatureTable('polygon', createConstGeometryVector(
            1, GEOMETRY_TYPE.POLYGON,
            new TopologyVector(undefined, new Uint32Array([0, 2]), new Uint32Array([0, 3, 6])),
            new Uint32Array([2, 0, 1, 3, 4, 5]),
            new Int32Array([20, 30, 30, 40, 10, -10, 40, 50, 50, 60, 60, 70])
        ), undefined, [], 16384);
        const stats = createMltMaterializationStats({strict: true});
        const deactivate = activateMltMaterializationStats(stats);
        try {
            const view = getColumnarGeometryView(table, 0);
            for (const part of [0, 1, 0]) {
                expect(view.getPartLength(part)).toBe(4);
                expect(view.getX(part, 3)).toBe(view.getX(part, 0));
                expect(view.getY(part, 3)).toBe(view.getY(part, 0));
            }
            expect(view.getX(0, 0)).toBe(5);
            expect(view.getY(0, 0)).toBe(-5);
            expect(view.getX(1, 0)).toBe(20);
            expect(() => view.getY(0, 4)).toThrow(RangeError);
            for (const counter of stats.forbiddenCounters) expect(stats.counters[counter]).toBe(0);
        } finally {
            deactivate();
        }
    });

    test('does not precompute topology ranges for the whole layer', () => {
        const layer = createSyntheticMltTile().layers[syntheticPolygonLayer];
        const featureTable = getMltFeatureTable(layer);
        expect(featureTable).toBeDefined();
        const geometryType = vi.spyOn(featureTable.geometryVector, 'geometryType');

        expect(getColumnarGeometryView(featureTable, 0).partCount).toBeGreaterThan(0);

        expect(geometryType).toHaveBeenCalledTimes(1);
    });

    test('matches scaled MVT-like geometry without materializing direct reads', () => {
        const layer = createSyntheticMltTile().layers[syntheticPolygonLayer];
        const featureTable = getMltFeatureTable(layer);
        expect(featureTable).toBeDefined();
        const expected = loadGeometry(layer.feature(0));
        const stats = createMltMaterializationStats();
        const deactivate = activateMltMaterializationStats(stats);
        let actual;

        try {
            const geometry = getColumnarGeometryView(featureTable, 0);
            actual = Array.from({length: geometry.partCount}, (_part, partIndex) =>
                Array.from({length: geometry.getPartLength(partIndex)}, (_point, pointIndex) => [
                    geometry.getX(partIndex, pointIndex),
                    geometry.getY(partIndex, pointIndex),
                ]));
        } finally {
            deactivate();
        }

        expect(actual).toEqual(expected.map((part) => part.map(({x, y}) => [x, y])));
        expect(stats.counters.geometryPartsMaterialized).toBe(0);
        expect(stats.counters.pointObjects).toBe(0);
    });

    test('reuses the view and counts only explicit Point materialization', () => {
        const layer = createSyntheticMltTile().layers[syntheticPolygonLayer];
        const featureTable = getMltFeatureTable(layer);
        expect(featureTable).toBeDefined();
        const first = getColumnarGeometryView(featureTable, 0);
        const second = getColumnarGeometryView(featureTable, 1);
        const stats = createMltMaterializationStats();
        const deactivate = activateMltMaterializationStats(stats);
        let geometry;

        try {
            geometry = second.materialize();
        } finally {
            deactivate();
        }

        expect(second).toBe(first);
        expect(geometry.length).toBeGreaterThan(0);
        expect(stats.counters.geometryPartsMaterialized).toBe(geometry.length);
        expect(stats.counters.pointObjects).toBeGreaterThan(0);
    });

    test('loads vertex-offset geometry without temporary coordinate tuples', () => {
        const featureTable = new FeatureTable(
            'offset-line',
            createConstGeometryVector(
                1,
                GEOMETRY_TYPE.LINESTRING,
                new TopologyVector(null, new Uint32Array([0, 2]), null),
                new Uint32Array([1, 0]),
                new Int32Array([10, 20, 30, 40]),
            ),
        );

        const stats = createMltMaterializationStats();
        const deactivate = activateMltMaterializationStats(stats);
        try {
            expect(loadFeatureGeometry(featureTable, 0).map((part) => part.map(({x, y}) => [x, y])))
                .toEqual([[[30, 40], [10, 20]]]);
        } finally {
            deactivate();
        }
        expect(stats.counters.coordinateTuples).toBe(0);
    });

    test('decodes each Morton vertex exactly once during materialization', () => {
        const getVertex = vi.fn((index: number): [number, number] => [10 + index, 20 + index]);
        const geometryVector = {
            numGeometries: 1,
            geometryType: () => GEOMETRY_TYPE.LINESTRING,
            containsPolygonGeometry: () => false,
            topologyVector: new TopologyVector(null, new Uint32Array([0, 2]), null),
            vertexBuffer: new Uint32Array(),
            mortonSettings: {numBits: 4, coordinateShift: 0},
            getVertex,
        };
        const featureTable = {
            name: 'morton-line',
            extent: 4096,
            geometryVector,
        } as unknown as FeatureTable;

        const stats = createMltMaterializationStats();
        const deactivate = activateMltMaterializationStats(stats);
        try {
            expect(loadFeatureGeometry(featureTable, 0).map((part) => part.map(({x, y}) => [x, y])))
                .toEqual([[[10, 20], [11, 21]]]);
        } finally {
            deactivate();
        }
        expect(getVertex).toHaveBeenCalledTimes(2);
        expect(stats.counters.coordinateTuples).toBe(2);

        getVertex.mockClear();
        expect(getColumnarGeometryView(featureTable, 0).materialize().map((part) => part.map(({x, y}) => [x, y])))
            .toEqual([[[20, 40], [22, 42]]]);
        expect(getVertex).toHaveBeenCalledTimes(2);
    });
});
