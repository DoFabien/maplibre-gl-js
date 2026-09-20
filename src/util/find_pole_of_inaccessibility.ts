import Queue from 'tinyqueue';
import Point from '@mapbox/point-geometry';
import {distToSegmentSquaredCoordinates} from './intersection_tests.ts';
import {Bounds} from '../geo/bounds.ts';
import {getGeometryPartCount, getGeometryPartLength, getGeometryX, getGeometryY, type FeatureGeometry} from './geometry_view.ts';

/**
 * Finds an approximation of a polygon's Pole Of Inaccessibility https://en.wikipedia.org/wiki/Pole_of_inaccessibility
 * This is a copy of https://github.com/mapbox/polylabel adapted to Points or scalar geometry views.
 *
 * @param polygonRings - The outer ring followed by holes, supplied as Point arrays or a read-only geometry view.
 * @param precision - Specified in input coordinate units. If 0 returns after first run, if `> 0` repeatedly narrows the search space until the radius of the area searched for the best pole is less than precision
 * @returns Pole of Inaccessibility.
 */
export function findPoleOfInaccessibility(
    polygonRings: FeatureGeometry,
    precision: number = 1,
): Point {
    const bounds = new Bounds();
    for (let index = 0; index < getGeometryPartLength(polygonRings, 0); index++) {
        const x = getGeometryX(polygonRings, 0, index);
        const y = getGeometryY(polygonRings, 0, index);
        bounds.minX = Math.min(bounds.minX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.maxY = Math.max(bounds.maxY, y);
    }

    const cellSize = Math.min(bounds.width(), bounds.height());
    let h = cellSize / 2;

    // a priority queue of cells in order of their "potential" (max distance to polygon)
    const cellQueue = new Queue([], compareMax);

    const {minX, minY, maxX, maxY} = bounds;
    if (cellSize === 0) return new Point(minX, minY);

    // cover polygon with initial cells
    for (let x = minX; x < maxX; x += cellSize) {
        for (let y = minY; y < maxY; y += cellSize) {
            cellQueue.push(new Cell(x + h, y + h, h, polygonRings));
        }
    }

    // take centroid as the first best guess
    const centroidCell = getCentroidCell(polygonRings);
    let bestCell = centroidCell;

    while (cellQueue.length) {
        // pick the most promising cell from the queue
        const cell = cellQueue.pop();

        // update the best cell if we found a better one
        if (cell.d > bestCell.d || !bestCell.d) {
            bestCell = cell;
        }

        // do not drill down further if there's no chance of a better solution
        if (cell.max - bestCell.d <= precision) continue;

        // split the cell into four cells
        h = cell.h / 2;
        cellQueue.push(new Cell(cell.p.x - h, cell.p.y - h, h, polygonRings));
        cellQueue.push(new Cell(cell.p.x + h, cell.p.y - h, h, polygonRings));
        cellQueue.push(new Cell(cell.p.x - h, cell.p.y + h, h, polygonRings));
        cellQueue.push(new Cell(cell.p.x + h, cell.p.y + h, h, polygonRings));
    }

    // For convex or nearly-convex polygons, the centroid provides visually
    // better label placement than the mathematical POI.
    // Coordinate rounding (e.g. in geojson-vt) can break polygon symmetry and cause the POI to
    // drift far from center even though its distance-to-edge is only marginally better.
    // Prefer the centroid when it is inside the polygon
    // and its distance is within `precision` of the best found.
    if (centroidCell.d > 0 && bestCell.d - centroidCell.d <= precision) {
        return centroidCell.p;
    }
    return bestCell.p;
}

function compareMax(a: Cell, b: Cell) {
    return b.max - a.max;
}

class Cell {
    p: Point;
    h: number;
    d: number;
    max: number;

    constructor(x: number, y: number, h: number, polygon: FeatureGeometry) {
        this.p = new Point(x, y);
        this.h = h; // half the cell size
        this.d = pointToPolygonDist(this.p, polygon); // distance from cell center to polygon
        this.max = this.d + this.h * Math.SQRT2; // max distance to polygon within a cell
    }
}

// signed distance from point to polygon outline (negative if point is outside)
function pointToPolygonDist(p: Point, polygon: FeatureGeometry) {
    let inside = false;
    let minDistSq = Infinity;

    for (let ring = 0; ring < getGeometryPartCount(polygon); ring++) {
        for (let i = 0, len = getGeometryPartLength(polygon, ring), j = len - 1; i < len; j = i++) {
            const ax = getGeometryX(polygon, ring, i);
            const ay = getGeometryY(polygon, ring, i);
            const bx = getGeometryX(polygon, ring, j);
            const by = getGeometryY(polygon, ring, j);

            if ((ay > p.y !== by > p.y) &&
                (p.x < (bx - ax) * (p.y - ay) / (by - ay) + ax)) inside = !inside;

            minDistSq = Math.min(minDistSq, distToSegmentSquaredCoordinates(p.x, p.y, ax, ay, bx, by));
        }
    }

    return (inside ? 1 : -1) * Math.sqrt(minDistSq);
}

// get polygon centroid
export function getCentroidCell(polygon: FeatureGeometry): Cell {
    let area = 0;
    let x = 0;
    let y = 0;
    for (let i = 0, len = getGeometryPartLength(polygon, 0), j = len - 1; i < len; j = i++) {
        const ax = getGeometryX(polygon, 0, i);
        const ay = getGeometryY(polygon, 0, i);
        const bx = getGeometryX(polygon, 0, j);
        const by = getGeometryY(polygon, 0, j);
        const f = ax * by - bx * ay;
        x += (ax + bx) * f;
        y += (ay + by) * f;
        area += f * 3;
    }
    return new Cell(x / area, y / area, 0, polygon);
}
