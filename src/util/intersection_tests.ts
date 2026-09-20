import {isCounterClockwise} from './util.ts';
import Point from '@mapbox/point-geometry';
import {
    getGeometryPartCount,
    getGeometryPartLength,
    getGeometryX,
    getGeometryY,
    type FeatureGeometry,
} from './geometry_view.ts';

export {polygonIntersectsBufferedPoint, polygonIntersectsBufferedPointCoordinates, polygonIntersectsMultiPolygon, polygonIntersectsBufferedMultiLine, polygonIntersectsPolygon, distToSegmentSquared, polygonIntersectsBox};

type Line = Point[];
type Ring = Point[];
type Polygon = Point[];

function polygonIntersectsPolygon(polygonA: Polygon, polygonB: Polygon): boolean {
    for (const point of polygonA) {
        if (polygonContainsPoint(polygonB, point)) return true;
    }

    for (const point of polygonB) {
        if (polygonContainsPoint(polygonA, point)) return true;
    }

    return lineIntersectsLine(polygonA, polygonB);
}

function polygonIntersectsBufferedPoint(polygon: Polygon, point: Point, radius: number): boolean {
    return polygonIntersectsBufferedPointCoordinates(polygon, point.x, point.y, radius);
}

function polygonIntersectsBufferedPointCoordinates(polygon: Polygon, x: number, y: number, radius: number): boolean {
    if (polygonContainsCoordinates(polygon, x, y)) return true;
    return coordinatesIntersectBufferedLine(x, y, polygon, radius);
}

function polygonIntersectsMultiPolygon(polygon: Polygon, multiPolygon: FeatureGeometry): boolean {

    if (polygon.length === 1) {
        return geometryContainsCoordinates(multiPolygon, polygon[0].x, polygon[0].y);
    }

    const partCount = getGeometryPartCount(multiPolygon);
    for (let partIndex = 0; partIndex < partCount; partIndex++) {
        const partLength = getGeometryPartLength(multiPolygon, partIndex);
        for (let pointIndex = 0; pointIndex < partLength; pointIndex++) {
            if (polygonContainsCoordinates(
                polygon,
                getGeometryX(multiPolygon, partIndex, pointIndex),
                getGeometryY(multiPolygon, partIndex, pointIndex),
            )) return true;
        }
    }

    for (const point of polygon) {
        if (geometryContainsCoordinates(multiPolygon, point.x, point.y)) return true;
    }

    for (let partIndex = 0; partIndex < partCount; partIndex++) {
        if (lineIntersectsGeometryPart(polygon, multiPolygon, partIndex)) return true;
    }

    return false;
}

function polygonIntersectsBufferedMultiLine(polygon: Polygon, multiLine: FeatureGeometry, radius: number): boolean {
    const partCount = getGeometryPartCount(multiLine);
    for (let partIndex = 0; partIndex < partCount; partIndex++) {
        const partLength = getGeometryPartLength(multiLine, partIndex);

        if (polygon.length >= 3) {
            for (let pointIndex = 0; pointIndex < partLength; pointIndex++) {
                if (polygonContainsCoordinates(
                    polygon,
                    getGeometryX(multiLine, partIndex, pointIndex),
                    getGeometryY(multiLine, partIndex, pointIndex),
                )) return true;
            }
        }

        if (lineIntersectsBufferedGeometryPart(polygon, multiLine, partIndex, radius)) return true;
    }
    return false;
}

function lineIntersectsBufferedGeometryPart(lineA: Line, lineB: FeatureGeometry, partIndex: number, radius: number) {
    const partLength = getGeometryPartLength(lineB, partIndex);

    if (lineA.length > 1) {
        if (lineIntersectsGeometryPart(lineA, lineB, partIndex)) return true;

        // Check whether any point in either line is within radius of the other line
        for (let pointIndex = 0; pointIndex < partLength; pointIndex++) {
            if (coordinatesIntersectBufferedLine(
                getGeometryX(lineB, partIndex, pointIndex),
                getGeometryY(lineB, partIndex, pointIndex),
                lineA,
                radius,
            )) return true;
        }
    }

    for (const point of lineA) {
        if (coordinatesIntersectBufferedGeometryPart(point.x, point.y, lineB, partIndex, radius)) return true;
    }

    return false;
}

function lineIntersectsGeometryPart(lineA: Line, lineB: FeatureGeometry, partIndex: number): boolean {
    const partLength = getGeometryPartLength(lineB, partIndex);
    if (lineA.length === 0 || partLength === 0) return false;
    for (let i = 0; i < lineA.length - 1; i++) {
        const a0 = lineA[i];
        const a1 = lineA[i + 1];
        for (let j = 0; j < partLength - 1; j++) {
            if (lineSegmentIntersectsCoordinates(
                a0.x,
                a0.y,
                a1.x,
                a1.y,
                getGeometryX(lineB, partIndex, j),
                getGeometryY(lineB, partIndex, j),
                getGeometryX(lineB, partIndex, j + 1),
                getGeometryY(lineB, partIndex, j + 1),
            )) return true;
        }
    }
    return false;
}

function lineIntersectsLine(lineA: Line, lineB: Line) {
    if (lineA.length === 0 || lineB.length === 0) return false;
    for (let i = 0; i < lineA.length - 1; i++) {
        const a0 = lineA[i];
        const a1 = lineA[i + 1];
        for (let j = 0; j < lineB.length - 1; j++) {
            const b0 = lineB[j];
            const b1 = lineB[j + 1];
            if (lineSegmentIntersectsLineSegment(a0, a1, b0, b1)) return true;
        }
    }
    return false;
}

function lineSegmentIntersectsLineSegment(a0: Point, a1: Point, b0: Point, b1: Point) {
    return lineSegmentIntersectsCoordinates(a0.x, a0.y, a1.x, a1.y, b0.x, b0.y, b1.x, b1.y);
}

function lineSegmentIntersectsCoordinates(
    a0x: number,
    a0y: number,
    a1x: number,
    a1y: number,
    b0x: number,
    b0y: number,
    b1x: number,
    b1y: number,
): boolean {
    return isCounterClockwiseCoordinates(a0x, a0y, b0x, b0y, b1x, b1y) !==
            isCounterClockwiseCoordinates(a1x, a1y, b0x, b0y, b1x, b1y) &&
        isCounterClockwiseCoordinates(a0x, a0y, a1x, a1y, b0x, b0y) !==
            isCounterClockwiseCoordinates(a0x, a0y, a1x, a1y, b1x, b1y);
}

function isCounterClockwiseCoordinates(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
): boolean {
    return (cy - ay) * (bx - ax) > (by - ay) * (cx - ax);
}

function coordinatesIntersectBufferedLine(x: number, y: number, line: Line, radius: number) {
    const radiusSquared = radius * radius;

    if (line.length === 1) return coordinatesDistanceSquared(x, y, line[0].x, line[0].y) < radiusSquared;

    for (let i = 1; i < line.length; i++) {
        // Find line segments that have a distance <= radius^2 to p
        // In that case, we treat the line as "containing point p".
        const v = line[i - 1], w = line[i];
        if (distToSegmentSquaredCoordinates(x, y, v.x, v.y, w.x, w.y) < radiusSquared) return true;
    }
    return false;
}

function coordinatesIntersectBufferedGeometryPart(
    x: number,
    y: number,
    geometry: FeatureGeometry,
    partIndex: number,
    radius: number,
): boolean {
    const radiusSquared = radius * radius;
    const partLength = getGeometryPartLength(geometry, partIndex);
    if (partLength === 1) {
        return coordinatesDistanceSquared(
            x,
            y,
            getGeometryX(geometry, partIndex, 0),
            getGeometryY(geometry, partIndex, 0),
        ) < radiusSquared;
    }
    for (let pointIndex = 1; pointIndex < partLength; pointIndex++) {
        if (distToSegmentSquaredCoordinates(
            x,
            y,
            getGeometryX(geometry, partIndex, pointIndex - 1),
            getGeometryY(geometry, partIndex, pointIndex - 1),
            getGeometryX(geometry, partIndex, pointIndex),
            getGeometryY(geometry, partIndex, pointIndex),
        ) < radiusSquared) return true;
    }
    return false;
}

// Code from https://stackoverflow.com/a/1501725/331379.
function distToSegmentSquared(p: Point, v: Point, w: Point): number {
    return distToSegmentSquaredCoordinates(p.x, p.y, v.x, v.y, w.x, w.y);
}

export function distToSegmentSquaredCoordinates(px: number, py: number, vx: number, vy: number, wx: number, wy: number): number {
    const dx = wx - vx;
    const dy = wy - vy;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return coordinatesDistanceSquared(px, py, vx, vy);
    const t = ((px - vx) * dx + (py - vy) * dy) / lengthSquared;
    if (t < 0) return coordinatesDistanceSquared(px, py, vx, vy);
    if (t > 1) return coordinatesDistanceSquared(px, py, wx, wy);
    return coordinatesDistanceSquared(px, py, vx + t * dx, vy + t * dy);
}

function coordinatesDistanceSquared(ax: number, ay: number, bx: number, by: number): number {
    const dx = ax - bx;
    const dy = ay - by;
    return dx * dx + dy * dy;
}

// point in polygon ray casting algorithm
function geometryContainsCoordinates(geometry: FeatureGeometry, x: number, y: number): boolean {
    let c = false;
    const partCount = getGeometryPartCount(geometry);

    for (let partIndex = 0; partIndex < partCount; partIndex++) {
        const partLength = getGeometryPartLength(geometry, partIndex);
        for (let i = 0, j = partLength - 1; i < partLength; j = i++) {
            const p1x = getGeometryX(geometry, partIndex, i);
            const p1y = getGeometryY(geometry, partIndex, i);
            const p2x = getGeometryX(geometry, partIndex, j);
            const p2y = getGeometryY(geometry, partIndex, j);
            if (((p1y > y) !== (p2y > y)) && (x < (p2x - p1x) * (y - p1y) / (p2y - p1y) + p1x)) {
                c = !c;
            }
        }
    }
    return c;
}

function polygonContainsPoint(ring: Ring, p: Point) {
    return polygonContainsCoordinates(ring, p.x, p.y);
}

function polygonContainsCoordinates(ring: Ring, x: number, y: number) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const p1 = ring[i];
        const p2 = ring[j];
        if (((p1.y > y) !== (p2.y > y)) && (x < (p2.x - p1.x) * (y - p1.y) / (p2.y - p1.y) + p1.x)) {
            c = !c;
        }
    }
    return c;
}

function polygonIntersectsBox(ring: Ring, boxX1: number, boxY1: number, boxX2: number, boxY2: number): boolean {
    for (const p of ring) {
        if (boxX1 <= p.x &&
            boxY1 <= p.y &&
            boxX2 >= p.x &&
            boxY2 >= p.y) return true;
    }

    const corners = [
        new Point(boxX1, boxY1),
        new Point(boxX1, boxY2),
        new Point(boxX2, boxY2),
        new Point(boxX2, boxY1)];

    if (ring.length > 2) {
        for (const corner of corners) {
            if (polygonContainsPoint(ring, corner)) return true;
        }
    }

    for (let i = 0; i < ring.length - 1; i++) {
        const p1 = ring[i];
        const p2 = ring[i + 1];
        if (edgeIntersectsBox(p1, p2, corners)) return true;
    }

    return false;
}

function edgeIntersectsBox(e1: Point, e2: Point, corners: Point[]) {
    const tl = corners[0];
    const br = corners[2];
    // the edge and box do not intersect in either the x or y dimensions
    if (((e1.x < tl.x) && (e2.x < tl.x)) ||
        ((e1.x > br.x) && (e2.x > br.x)) ||
        ((e1.y < tl.y) && (e2.y < tl.y)) ||
        ((e1.y > br.y) && (e2.y > br.y))) return false;

    // check if all corners of the box are on the same side of the edge
    const dir = isCounterClockwise(e1, e2, corners[0]);
    return dir !== isCounterClockwise(e1, e2, corners[1]) ||
        dir !== isCounterClockwise(e1, e2, corners[2]) ||
        dir !== isCounterClockwise(e1, e2, corners[3]);
}
