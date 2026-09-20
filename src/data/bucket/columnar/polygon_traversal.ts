import {GEOMETRY_TYPE, type FeatureTable, type IGeometryVector, type IGpuVector} from '@maplibre/mlt';

type GeometryVectorLike = IGeometryVector | IGpuVector;

type TopologyVectorLike = {
    geometryOffsets: Uint32Array;
    partOffsets: Uint32Array;
    ringOffsets: Uint32Array;
};

type PolygonPartRange = {
    firstPartOffset: number;
    secondPartOffset: number;
};

export type PolygonGeometryVisitor = (
    featureIndex: number,
    polygonIndex: number,
    firstPartOffset: number,
    secondPartOffset: number,
    topologyVector: TopologyVectorLike,
) => void;

export type PolygonRingVisitor = (
    ringIndex: number,
    firstRingOffset: number,
    secondRingOffset: number,
) => void;

export type VertexCoordinateVisitor = (
    x: number,
    y: number,
    vertexIndex: number,
) => void;

type TraversableFeatureTable = FeatureTable & {
    forEachFeaturePolygonGeometry?: (featureIndex: number, visitor: PolygonGeometryVisitor) => void;
    forEachPolygonRing?: (
        topologyVector: TopologyVectorLike,
        firstPartOffset: number,
        secondPartOffset: number,
        visitor: PolygonRingVisitor,
    ) => void;
    forEachVertexInRange?: (start: number, end: number, visitor: VertexCoordinateVisitor) => void;
};

const polygonFeatureRangeCache = new WeakMap<GeometryVectorLike, Array<PolygonPartRange[] | undefined>>();

function getGeometryVector(featureTable: FeatureTable): GeometryVectorLike {
    return featureTable.geometryVector;
}

function getTopologyVector(geometryVector: GeometryVectorLike): TopologyVectorLike {
    const topologyVector = geometryVector.topologyVector;
    if (!topologyVector) {
        throw new Error('Geometry traversal requires topology information');
    }

    return topologyVector as TopologyVectorLike;
}

function getPolygonFeatureRanges(
    geometryVector: GeometryVectorLike,
    topologyVector: TopologyVectorLike,
): Array<PolygonPartRange[] | undefined> {
    const cached = polygonFeatureRangeCache.get(geometryVector);
    if (cached) {
        return cached;
    }

    const ranges = new Array<PolygonPartRange[] | undefined>(geometryVector.numGeometries);
    const geometryOffsets = topologyVector.geometryOffsets;
    const partOffsets = topologyVector.partOffsets;
    let partOffsetCursor = 1;
    let geometryOffsetCursor = 1;

    for (let featureIndex = 0; featureIndex < geometryVector.numGeometries; featureIndex++) {
        const geometryType = geometryVector.geometryType(featureIndex);

        if (geometryType === GEOMETRY_TYPE.POLYGON) {
            ranges[featureIndex] = [{
                firstPartOffset: partOffsets[partOffsetCursor - 1],
                secondPartOffset: partOffsets[partOffsetCursor],
            }];
            partOffsetCursor++;
            if (ArrayBuffer.isView(geometryOffsets) && geometryOffsets.byteLength > 0) {
                geometryOffsetCursor++;
            }
            continue;
        }

        if (geometryType === GEOMETRY_TYPE.MULTIPOLYGON) {
            const numPolygons =
                ArrayBuffer.isView(geometryOffsets) && geometryOffsets.byteLength > 0
                    ? geometryOffsets[geometryOffsetCursor] - geometryOffsets[geometryOffsetCursor - 1]
                    : 1;
            geometryOffsetCursor++;

            const polygons = new Array<PolygonPartRange>(numPolygons);
            for (let polygonIndex = 0; polygonIndex < numPolygons; polygonIndex++) {
                polygons[polygonIndex] = {
                    firstPartOffset: partOffsets[partOffsetCursor - 1],
                    secondPartOffset: partOffsets[partOffsetCursor],
                };
                partOffsetCursor++;
            }
            ranges[featureIndex] = polygons;
        }
    }

    polygonFeatureRangeCache.set(geometryVector, ranges);
    return ranges;
}

export function forEachFeaturePolygonGeometry(
    featureTable: FeatureTable,
    featureIndex: number,
    visitor: PolygonGeometryVisitor,
): void {
    const traversableFeatureTable = featureTable as TraversableFeatureTable;
    if (typeof traversableFeatureTable.forEachFeaturePolygonGeometry === 'function') {
        traversableFeatureTable.forEachFeaturePolygonGeometry(featureIndex, visitor);
        return;
    }

    const geometryVector = getGeometryVector(featureTable);
    const topologyVector = getTopologyVector(geometryVector);
    const ranges = getPolygonFeatureRanges(geometryVector, topologyVector)[featureIndex];
    if (!ranges || ranges.length === 0) {
        return;
    }

    for (let polygonIndex = 0; polygonIndex < ranges.length; polygonIndex++) {
        const range = ranges[polygonIndex];
        visitor(featureIndex, polygonIndex, range.firstPartOffset, range.secondPartOffset, topologyVector);
    }
}

export function forEachPolygonRing(
    featureTable: FeatureTable,
    topologyVector: TopologyVectorLike,
    firstPartOffset: number,
    secondPartOffset: number,
    visitor: PolygonRingVisitor,
): void {
    const traversableFeatureTable = featureTable as TraversableFeatureTable;
    if (typeof traversableFeatureTable.forEachPolygonRing === 'function') {
        traversableFeatureTable.forEachPolygonRing(topologyVector, firstPartOffset, secondPartOffset, visitor);
        return;
    }

    const ringOffsets = topologyVector.ringOffsets;
    for (let ringIndex = firstPartOffset; ringIndex < secondPartOffset; ringIndex++) {
        visitor(ringIndex, ringOffsets[ringIndex], ringOffsets[ringIndex + 1]);
    }
}

export function forEachVertexInRange(
    featureTable: FeatureTable,
    start: number,
    end: number,
    visitor: VertexCoordinateVisitor,
): void {
    const traversableFeatureTable = featureTable as TraversableFeatureTable;
    if (typeof traversableFeatureTable.forEachVertexInRange === 'function') {
        traversableFeatureTable.forEachVertexInRange(start, end, visitor);
        return;
    }

    const geometryVector = getGeometryVector(featureTable);
    for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
        let x: number;
        let y: number;
        if ('getVertex' in geometryVector && typeof geometryVector.getVertex === 'function') {
            [x, y] = geometryVector.getVertex(vertexIndex);
        } else {
            const offset = vertexIndex * 2;
            x = geometryVector.vertexBuffer[offset];
            y = geometryVector.vertexBuffer[offset + 1];
        }
        visitor(x, y, vertexIndex);
    }
}
