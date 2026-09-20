import {GEOMETRY_TYPE, GeometryTopologyCursor, type FeatureTable} from '@maplibre/mlt';
import Point from '@mapbox/point-geometry';
import {isMltMaterializationStatsActive, recordMltMaterialization} from '../../../util/mlt_materialization_stats.ts';
import {clamp, warnOnce} from '../../../util/util.ts';
import {EXTENT} from '../../extent.ts';
import VectorUtils from './vectorUtils';

import type {GeometryView} from '../../../util/geometry_view.ts';

const BITS = 15;
const MAX_GEOMETRY_COORDINATE = Math.pow(2, BITS - 1) - 1;
const MIN_GEOMETRY_COORDINATE = -MAX_GEOMETRY_COORDINATE - 1;

export type GeometryPartVisitor = (
    partIndex: number,
    start: number,
    end: number,
    close: boolean,
) => void;

export type GeometryVertexVisitor = (
    x: number,
    y: number,
    vertexIndex: number,
    partIndex: number,
) => void;

export type ColumnarGeometryRangeIndex = {
    featurePartOffsets: Uint32Array;
    partStarts: Uint32Array;
    partEnds: Uint32Array;
    partCloses: Uint8Array;
};

type ProjectedRing = {
    coordinates: number[][];
    signedArea: number;
};

const geometryTopologyCursorCache = new WeakMap<FeatureTable, GeometryTopologyCursor>();
const columnarGeometryViewCache = new WeakMap<FeatureTable, ColumnarGeometryView>();

function getGeometryTopologyCursor(featureTable: FeatureTable, featureIndex: number): GeometryTopologyCursor {
    let cursor = geometryTopologyCursorCache.get(featureTable);
    if (!cursor) {
        cursor = new GeometryTopologyCursor(featureTable.geometryVector);
        geometryTopologyCursorCache.set(featureTable, cursor);
    }
    return cursor.seek(featureIndex);
}

/**
 * Reusable view over one FeatureTable geometry. Coordinates are exposed in the
 * common MapLibre tile extent, with polygon closure represented virtually.
 * Only the current part's scalar bounds are cached; another consumer can move
 * the shared topology cursor without invalidating these immutable bounds.
 */
export class ColumnarGeometryView implements GeometryView {
    private featureIndex = 0;
    private readonly scale: number;
    private cachedPartIndex = -1;
    private partStart = 0;
    private partEnd = 0;
    private partClose = false;

    constructor(readonly featureTable: FeatureTable) {
        this.scale = EXTENT / featureTable.extent;
    }

    setIndex(featureIndex: number): this {
        this.featureIndex = featureIndex;
        this.cachedPartIndex = -1;
        getGeometryTopologyCursor(this.featureTable, featureIndex);
        return this;
    }

    get partCount(): number {
        return this.cursor().partCount;
    }

    getPartLength(partIndex: number): number {
        this.selectPart(partIndex);
        return this.partEnd - this.partStart + (this.partClose ? 1 : 0);
    }

    getX(partIndex: number, pointIndex: number): number {
        return this.scaleCoordinate(VectorUtils.getVertexX(
            this.featureTable.geometryVector,
            this.getVertexIndex(partIndex, pointIndex),
        ));
    }

    getY(partIndex: number, pointIndex: number): number {
        return this.scaleCoordinate(VectorUtils.getVertexY(
            this.featureTable.geometryVector,
            this.getVertexIndex(partIndex, pointIndex),
        ));
    }

    materialize(): Point[][] {
        const partCount = this.partCount;
        const geometry = new Array<Point[]>(partCount);
        const collectStats = isMltMaterializationStatsActive();
        const geometryVector = this.featureTable.geometryVector;
        const mortonGeometry = 'mortonSettings' in geometryVector && geometryVector.mortonSettings
            ? geometryVector
            : undefined;
        const vertexOffsets = !mortonGeometry && 'vertexOffsets' in geometryVector
            ? geometryVector.vertexOffsets
            : undefined;
        const vertexBuffer = geometryVector.vertexBuffer;
        let pointCount = 0;
        let coordinateTupleCount = 0;

        for (let partIndex = 0; partIndex < partCount; partIndex++) {
            const cursor = this.cursor(partIndex);
            const rawLength = cursor.end - cursor.start;
            const part = new Array<Point>(rawLength + (cursor.close ? 1 : 0));
            if (mortonGeometry) {
                if (collectStats) coordinateTupleCount += rawLength;
                for (let pointIndex = 0; pointIndex < rawLength; pointIndex++) {
                    const [x, y] = mortonGeometry.getVertex(cursor.start + pointIndex);
                    part[pointIndex] = new Point(
                        this.scaleCoordinate(x),
                        this.scaleCoordinate(y),
                    );
                }
            } else {
                for (let pointIndex = 0; pointIndex < rawLength; pointIndex++) {
                    const vertexIndex = cursor.start + pointIndex;
                    const offset = (vertexOffsets ? vertexOffsets[vertexIndex] : vertexIndex) * 2;
                    part[pointIndex] = new Point(
                        this.scaleCoordinate(vertexBuffer[offset]),
                        this.scaleCoordinate(vertexBuffer[offset + 1]),
                    );
                }
            }
            if (cursor.close && rawLength > 0) {
                part[rawLength] = new Point(part[0].x, part[0].y);
            }
            geometry[partIndex] = part;
            pointCount += part.length;
        }

        if (collectStats) {
            const context = {sourceLayerId: this.featureTable.name, detail: `feature ${this.featureIndex} query geometry`};
            recordMltMaterialization('geometryPartsMaterialized', partCount, context);
            recordMltMaterialization('pointObjects', pointCount, context);
            recordMltMaterialization('coordinateTuples', coordinateTupleCount, context);
        }

        return geometry;
    }

    private cursor(partIndex?: number): GeometryTopologyCursor {
        const cursor = getGeometryTopologyCursor(this.featureTable, this.featureIndex);
        return partIndex === undefined ? cursor : cursor.selectPart(partIndex);
    }

    private getVertexIndex(partIndex: number, pointIndex: number): number {
        this.selectPart(partIndex);
        const rawLength = this.partEnd - this.partStart;
        const partLength = rawLength + (this.partClose ? 1 : 0);
        if (pointIndex < 0 || pointIndex >= partLength) {
            throw new RangeError(`Geometry point ${pointIndex} is out of range for part ${partIndex}`);
        }
        return this.partStart + (this.partClose && pointIndex === rawLength ? 0 : pointIndex);
    }

    /** Copies bounds once per selected part, never retaining the shared cursor's mutable selection. */
    private selectPart(partIndex: number): void {
        if (partIndex === this.cachedPartIndex && partIndex >= 0) return;
        const cursor = this.cursor(partIndex);
        this.partStart = cursor.start;
        this.partEnd = cursor.end;
        this.partClose = cursor.close;
        this.cachedPartIndex = partIndex;
    }

    private scaleCoordinate(coordinate: number): number {
        const scaled = Math.round(coordinate * this.scale);
        const result = clamp(scaled, MIN_GEOMETRY_COORDINATE, MAX_GEOMETRY_COORDINATE);
        if (scaled < result || scaled > result + 1) {
            warnOnce('Geometry exceeds allowed extent, reduce your vector tile buffer size');
        }
        return result;
    }
}

export function getColumnarGeometryView(featureTable: FeatureTable, featureIndex: number): ColumnarGeometryView {
    let geometry = columnarGeometryViewCache.get(featureTable);
    if (!geometry) {
        geometry = new ColumnarGeometryView(featureTable);
        columnarGeometryViewCache.set(featureTable, geometry);
    }
    return geometry.setIndex(featureIndex);
}

export function forEachFeatureGeometryPart(
    featureTable: FeatureTable,
    featureIndex: number,
    visitor: GeometryPartVisitor,
): void {
    getGeometryTopologyCursor(featureTable, featureIndex).forEachPart(visitor);
}

export function forEachFeatureVertex(
    featureTable: FeatureTable,
    featureIndex: number,
    visitor: GeometryVertexVisitor,
): void {
    const geometryVector = featureTable.geometryVector;
    forEachFeatureGeometryPart(featureTable, featureIndex, (partIndex, start, end) => {
        for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
            visitor(
                VectorUtils.getVertexX(geometryVector, vertexIndex),
                VectorUtils.getVertexY(geometryVector, vertexIndex),
                vertexIndex,
                partIndex
            );
        }
    });
}

/**
 * Builds an O(1) random-access topology index for the public MVT-compatible
 * adapter. Native rendering and query paths keep using the allocation-free
 * streaming cursor; this compact index is created only after public geometry
 * access is observed to be non-sequential.
 */
export function createColumnarGeometryRangeIndex(featureTable: FeatureTable): ColumnarGeometryRangeIndex {
    const cursor = new GeometryTopologyCursor(featureTable.geometryVector);
    const featurePartOffsets = new Uint32Array(featureTable.numFeatures + 1);
    const partStarts: number[] = [];
    const partEnds: number[] = [];
    const partCloses: number[] = [];

    for (let featureIndex = 0; featureIndex < featureTable.numFeatures; featureIndex++) {
        featurePartOffsets[featureIndex] = partStarts.length;
        cursor.seek(featureIndex).forEachPart((_partIndex, start, end, close) => {
            partStarts.push(start);
            partEnds.push(end);
            partCloses.push(close ? 1 : 0);
        });
    }
    featurePartOffsets[featureTable.numFeatures] = partStarts.length;

    return {
        featurePartOffsets,
        partStarts: Uint32Array.from(partStarts),
        partEnds: Uint32Array.from(partEnds),
        partCloses: Uint8Array.from(partCloses),
    };
}

export function loadFeatureGeometry(
    featureTable: FeatureTable,
    featureIndex: number,
    scaleFactor = 1,
    rangeIndex?: ColumnarGeometryRangeIndex,
): Point[][] {
    const geometryVector = featureTable.geometryVector;
    const cursor = rangeIndex ? undefined : getGeometryTopologyCursor(featureTable, featureIndex);
    const firstPart = rangeIndex?.featurePartOffsets[featureIndex] ?? 0;
    const topologyPartCount = rangeIndex
        ? rangeIndex.featurePartOffsets[featureIndex + 1] - firstPart
        : cursor.partCount;
    const geometry = new Array<Point[]>(topologyPartCount);
    const mortonGeometry = 'mortonSettings' in geometryVector && geometryVector.mortonSettings
        ? geometryVector
        : undefined;
    const vertexOffsets = !mortonGeometry && 'vertexOffsets' in geometryVector
        ? geometryVector.vertexOffsets
        : undefined;
    const vertexBuffer = geometryVector.vertexBuffer;
    const collectStats = isMltMaterializationStatsActive();
    let pointCount = 0;
    let partCount = 0;
    let coordinateTupleCount = 0;

    for (let partIndex = 0; partIndex < topologyPartCount; partIndex++) {
        const indexedPart = firstPart + partIndex;
        const start = rangeIndex ? rangeIndex.partStarts[indexedPart] : cursor.selectPart(partIndex).start;
        const end = rangeIndex ? rangeIndex.partEnds[indexedPart] : cursor.end;
        const close = rangeIndex ? rangeIndex.partCloses[indexedPart] === 1 : cursor.close;
        if (collectStats) {
            partCount++;
            pointCount += end - start + (close && end > start ? 1 : 0);
        }
        const part = new Array<Point>(close ? end - start + 1 : end - start);
        if (mortonGeometry) {
            if (collectStats) coordinateTupleCount += end - start;
            for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                const [x, y] = mortonGeometry.getVertex(vertexIndex);
                part[vertexIndex - start] = new Point(x * scaleFactor, y * scaleFactor);
            }
        } else {
            if (scaleFactor === 1) {
                for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                    const offset = (vertexOffsets ? vertexOffsets[vertexIndex] : vertexIndex) * 2;
                    part[vertexIndex - start] = new Point(vertexBuffer[offset], vertexBuffer[offset + 1]);
                }
            } else {
                for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                    const offset = (vertexOffsets ? vertexOffsets[vertexIndex] : vertexIndex) * 2;
                    part[vertexIndex - start] = new Point(
                        vertexBuffer[offset] * scaleFactor,
                        vertexBuffer[offset + 1] * scaleFactor,
                    );
                }
            }
        }

        if (close && part.length > 0) {
            part[part.length - 1] = new Point(part[0].x, part[0].y);
        }

        geometry[partIndex] = part;
    }

    if (collectStats) {
        recordMltMaterialization('geometryPartsMaterialized', partCount, {sourceLayerId: featureTable.name});
        recordMltMaterialization('pointObjects', pointCount, {sourceLayerId: featureTable.name});
        recordMltMaterialization('coordinateTuples', coordinateTupleCount, {sourceLayerId: featureTable.name});
    }

    return geometry;
}

/**
 * Projects one public MLT feature directly into GeoJSON coordinate arrays.
 * Unlike the MVT-compatible `loadGeometry()` boundary, this path does not
 * create `Point` objects that would immediately be discarded by toGeoJSON().
 * Preserves MVT ring classification, including its single-ring and empty-polygon
 * cases; zero-area rings are discarded only when there are multiple rings.
 */
export function loadFeatureGeoJSONGeometry(
    featureTable: FeatureTable,
    featureIndex: number,
    x: number,
    y: number,
    z: number,
    rangeIndex?: ColumnarGeometryRangeIndex,
): GeoJSON.Geometry {
    const geometryVector = featureTable.geometryVector;
    const cursor = rangeIndex ? undefined : getGeometryTopologyCursor(featureTable, featureIndex);
    const firstPart = rangeIndex?.featurePartOffsets[featureIndex] ?? 0;
    const partCount = rangeIndex
        ? rangeIndex.featurePartOffsets[featureIndex + 1] - firstPart
        : cursor.partCount;
    const size = featureTable.extent * Math.pow(2, z);
    const x0 = featureTable.extent * x;
    const y0 = featureTable.extent * y;

    const project = (rawX: number, rawY: number): number[] => [
        (rawX + x0) * 360 / size - 180,
        360 / Math.PI * Math.atan(Math.exp((1 - (rawY + y0) * 2 / size) * Math.PI)) - 90,
    ];
    const readVertex = (vertexIndex: number): [number, number] => {
        if ('mortonSettings' in geometryVector && geometryVector.mortonSettings) {
            return geometryVector.getVertex(vertexIndex);
        }
        const vertexOffsets = 'vertexOffsets' in geometryVector ? geometryVector.vertexOffsets : undefined;
        const offset = (vertexOffsets ? vertexOffsets[vertexIndex] : vertexIndex) * 2;
        return [geometryVector.vertexBuffer[offset], geometryVector.vertexBuffer[offset + 1]];
    };
    const partRange = (partIndex: number): {start: number; end: number; close: boolean} => {
        const indexedPart = firstPart + partIndex;
        if (rangeIndex) {
            return {
                start: rangeIndex.partStarts[indexedPart],
                end: rangeIndex.partEnds[indexedPart],
                close: rangeIndex.partCloses[indexedPart] === 1,
            };
        }
        cursor.selectPart(partIndex);
        return {start: cursor.start, end: cursor.end, close: cursor.close};
    };
    const projectedPart = (partIndex: number): ProjectedRing => {
        const {start, end, close} = partRange(partIndex);
        const coordinates = new Array<number[]>(end - start + (close && end > start ? 1 : 0));
        let firstX = 0;
        let firstY = 0;
        let previousX = 0;
        let previousY = 0;
        let signedArea = 0;
        for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
            const [rawX, rawY] = readVertex(vertexIndex);
            const coordinateIndex = vertexIndex - start;
            coordinates[coordinateIndex] = project(rawX, rawY);
            if (coordinateIndex === 0) {
                firstX = rawX;
                firstY = rawY;
            } else {
                signedArea += previousX * rawY - rawX * previousY;
            }
            previousX = rawX;
            previousY = rawY;
        }
        if (end > start) signedArea += previousX * firstY - firstX * previousY;
        if (close && end > start) coordinates[coordinates.length - 1] = project(firstX, firstY);
        return {coordinates, signedArea};
    };

    const geometryType = geometryVector.geometryType(featureIndex);
    if (geometryType === GEOMETRY_TYPE.POINT || geometryType === GEOMETRY_TYPE.MULTIPOINT) {
        const coordinates = new Array<number[]>(partCount);
        for (let partIndex = 0; partIndex < partCount; partIndex++) {
            coordinates[partIndex] = projectedPart(partIndex).coordinates[0];
        }
        return coordinates.length === 1
            ? {type: 'Point', coordinates: coordinates[0]}
            : {type: 'MultiPoint', coordinates};
    }
    if (geometryType === GEOMETRY_TYPE.LINESTRING || geometryType === GEOMETRY_TYPE.MULTILINESTRING) {
        const coordinates = new Array<number[][]>(partCount);
        for (let partIndex = 0; partIndex < partCount; partIndex++) {
            coordinates[partIndex] = projectedPart(partIndex).coordinates;
        }
        return coordinates.length === 1
            ? {type: 'LineString', coordinates: coordinates[0]}
            : {type: 'MultiLineString', coordinates};
    }
    if (geometryType === GEOMETRY_TYPE.POLYGON || geometryType === GEOMETRY_TYPE.MULTIPOLYGON) {
        if (partCount <= 1) {
            return {type: 'Polygon', coordinates: partCount ? [projectedPart(0).coordinates] : []};
        }
        const polygons: number[][][][] = [];
        let polygon: number[][][] | undefined;
        let outerRingIsCounterClockwise: boolean | undefined;
        for (let partIndex = 0; partIndex < partCount; partIndex++) {
            const ring = projectedPart(partIndex);
            if (ring.signedArea === 0) continue;
            if (outerRingIsCounterClockwise === undefined) outerRingIsCounterClockwise = ring.signedArea < 0;
            if (outerRingIsCounterClockwise === ring.signedArea < 0) {
                if (polygon) polygons.push(polygon);
                polygon = [ring.coordinates];
            } else if (polygon) {
                polygon.push(ring.coordinates);
            }
        }
        if (polygon) polygons.push(polygon);
        return polygons.length === 1
            ? {type: 'Polygon', coordinates: polygons[0]}
            : {type: 'MultiPolygon', coordinates: polygons};
    }
    throw new Error(`unknown feature type: ${geometryType}`);
}
