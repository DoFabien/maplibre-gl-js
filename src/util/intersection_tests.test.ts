import {describe, expect, test} from 'vitest';
import Point from '@mapbox/point-geometry';
import {
    polygonIntersectsBufferedMultiLine,
    polygonIntersectsMultiPolygon,
} from './intersection_tests.ts';

import type {GeometryView} from './geometry_view.ts';

class ArrayBackedGeometryView implements GeometryView {
    constructor(private readonly geometry: Point[][]) {}

    get partCount(): number {
        return this.geometry.length;
    }

    getPartLength(partIndex: number): number {
        return this.geometry[partIndex].length;
    }

    getX(partIndex: number, pointIndex: number): number {
        return this.geometry[partIndex][pointIndex].x;
    }

    getY(partIndex: number, pointIndex: number): number {
        return this.geometry[partIndex][pointIndex].y;
    }

    materialize(): Point[][] {
        throw new Error('intersection must not materialize a geometry view');
    }
}

function ring(coordinates: Array<[number, number]>): Point[] {
    return coordinates.map(([x, y]) => new Point(x, y));
}

describe('columnar geometry intersections', () => {
    test.each([
        {label: 'inside outer ring', query: [new Point(1, 1)], expected: true},
        {label: 'inside hole', query: [new Point(5, 5)], expected: false},
        {label: 'outside', query: [new Point(12, 5)], expected: false},
        {
            label: 'crossing boundary',
            query: ring([[-1, 4], [1, 4], [1, 6], [-1, 6], [-1, 4]]),
            expected: true,
        },
        {
            label: 'box contained by hole',
            query: ring([[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]),
            expected: false,
        },
    ])('matches Point[][] polygon behavior for $label', ({query, expected}) => {
        const geometry = [
            ring([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]),
            ring([[3, 3], [3, 7], [7, 7], [7, 3], [3, 3]]),
        ];
        const view = new ArrayBackedGeometryView(geometry);

        expect(polygonIntersectsMultiPolygon(query, geometry)).toBe(expected);
        expect(polygonIntersectsMultiPolygon(query, view)).toBe(expected);
    });

    test.each([
        {label: 'point within buffer', query: [new Point(5, 1)], radius: 2, expected: true},
        {label: 'point outside buffer', query: [new Point(5, 1)], radius: 0.5, expected: false},
        {
            label: 'polygon crossing line',
            query: ring([[4, -1], [6, -1], [6, 1], [4, 1], [4, -1]]),
            radius: 0,
            expected: true,
        },
    ])('matches Point[][] buffered line behavior for $label', ({query, radius, expected}) => {
        const geometry = [ring([[0, 0], [10, 0]])];
        const view = new ArrayBackedGeometryView(geometry);

        expect(polygonIntersectsBufferedMultiLine(query, geometry, radius)).toBe(expected);
        expect(polygonIntersectsBufferedMultiLine(query, view, radius)).toBe(expected);
    });
});
