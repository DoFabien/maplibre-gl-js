import {GeometryTopologyCursor, type FeatureTable} from '@maplibre/mlt';
import {EXTENT} from '../data/extent.ts';
import {clamp, warnOnce} from '../util/util.ts';
import {clipLineStreaming, type ScalarLineCursor} from './clip_line.ts';
import {getColumnarGeometryView} from '../data/bucket/columnar/geometry_traversal.ts';

import type {GeometryView} from '../util/geometry_view.ts';

type OffsetArray = Int32Array | Uint32Array;
type VertexBuffer = Int32Array | Uint32Array;

const BITS = 15;
const MAX_GEOMETRY_COORDINATE = Math.pow(2, BITS - 1) - 1;
const MIN_GEOMETRY_COORDINATE = -MAX_GEOMETRY_COORDINATE - 1;
const COORDINATE_KEY_WIDTH = MAX_GEOMETRY_COORDINATE - MIN_GEOMETRY_COORDINATE + 1;

/**
 * One immutable source range in the effective first line of a symbol feature.
 * The links are spliced in O(1) when adjacent features are merged.
 */
export type ColumnarLineSlice = {
    readonly featureTable: FeatureTable;
    readonly vertexStart: number;
    readonly rawPointCount: number;
    startPoint: number;
    readonly endPoint: number;
    next?: ColumnarLineSlice;
    previous?: ColumnarLineSlice;
};

type MutableColumnarLineSlice = {
    -readonly [Key in keyof ColumnarLineSlice]: ColumnarLineSlice[Key];
};

/**
 * Compact deque of source ranges. Endpoints and point count are cached so
 * mergeLines does not revisit topology or coordinates while hashing ends.
 */
export type ColumnarLineChain = {
    head?: ColumnarLineSlice;
    tail?: ColumnarLineSlice;
    pointCount: number;
    leftX: number;
    leftY: number;
    rightX: number;
    rightY: number;
};

export type ColumnarGeometryFeature = {
    index: number;
    columnarFeatureTable?: FeatureTable;
    columnarLineSlices?: ColumnarLineChain;
};

const topologyCursorCache = new WeakMap<FeatureTable, GeometryTopologyCursor>();

/** A synchronous polygon view preserves holes and multipart boundaries without Point arrays. */
export function forEachColumnarSymbolPolygon(feature: ColumnarGeometryFeature, visitor: (polygon: GeometryView, outer: number[]) => void): void {
    const table = feature.columnarFeatureTable;
    const ringCounts: number[] = [];
    getTopologyCursor(table, feature.index).forEachPart((_part, _start, _end, _close, polygon) => {
        ringCounts[polygon] = (ringCounts[polygon] ?? 0) + 1;
    });
    const geometry = getColumnarGeometryView(table, feature.index);
    let offset = 0;
    for (const count of ringCounts) {
        if (!count) continue;
        const first = offset;
        const polygon: GeometryView = {
            partCount: count,
            getPartLength: part => geometry.getPartLength(first + part),
            getX: (part, point) => geometry.getX(first + part, point),
            getY: (part, point) => geometry.getY(first + part, point),
            materialize() { throw new Error('Symbol polygon slices must remain columnar'); }
        };
        const outer: number[] = [];
        for (let point = 0; point < polygon.getPartLength(0); point++) {
            outer.push(polygon.getX(0, point), polygon.getY(0, point));
        }
        visitor(polygon, outer);
        offset += count;
    }
}

function getTopologyCursor(featureTable: FeatureTable, featureIndex: number): GeometryTopologyCursor {
    let cursor = topologyCursorCache.get(featureTable);
    if (!cursor) {
        cursor = new GeometryTopologyCursor(featureTable.geometryVector);
        topologyCursorCache.set(featureTable, cursor);
    }
    return cursor.seek(featureIndex);
}

/** Reads and scales both coordinates of a vertex in one operation. */
class ColumnarCoordinateReader {
    x = 0;
    y = 0;
    private readonly scale: number;
    private readonly vertexBuffer: VertexBuffer;
    private readonly vertexOffsets?: OffsetArray;
    private readonly mortonSettings?: {numBits: number; coordinateShift: number};

    constructor(featureTable: FeatureTable) {
        const geometryVector = featureTable.geometryVector;
        this.scale = EXTENT / featureTable.extent;
        this.vertexBuffer = geometryVector.vertexBuffer;
        this.vertexOffsets = 'vertexOffsets' in geometryVector && geometryVector.vertexOffsets?.length
            ? geometryVector.vertexOffsets
            : undefined;
        this.mortonSettings = 'mortonSettings' in geometryVector
            ? geometryVector.mortonSettings
            : undefined;
    }

    read(vertexIndex: number): void {
        let rawX: number;
        let rawY: number;

        // Morton vectors use an indirection into a scalar code buffer. Decode
        // both coordinates here so getVertex() does not allocate a tuple and
        // is not called once for X and once again for Y.
        if (this.vertexOffsets && this.mortonSettings) {
            const mortonCode = this.vertexBuffer[this.vertexOffsets[vertexIndex]];
            rawX = decodeMorton(mortonCode, this.mortonSettings.numBits) - this.mortonSettings.coordinateShift;
            rawY = decodeMorton(mortonCode >> 1, this.mortonSettings.numBits) - this.mortonSettings.coordinateShift;
        } else {
            const offset = (this.vertexOffsets ? this.vertexOffsets[vertexIndex] : vertexIndex) * 2;
            rawX = this.vertexBuffer[offset];
            rawY = this.vertexBuffer[offset + 1];
        }

        this.x = scaleCoordinate(rawX, this.scale);
        this.y = scaleCoordinate(rawY, this.scale);
    }
}

const coordinateReaderCache = new WeakMap<FeatureTable, ColumnarCoordinateReader>();

function getCoordinateReader(featureTable: FeatureTable): ColumnarCoordinateReader {
    let reader = coordinateReaderCache.get(featureTable);
    if (!reader) {
        reader = new ColumnarCoordinateReader(featureTable);
        coordinateReaderCache.set(featureTable, reader);
    }
    return reader;
}

function decodeMorton(code: number, numBits: number): number {
    let coordinate = 0;
    for (let bit = 0; bit < numBits; bit++) {
        coordinate |= (code & (1 << (2 * bit))) >> bit;
    }
    return coordinate;
}

function scaleCoordinate(coordinate: number, scale: number): number {
    const scaled = Math.round(coordinate * scale);
    const result = clamp(scaled, MIN_GEOMETRY_COORDINATE, MAX_GEOMETRY_COORDINATE);
    if (scaled < result || scaled > result + 1) {
        warnOnce('Geometry exceeds allowed extent, reduce your vector tile buffer size');
    }
    return result;
}

function createSlice(featureTable: FeatureTable, vertexStart: number, vertexEnd: number, close: boolean): ColumnarLineSlice {
    const rawPointCount = vertexEnd - vertexStart;
    return {
        featureTable,
        vertexStart,
        rawPointCount,
        startPoint: 0,
        endPoint: rawPointCount + (close && rawPointCount > 0 ? 1 : 0),
    };
}

function sliceVertexIndex(slice: ColumnarLineSlice, pointIndex: number): number {
    return pointIndex === slice.rawPointCount
        ? slice.vertexStart
        : slice.vertexStart + pointIndex;
}

function readSlicePoint(slice: ColumnarLineSlice, pointIndex: number): ColumnarCoordinateReader {
    const reader = getCoordinateReader(slice.featureTable);
    reader.read(sliceVertexIndex(slice, pointIndex));
    return reader;
}

function createFirstLineChain(feature: ColumnarGeometryFeature): ColumnarLineChain {
    const featureTable = feature.columnarFeatureTable;
    if (!featureTable) {
        throw new Error('Cannot read a columnar symbol line without a FeatureTable');
    }

    const topology = getTopologyCursor(featureTable, feature.index);
    if (topology.partCount === 0) {
        return {pointCount: 0, leftX: 0, leftY: 0, rightX: 0, rightY: 0};
    }

    topology.selectPart(0);
    const slice = createSlice(featureTable, topology.start, topology.end, topology.close);
    if (slice.endPoint === 0) {
        return {pointCount: 0, leftX: 0, leftY: 0, rightX: 0, rightY: 0};
    }

    const left = readSlicePoint(slice, slice.startPoint);
    const leftX = left.x;
    const leftY = left.y;
    const right = readSlicePoint(slice, slice.endPoint - 1);
    return {
        head: slice,
        tail: slice,
        pointCount: slice.endPoint - slice.startPoint,
        leftX,
        leftY,
        rightX: right.x,
        rightY: right.y,
    };
}

function firstLineChain(feature: ColumnarGeometryFeature): ColumnarLineChain {
    return feature.columnarLineSlices ??= createFirstLineChain(feature);
}

function trimFirstPoint(chain: ColumnarLineChain): void {
    let head = chain.head;
    while (head) {
        chain.pointCount--;
        head.startPoint++;
        if (head.startPoint < head.endPoint) break;
        head = head.next;
        if (head) head.previous = undefined;
    }
    chain.head = head;

    if (!head || chain.pointCount <= 0) {
        chain.head = undefined;
        chain.tail = undefined;
        chain.pointCount = 0;
        return;
    }

    const left = readSlicePoint(head, head.startPoint);
    chain.leftX = left.x;
    chain.leftY = left.y;
}

function adoptChain(target: ColumnarLineChain, source: ColumnarLineChain): void {
    target.head = source.head;
    target.tail = source.tail;
    target.pointCount = source.pointCount;
    target.leftX = source.leftX;
    target.leftY = source.leftY;
    target.rightX = source.rightX;
    target.rightY = source.rightY;
}

export function getColumnarFirstLineEndpoint(
    feature: ColumnarGeometryFeature,
    onRight: boolean,
): [number, number] {
    const chain = firstLineChain(feature);
    if (chain.pointCount === 0) {
        throw new Error('Cannot merge an empty columnar symbol line');
    }
    return onRight ? [chain.rightX, chain.rightY] : [chain.leftX, chain.leftY];
}

/** Exact numeric key for a signed 16-bit tile coordinate pair. */
export function getColumnarFirstLineEndpointKey(feature: ColumnarGeometryFeature, onRight: boolean): number {
    const chain = firstLineChain(feature);
    if (chain.pointCount === 0) {
        throw new Error('Cannot merge an empty columnar symbol line');
    }
    const x = onRight ? chain.rightX : chain.leftX;
    const y = onRight ? chain.rightY : chain.leftY;
    return (x - MIN_GEOMETRY_COORDINATE) * COORDINATE_KEY_WIDTH + (y - MIN_GEOMETRY_COORDINATE);
}

export function appendColumnarFirstLine(
    target: ColumnarGeometryFeature,
    incoming: ColumnarGeometryFeature,
): void {
    const targetChain = firstLineChain(target);
    const incomingChain = firstLineChain(incoming);
    trimFirstPoint(incomingChain);
    if (incomingChain.pointCount === 0) return;
    if (targetChain.pointCount === 0) {
        adoptChain(targetChain, incomingChain);
        return;
    }

    targetChain.tail.next = incomingChain.head;
    incomingChain.head.previous = targetChain.tail;
    targetChain.tail = incomingChain.tail;
    targetChain.pointCount += incomingChain.pointCount;
    targetChain.rightX = incomingChain.rightX;
    targetChain.rightY = incomingChain.rightY;
}

export function prependColumnarFirstLine(
    target: ColumnarGeometryFeature,
    incoming: ColumnarGeometryFeature,
): void {
    const targetChain = firstLineChain(target);
    const incomingChain = firstLineChain(incoming);
    trimFirstPoint(targetChain);
    if (incomingChain.pointCount === 0) return;
    if (targetChain.pointCount === 0) {
        adoptChain(targetChain, incomingChain);
        return;
    }

    incomingChain.tail.next = targetChain.head;
    targetChain.head.previous = incomingChain.tail;
    targetChain.head = incomingChain.head;
    targetChain.pointCount += incomingChain.pointCount;
    targetChain.leftX = incomingChain.leftX;
    targetChain.leftY = incomingChain.leftY;
}

class ColumnarLineCursor implements ScalarLineCursor {
    x = 0;
    y = 0;
    private slice?: ColumnarLineSlice;
    private pointIndex = 0;
    private standaloneSlice?: MutableColumnarLineSlice;

    resetChain(chain: ColumnarLineChain): this {
        this.slice = chain.head;
        this.pointIndex = this.slice?.startPoint ?? 0;
        return this;
    }

    resetRange(featureTable: FeatureTable, vertexStart: number, vertexEnd: number, close: boolean): this {
        const slice = this.standaloneSlice ??= {
            featureTable,
            vertexStart,
            rawPointCount: vertexEnd - vertexStart,
            startPoint: 0,
            endPoint: 0,
        };
        slice.featureTable = featureTable;
        slice.vertexStart = vertexStart;
        slice.rawPointCount = vertexEnd - vertexStart;
        slice.startPoint = 0;
        slice.endPoint = slice.rawPointCount + (close && slice.rawPointCount > 0 ? 1 : 0);
        slice.next = undefined;
        slice.previous = undefined;
        this.slice = this.standaloneSlice;
        this.pointIndex = 0;
        return this;
    }

    next(): boolean {
        while (this.slice && this.pointIndex >= this.slice.endPoint) {
            this.slice = this.slice.next;
            this.pointIndex = this.slice?.startPoint ?? 0;
        }
        if (!this.slice) return false;

        const reader = readSlicePoint(this.slice, this.pointIndex++);
        this.x = reader.x;
        this.y = reader.y;
        return true;
    }
}

function visitRemainingParts(
    feature: ColumnarGeometryFeature,
    cursor: ColumnarLineCursor,
    visitor: (cursor: ColumnarLineCursor, partIndex: number) => void,
): void {
    const featureTable = feature.columnarFeatureTable;
    if (!featureTable) return;
    const topology = getTopologyCursor(featureTable, feature.index);
    for (let partIndex = 1; partIndex < topology.partCount; partIndex++) {
        topology.selectPart(partIndex);
        visitor(cursor.resetRange(featureTable, topology.start, topology.end, topology.close), partIndex);
    }
}

/**
 * Visits each effective line part as one final scalar buffer. This entry point
 * is retained for line-center placement and tests; line placement uses the
 * streaming clipping variant below.
 */
export function forEachColumnarSymbolLine(
    feature: ColumnarGeometryFeature,
    visitor: (line: number[], partIndex: number) => void,
): void {
    if (!feature.columnarFeatureTable) return;
    const chain = firstLineChain(feature);
    if (chain.pointCount === 0) return;

    const cursor = new ColumnarLineCursor();
    const visit = (lineCursor: ColumnarLineCursor, partIndex: number) => {
        const line: number[] = [];
        while (lineCursor.next()) line.push(lineCursor.x, lineCursor.y);
        visitor(line, partIndex);
    };
    visit(cursor.resetChain(chain), 0);
    visitRemainingParts(feature, cursor, visit);
}

/**
 * Streams columnar source ranges directly into the clipping output. No
 * flattened source line is created between the MLT vectors and the final
 * clipped scalar buffers.
 */
export function forEachClippedColumnarSymbolLine(
    feature: ColumnarGeometryFeature,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    visitor: (line: number[], partIndex: number) => void,
): void {
    if (!feature.columnarFeatureTable) return;
    const chain = firstLineChain(feature);
    if (chain.pointCount === 0) return;

    const cursor = new ColumnarLineCursor();
    const visit = (lineCursor: ColumnarLineCursor, partIndex: number) => {
        clipLineStreaming(lineCursor, x1, y1, x2, y2, line => visitor(line, partIndex));
    };
    visit(cursor.resetChain(chain), 0);
    visitRemainingParts(feature, cursor, visit);
}
