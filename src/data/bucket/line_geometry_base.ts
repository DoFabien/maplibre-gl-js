import {EXTENT} from '../extent.ts';
import Point from '@mapbox/point-geometry';
import {
    EXTRUDE_SCALE,
    COS_HALF_SHARP_CORNER,
    SHARP_CORNER_OFFSET,
    DEG_PER_TRIANGLE,
    LINE_DISTANCE_SCALE,
    MAX_LINE_DISTANCE,
} from './line_geometry_constants.ts';

import type {LineLayoutArray} from '../array_types.g.ts';
import type {TriangleIndexArray} from '../array_types.g.ts';
import type {SegmentVector} from '../segment.ts';
import type {Segment} from '../segment.ts';

/** Minimal vertex type used by the shared geometry loop. Point satisfies this interface. */
export type LineVertex = { x: number; y: number };

/**
 * @internal
 * Abstract base class that holds the shared join/cap geometry math for both
 * LineBucket and ColumnarLineBucket.
 *
 * Each subclass provides:
 *   - The concrete buffer arrays / segment vector (abstract fields)
 *   - updateScaledDistance()  – lineClips ratio vs. plain distance
 *   - writeHalfVertex()       – how one vertex is written to the buffer(s)
 */
export abstract class LineGeometryBase {
    // ── Shared mutable state ─────────────────────────────────────────────
    distance = 0;
    totalDistance = 0;
    scaledDistance = 0;
    e1 = -1;
    e2 = -1;

    // ── Abstract fields (provided by the concrete bucket class) ──────────
    abstract layoutVertexArray: LineLayoutArray;
    abstract indexArray: TriangleIndexArray;
    abstract segments: SegmentVector;
    abstract overscaling: number;

    // ── Abstract methods ─────────────────────────────────────────────────

    /** Update scaledDistance from this.distance (lineClips ratio vs. plain). */
    abstract updateScaledDistance(): void;

    /**
     * Write one half-vertex to the concrete buffer array(s).
     * Called by addHalfVertex before it updates the index array.
     */
    protected abstract writeHalfVertex(
        x: number, y: number,
        extrudeX: number, extrudeY: number,
        round: boolean, up: boolean, dir: number,
        segment: Segment
    ): void;

    // ── Concrete shared methods ──────────────────────────────────────────

    /** Accumulate arc-length distance and refresh scaledDistance. */
    updateDistance(x1: number, y1: number, x2: number, y2: number): void {
        this.distance += Math.hypot(x2 - x1, y2 - y1);
        this.updateScaledDistance();
    }

    /**
     * Add two half-vertices (left + right extrusion) at position (x, y).
     *
     * @param p        - the line vertex position
     * @param normal   - vertex normal (unit vector perpendicular to segment)
     * @param endLeft  - extrude to shift the left vertex along the line
     * @param endRight - extrude to shift the right vertex along the line
     * @param segment  - the segment object to add the vertex to
     * @param round    - whether this is a round cap
     */
    addCurrentVertex(
        x: number, y: number,
        normal: Point,
        endLeft: number, endRight: number,
        segment: Segment,
        round = false
    ): void {
        this.addCurrentVertexXY(x, y, normal.x, normal.y, endLeft, endRight, segment, round);
    }

    addCurrentVertexXY(
        x: number, y: number,
        normalX: number, normalY: number,
        endLeft: number, endRight: number,
        segment: Segment,
        round = false
    ): void {
        // left and right extrude vectors, perpendicularly shifted by endLeft/endRight
        const leftX = normalX + normalY * endLeft;
        const leftY = normalY - normalX * endLeft;
        const rightX = -normalX + normalY * endRight;
        const rightY = -normalY - normalX * endRight;

        this.addHalfVertex(x, y, leftX, leftY, round, false, endLeft, segment);
        this.addHalfVertex(x, y, rightX, rightY, round, true, -endRight, segment);

        // There is a maximum "distance along the line" that we can store in the buffers.
        // When we get close to the distance, reset it to zero and add the vertex again with
        // a distance of zero. The max distance is determined by the number of bits we allocate
        // to `linesofar`.
        if (this.distance > MAX_LINE_DISTANCE / 2 && this.totalDistance === 0) {
            this.distance = 0;
            this.updateScaledDistance();
            this.addCurrentVertexXY(x, y, normalX, normalY, endLeft, endRight, segment, round);
        }
    }

    /**
     * Emit one half-vertex, update the index array, and advance e1/e2.
     */
    addHalfVertex(
        x: number, y: number,
        extrudeX: number, extrudeY: number,
        round: boolean, up: boolean, dir: number,
        segment: Segment
    ): void {
        this.writeHalfVertex(x, y, extrudeX, extrudeY, round, up, dir, segment);

        const e = segment.vertexLength++;
        if (this.e1 >= 0 && this.e2 >= 0) {
            this.indexArray.emplaceBack(this.e1, e, this.e2);
            segment.primitiveLength++;
        }
        if (up) {
            this.e2 = e;
        } else {
            this.e1 = e;
        }
    }

    /**
     * Main join/cap geometry loop.
     *
     * Preconditions (enforced by the caller):
     *  - vertices are already EXTENT-scaled
     *  - duplicate endpoints have been stripped (`vertices[0]` and `vertices[len-1]` are valid)
     *  - `vertices.length >= (isPolygon ? 3 : 2)`
     *  - this.distance / scaledDistance / totalDistance have been initialised by the caller
     */
    addLineGeometry(
        vertices: LineVertex[],
        isPolygon: boolean,
        join: string,
        cap: string,
        miterLimit: number,
        roundLimit: number
    ): void {
        if (join === 'bevel') miterLimit = 1.05;

        const sharpCornerOffset = this.overscaling <= 16
            ? SHARP_CORNER_OFFSET * EXTENT / (512 * this.overscaling)
            : 0;

        const len = vertices.length;
        const segment = this.segments.prepareSegment(len * 10, this.layoutVertexArray, this.indexArray);

        let currentVertex: LineVertex | undefined;
        let prevVertex: LineVertex | undefined;
        let nextVertex: LineVertex | undefined;
        let prevNormal: Point | undefined;
        let nextNormal: Point | undefined;

        this.e1 = this.e2 = -1;

        if (isPolygon) {
            currentVertex = vertices[len - 2];
            const fv = vertices[0];
            nextNormal = new Point(fv.x - currentVertex.x, fv.y - currentVertex.y)._unit()._perp();
        }

        for (let i = 0; i < len; i++) {
            nextVertex = i === len - 1
                ? (isPolygon ? vertices[1] : undefined) // polygon: treat last like first
                : vertices[i + 1];

            // if two consecutive vertices exist, skip the current one
            if (vertices[i].x === nextVertex?.x && vertices[i].y === nextVertex.y) continue;

            if (nextNormal) prevNormal = nextNormal;
            if (currentVertex) prevVertex = currentVertex;

            currentVertex = vertices[i];

            // Calculate the normal towards the next vertex in this line. In case
            // there is no next vertex, pretend that the line is continuing straight,
            // meaning that we are just using the previous normal.
            nextNormal = nextVertex
                ? new Point(nextVertex.x - currentVertex.x, nextVertex.y - currentVertex.y)._unit()._perp()
                : prevNormal;

            // If we still don't have a previous normal, this is the beginning of a
            // non-closed line, so we're doing a straight "join".
            prevNormal ||= nextNormal;

            // Determine the normal of the join extrusion. It is the angle bisector
            // of the segments between the previous line and the next line.
            // In the case of 180° angles, the prev and next normals cancel each other out:
            // prevNormal + nextNormal = (0, 0), its magnitude is 0, so the unit vector would be
            // undefined. In that case, we're keeping the joinNormal at (0, 0), so that the cosHalfAngle
            // below will also become 0 and miterLength will become Infinity.
            let joinNormal = prevNormal.add(nextNormal);
            if (joinNormal.x !== 0 || joinNormal.y !== 0) {
                joinNormal._unit();
            }
            /*  joinNormal     prevNormal
             *             ↖      ↑
             *                .________. prevVertex
             *                |
             * nextNormal  ←  |  currentVertex
             *                |
             *     nextVertex !
             *
             */

            // calculate cosines of the angle (and its half) using dot product
            const cosAngle = prevNormal.x * nextNormal.x + prevNormal.y * nextNormal.y;
            const cosHalfAngle = joinNormal.x * nextNormal.x + joinNormal.y * nextNormal.y;

            // Calculate the length of the miter (the ratio of the miter to the width)
            // as the inverse of cosine of the angle between next and join normals
            const miterLength = cosHalfAngle !== 0 ? 1 / cosHalfAngle : Infinity;

            // approximate angle from cosine
            const approxAngle = 2 * Math.sqrt(2 - 2 * cosHalfAngle);

            const isSharpCorner = cosHalfAngle < COS_HALF_SHARP_CORNER && prevVertex !== undefined && nextVertex !== undefined;
            const lineTurnsLeft = prevNormal.x * nextNormal.y - prevNormal.y * nextNormal.x > 0;

            if (isSharpCorner && i > 0) {
                const prevSegmentLength = Math.hypot(
                    currentVertex.x - prevVertex.x,
                    currentVertex.y - prevVertex.y
                );
                if (prevSegmentLength > 2 * sharpCornerOffset) {
                    const scale = sharpCornerOffset / prevSegmentLength;
                    const newPrevVertex: LineVertex = {
                        x: currentVertex.x - Math.round((currentVertex.x - prevVertex.x) * scale),
                        y: currentVertex.y - Math.round((currentVertex.y - prevVertex.y) * scale),
                    };
                    this.updateDistance(prevVertex.x, prevVertex.y, newPrevVertex.x, newPrevVertex.y);
                    this.addCurrentVertex(newPrevVertex.x, newPrevVertex.y, prevNormal, 0, 0, segment);
                    prevVertex = newPrevVertex;
                }
            }

            // The join if a middle vertex, otherwise the cap.
            const middleVertex = prevVertex !== undefined && nextVertex !== undefined;
            let currentJoin = middleVertex ? join : isPolygon ? 'butt' : cap;

            if (middleVertex && currentJoin === 'round') {
                if (miterLength < roundLimit) {
                    currentJoin = 'miter';
                } else if (miterLength <= 2) {
                    currentJoin = 'fakeround';
                }
            }

            if (currentJoin === 'miter' && miterLength > miterLimit) {
                currentJoin = 'bevel';
            }

            if (currentJoin === 'bevel') {
                // The maximum extrude length is 128 / 63 = 2 times the width of the line
                // so if miterLength >= 2 we need to draw a different type of bevel here.
                if (miterLength > 2) currentJoin = 'flipbevel';

                // If the miterLength is really small and the line bevel wouldn't be visible,
                // just draw a miter join to save a triangle.
                if (miterLength < miterLimit) currentJoin = 'miter';
            }

            // Calculate how far along the line the currentVertex is
            if (prevVertex !== undefined) {
                this.updateDistance(prevVertex.x, prevVertex.y, currentVertex.x, currentVertex.y);
            }

            if (currentJoin === 'miter') {
                joinNormal._mult(miterLength);
                this.addCurrentVertex(currentVertex.x, currentVertex.y, joinNormal, 0, 0, segment);

            } else if (currentJoin === 'flipbevel') {
                // miter is too big, flip the direction to make a beveled join
                if (miterLength > 100) {
                    // Almost parallel lines
                    joinNormal = nextNormal.mult(-1);
                } else {
                    const bevelLength = miterLength * prevNormal.add(nextNormal).mag() / prevNormal.sub(nextNormal).mag();
                    joinNormal._perp()._mult(bevelLength * (lineTurnsLeft ? -1 : 1));
                }
                this.addCurrentVertex(currentVertex.x, currentVertex.y, joinNormal, 0, 0, segment);
                this.addCurrentVertex(currentVertex.x, currentVertex.y, joinNormal.mult(-1), 0, 0, segment);

            } else if (currentJoin === 'bevel' || currentJoin === 'fakeround') {
                const offset = -Math.sqrt(miterLength * miterLength - 1);
                const offsetA = lineTurnsLeft ? offset : 0;
                const offsetB = lineTurnsLeft ? 0 : offset;

                // Close previous segment with a bevel
                if (prevVertex !== undefined) {
                    this.addCurrentVertex(currentVertex.x, currentVertex.y, prevNormal, offsetA, offsetB, segment);
                }

                if (currentJoin === 'fakeround') {
                    // The join angle is sharp enough that a round join would be visible.
                    // Bevel joins fill the gap between segments with a single pie slice triangle.
                    // Create a round join by adding multiple pie slices. The join isn't actually round, but
                    // it looks like it is at the sizes we render lines at.

                    // pick the number of triangles for approximating round join by based on the angle between normals
                    const n = Math.round((approxAngle * 180 / Math.PI) / DEG_PER_TRIANGLE);

                    for (let m = 1; m < n; m++) {
                        let t = m / n;
                        if (t !== 0.5) {
                            // approximate spherical interpolation https://observablehq.com/@mourner/approximating-geometric-slerp
                            const t2 = t - 0.5;
                            const A = 1.0904 + cosAngle * (-3.2452 + cosAngle * (3.55645 - cosAngle * 1.43519));
                            const B = 0.848013 + cosAngle * (-1.06021 + cosAngle * 0.215638);
                            t = t + t * t2 * (t - 1) * (A * t2 * t2 + B);
                        }
                        const extrude = nextNormal.sub(prevNormal)._mult(t)._add(prevNormal)._unit()._mult(lineTurnsLeft ? -1 : 1);
                        this.addHalfVertex(currentVertex.x, currentVertex.y, extrude.x, extrude.y, false, lineTurnsLeft, 0, segment);
                    }
                }

                if (nextVertex !== undefined) {
                    // Start next segment
                    this.addCurrentVertex(currentVertex.x, currentVertex.y, nextNormal, -offsetA, -offsetB, segment);
                }

            } else if (currentJoin === 'butt') {
                this.addCurrentVertex(currentVertex.x, currentVertex.y, joinNormal, 0, 0, segment); // butt cap

            } else if (currentJoin === 'square') {
                const offset = prevVertex !== undefined ? 1 : -1; // closing or starting square cap
                this.addCurrentVertex(currentVertex.x, currentVertex.y, joinNormal, offset, offset, segment);

            } else if (currentJoin === 'round') {
                if (prevVertex !== undefined) {
                    // Close previous segment with butt
                    this.addCurrentVertex(currentVertex.x, currentVertex.y, prevNormal, 0, 0, segment);

                    // Add round cap or linejoin at end of segment
                    this.addCurrentVertex(currentVertex.x, currentVertex.y, prevNormal, 1, 1, segment, true);
                }
                if (nextVertex !== undefined) {
                    // Add round cap before first segment
                    this.addCurrentVertex(currentVertex.x, currentVertex.y, nextNormal, -1, -1, segment, true);

                    // Start next segment with a butt
                    this.addCurrentVertex(currentVertex.x, currentVertex.y, nextNormal, 0, 0, segment);
                }
            }

            if (isSharpCorner && i < len - 1) {
                const nextSegmentLength = Math.hypot(
                    nextVertex.x - currentVertex.x,
                    nextVertex.y - currentVertex.y
                );
                if (nextSegmentLength > 2 * sharpCornerOffset) {
                    const scale = sharpCornerOffset / nextSegmentLength;
                    const newCurrentVertex: LineVertex = {
                        x: currentVertex.x + Math.round((nextVertex.x - currentVertex.x) * scale),
                        y: currentVertex.y + Math.round((nextVertex.y - currentVertex.y) * scale),
                    };
                    this.updateDistance(currentVertex.x, currentVertex.y, newCurrentVertex.x, newCurrentVertex.y);
                    this.addCurrentVertex(newCurrentVertex.x, newCurrentVertex.y, nextNormal, 0, 0, segment);
                    currentVertex = newCurrentVertex;
                }
            }
        }
    }

    /**
     * Variant of addLineGeometry that consumes an xyxy flattened buffer directly.
     * Used by the columnar MLT pipeline to avoid reconstructing per-vertex JS objects.
     */
    addLineGeometryFlat(
        verticesFlattened: number[],
        vertexCount: number,
        isPolygon: boolean,
        join: string,
        cap: string,
        miterLimit: number,
        roundLimit: number
    ): void {
        if (join === 'bevel') miterLimit = 1.05;

        const sharpCornerOffset = this.overscaling <= 16
            ? SHARP_CORNER_OFFSET * EXTENT / (512 * this.overscaling)
            : 0;

        const len = vertexCount;
        const segment = this.segments.prepareSegment(len * 10, this.layoutVertexArray, this.indexArray);

        if (!isPolygon && len === 2 && (cap === 'butt' || cap === 'square')) {
            this.e1 = this.e2 = -1;
            const x0 = verticesFlattened[0];
            const y0 = verticesFlattened[1];
            const x1 = verticesFlattened[2];
            const y1 = verticesFlattened[3];
            const magnitude = Math.hypot(x1 - x0, y1 - y0);
            const normalX = magnitude === 0 ? 0 : -(y1 - y0) / magnitude;
            const normalY = magnitude === 0 ? 0 : (x1 - x0) / magnitude;
            const startOffset = cap === 'square' ? -1 : 0;
            const endOffset = cap === 'square' ? 1 : 0;

            this.addCurrentVertexXY(x0, y0, normalX, normalY, startOffset, startOffset, segment);
            this.updateDistance(x0, y0, x1, y1);
            this.addCurrentVertexXY(x1, y1, normalX, normalY, endOffset, endOffset, segment);
            return;
        }

        let currentX = 0;
        let currentY = 0;
        let prevX = 0;
        let prevY = 0;
        let nextX = 0;
        let nextY = 0;
        let currentDefined = false;
        let prevDefined = false;
        let nextDefined = false;
        let prevNormalX = 0;
        let prevNormalY = 0;
        let nextNormalX = 0;
        let nextNormalY = 0;
        let prevNormalDefined = false;
        let nextNormalDefined = false;

        this.e1 = this.e2 = -1;

        if (isPolygon) {
            currentX = verticesFlattened[(len - 2) * 2];
            currentY = verticesFlattened[(len - 2) * 2 + 1];
            currentDefined = true;
            const firstX = verticesFlattened[0];
            const firstY = verticesFlattened[1];
            const magnitude = Math.hypot(firstX - currentX, firstY - currentY);
            nextNormalX = magnitude === 0 ? 0 : -(firstY - currentY) / magnitude;
            nextNormalY = magnitude === 0 ? 0 : (firstX - currentX) / magnitude;
            nextNormalDefined = true;
        }

        for (let i = 0; i < len; i++) {
            const currentOffset = i * 2;
            const sourceCurrentX = verticesFlattened[currentOffset];
            const sourceCurrentY = verticesFlattened[currentOffset + 1];
            let nextIndex = i + 1;
            if (nextIndex >= len) {
                nextIndex = isPolygon ? 1 : -1;
            }
            nextDefined = nextIndex >= 0;
            if (nextDefined) {
                nextX = verticesFlattened[nextIndex * 2];
                nextY = verticesFlattened[nextIndex * 2 + 1];
            }

            if (nextDefined && sourceCurrentX === nextX && sourceCurrentY === nextY) continue;

            if (nextNormalDefined) {
                prevNormalX = nextNormalX;
                prevNormalY = nextNormalY;
                prevNormalDefined = true;
            }
            if (currentDefined) {
                prevX = currentX;
                prevY = currentY;
                prevDefined = true;
            }

            currentX = sourceCurrentX;
            currentY = sourceCurrentY;
            currentDefined = true;

            if (nextDefined) {
                const magnitude = Math.hypot(nextX - currentX, nextY - currentY);
                nextNormalX = magnitude === 0 ? 0 : -(nextY - currentY) / magnitude;
                nextNormalY = magnitude === 0 ? 0 : (nextX - currentX) / magnitude;
                nextNormalDefined = true;
            } else {
                nextNormalX = prevNormalX;
                nextNormalY = prevNormalY;
                nextNormalDefined = prevNormalDefined;
            }

            if (!prevNormalDefined) {
                prevNormalX = nextNormalX;
                prevNormalY = nextNormalY;
                prevNormalDefined = nextNormalDefined;
            }

            let joinNormalX = prevNormalX + nextNormalX;
            let joinNormalY = prevNormalY + nextNormalY;
            const joinMagnitude = Math.hypot(joinNormalX, joinNormalY);
            if (joinMagnitude === 0) {
                joinNormalX = 0;
                joinNormalY = 0;
            } else {
                joinNormalX /= joinMagnitude;
                joinNormalY /= joinMagnitude;
            }

            const cosAngle = prevNormalX * nextNormalX + prevNormalY * nextNormalY;
            const cosHalfAngle = joinNormalX * nextNormalX + joinNormalY * nextNormalY;
            const miterLength = cosHalfAngle !== 0 ? 1 / cosHalfAngle : Infinity;
            const approxAngle = 2 * Math.sqrt(2 - 2 * cosHalfAngle);
            const isSharpCorner = cosHalfAngle < COS_HALF_SHARP_CORNER && prevDefined && nextDefined;
            const lineTurnsLeft = prevNormalX * nextNormalY - prevNormalY * nextNormalX > 0;

            if (isSharpCorner && i > 0) {
                const prevSegmentLength = Math.hypot(currentX - prevX, currentY - prevY);
                if (prevSegmentLength > 2 * sharpCornerOffset) {
                    const scale = sharpCornerOffset / prevSegmentLength;
                    const newPrevX = currentX - Math.round((currentX - prevX) * scale);
                    const newPrevY = currentY - Math.round((currentY - prevY) * scale);
                    this.updateDistance(prevX, prevY, newPrevX, newPrevY);
                    this.addCurrentVertexXY(newPrevX, newPrevY, prevNormalX, prevNormalY, 0, 0, segment);
                    prevX = newPrevX;
                    prevY = newPrevY;
                }
            }

            const middleVertex = prevDefined && nextDefined;
            let currentJoin = middleVertex ? join : isPolygon ? 'butt' : cap;

            if (middleVertex && currentJoin === 'round') {
                if (miterLength < roundLimit) {
                    currentJoin = 'miter';
                } else if (miterLength <= 2) {
                    currentJoin = 'fakeround';
                }
            }

            if (currentJoin === 'miter' && miterLength > miterLimit) {
                currentJoin = 'bevel';
            }

            if (currentJoin === 'bevel') {
                if (miterLength > 2) currentJoin = 'flipbevel';
                if (miterLength < miterLimit) currentJoin = 'miter';
            }

            if (prevDefined) {
                this.updateDistance(prevX, prevY, currentX, currentY);
            }

            if (currentJoin === 'miter') {
                this.addCurrentVertexXY(currentX, currentY, joinNormalX * miterLength, joinNormalY * miterLength, 0, 0, segment);

            } else if (currentJoin === 'flipbevel') {
                if (miterLength > 100) {
                    joinNormalX = -nextNormalX;
                    joinNormalY = -nextNormalY;
                } else {
                    const addMag = Math.hypot(prevNormalX + nextNormalX, prevNormalY + nextNormalY);
                    const subMag = Math.hypot(prevNormalX - nextNormalX, prevNormalY - nextNormalY);
                    const bevelLength = miterLength * addMag / subMag;
                    const sign = lineTurnsLeft ? -1 : 1;
                    const perpX = -joinNormalY;
                    const perpY = joinNormalX;
                    joinNormalX = perpX * bevelLength * sign;
                    joinNormalY = perpY * bevelLength * sign;
                }
                this.addCurrentVertexXY(currentX, currentY, joinNormalX, joinNormalY, 0, 0, segment);
                this.addCurrentVertexXY(currentX, currentY, -joinNormalX, -joinNormalY, 0, 0, segment);

            } else if (currentJoin === 'bevel' || currentJoin === 'fakeround') {
                const offset = -Math.sqrt(miterLength * miterLength - 1);
                const offsetA = lineTurnsLeft ? offset : 0;
                const offsetB = lineTurnsLeft ? 0 : offset;

                if (prevDefined) {
                    this.addCurrentVertexXY(currentX, currentY, prevNormalX, prevNormalY, offsetA, offsetB, segment);
                }

                if (currentJoin === 'fakeround') {
                    const n = Math.round((approxAngle * 180 / Math.PI) / DEG_PER_TRIANGLE);

                    for (let m = 1; m < n; m++) {
                        let t = m / n;
                        if (t !== 0.5) {
                            const t2 = t - 0.5;
                            const A = 1.0904 + cosAngle * (-3.2452 + cosAngle * (3.55645 - cosAngle * 1.43519));
                            const B = 0.848013 + cosAngle * (-1.06021 + cosAngle * 0.215638);
                            t = t + t * t2 * (t - 1) * (A * t2 * t2 + B);
                        }
                        let extrudeX = (nextNormalX - prevNormalX) * t + prevNormalX;
                        let extrudeY = (nextNormalY - prevNormalY) * t + prevNormalY;
                        const extrudeMagnitude = Math.hypot(extrudeX, extrudeY);
                        if (extrudeMagnitude === 0) {
                            extrudeX = 0;
                            extrudeY = 0;
                        } else {
                            extrudeX /= extrudeMagnitude;
                            extrudeY /= extrudeMagnitude;
                        }
                        if (lineTurnsLeft) {
                            extrudeX = -extrudeX;
                            extrudeY = -extrudeY;
                        }
                        this.addHalfVertex(currentX, currentY, extrudeX, extrudeY, false, lineTurnsLeft, 0, segment);
                    }
                }

                if (nextDefined) {
                    this.addCurrentVertexXY(currentX, currentY, nextNormalX, nextNormalY, -offsetA, -offsetB, segment);
                }

            } else if (currentJoin === 'butt') {
                this.addCurrentVertexXY(currentX, currentY, joinNormalX, joinNormalY, 0, 0, segment);

            } else if (currentJoin === 'square') {
                const offset = prevDefined ? 1 : -1;
                this.addCurrentVertexXY(currentX, currentY, joinNormalX, joinNormalY, offset, offset, segment);

            } else if (currentJoin === 'round') {
                if (prevDefined) {
                    this.addCurrentVertexXY(currentX, currentY, prevNormalX, prevNormalY, 0, 0, segment);
                    this.addCurrentVertexXY(currentX, currentY, prevNormalX, prevNormalY, 1, 1, segment, true);
                }
                if (nextDefined) {
                    this.addCurrentVertexXY(currentX, currentY, nextNormalX, nextNormalY, -1, -1, segment, true);
                    this.addCurrentVertexXY(currentX, currentY, nextNormalX, nextNormalY, 0, 0, segment);
                }
            }

            if (isSharpCorner && i < len - 1 && nextDefined) {
                const nextSegmentLength = Math.hypot(nextX - currentX, nextY - currentY);
                if (nextSegmentLength > 2 * sharpCornerOffset) {
                    const scale = sharpCornerOffset / nextSegmentLength;
                    const newCurrentX = currentX + Math.round((nextX - currentX) * scale);
                    const newCurrentY = currentY + Math.round((nextY - currentY) * scale);
                    this.updateDistance(currentX, currentY, newCurrentX, newCurrentY);
                    this.addCurrentVertexXY(newCurrentX, newCurrentY, nextNormalX, nextNormalY, 0, 0, segment);
                    currentX = newCurrentX;
                    currentY = newCurrentY;
                }
            }
        }
    }
}
