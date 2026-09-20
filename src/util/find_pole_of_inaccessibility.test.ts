import {describe, test, expect} from 'vitest';
import Point from '@mapbox/point-geometry';
import {findPoleOfInaccessibility, getCentroidCell} from './find_pole_of_inaccessibility.ts';

import type {FeatureGeometry} from './geometry_view.ts';

/** The read-only implementation deliberately forbids compatibility materialization. */
function polygonInput(rings: Point[][], mode: string): FeatureGeometry {
    if (mode === 'points') return rings;
    return {
        partCount: rings.length,
        getPartLength: part => rings[part].length,
        getX: (part, index) => rings[part][index].x,
        getY: (part, index) => rings[part][index].y,
        materialize() { throw new Error('Unexpected polygon materialization'); }
    };
}

describe.each(['points', 'view'])('findPoleOfInaccessibility (%s)', mode => {
    test('should find the pole of inaccessibility for a simple polygon', () => {
        const closedRing = [
            new Point(0, 0),
            new Point(10, 0),
            new Point(10, 10),
            new Point(0, 10),
            new Point(0, 0)
        ];
        const result = findPoleOfInaccessibility(polygonInput([closedRing], mode), 0.1);
        expect(result).toEqual(new Point(5, 5));
        const centroid = getCentroidCell(polygonInput([closedRing], mode)).p;
        expect(result).toEqual(centroid);
    });

    test('should find the pole of inaccessibility for a polygon with a hole', () => {
        const closedRing = [
            new Point(0, 0),
            new Point(10, 10),
            new Point(10, 0),
            new Point(0, 0)
        ];
        const closedRingHole = [
            new Point(2, 1),
            new Point(6, 6),
            new Point(6, 1),
            new Point(2, 1)
        ];
        const result = findPoleOfInaccessibility(polygonInput([closedRing, closedRingHole], mode), 0.1);
        expect(result).toEqual(new Point(7.96875, 2.03125));
        const centroid = getCentroidCell(polygonInput([closedRing, closedRingHole], mode)).p;
        expect(result).not.toEqual(centroid);
    });

    test('should prefer centroid for a convex polygon when within precision', () => {
        const closedRing = [
            new Point(0, 0),
            new Point(10, 10),
            new Point(10, 0),
            new Point(0, 0)
        ];
        const result = findPoleOfInaccessibility(polygonInput([closedRing], mode), 1);
        expect(result).toEqual(new Point(40/6, 20/6));
        const centroid = getCentroidCell(polygonInput([closedRing], mode)).p;
        expect(result).toEqual(centroid);
    });

    test('should not prefer centroid for a concave polygon where POI is significantly better', () => {
        // U-shaped polygon => centroid is in the hollow area
        const uShape = [
            new Point(0, 0),
            new Point(10, 0),
            new Point(10, 10),
            new Point(8, 10),
            new Point(8, 2),
            new Point(2, 2),
            new Point(2, 10),
            new Point(0, 10),
            new Point(0, 0)
        ];
        const result = findPoleOfInaccessibility(polygonInput([uShape], mode), 0.1);
        expect(result).toEqual(new Point(8.828125, 1.171875));
        const centroid = getCentroidCell(polygonInput([uShape], mode)).p;
        expect(result).not.toEqual(centroid);
    });
});
