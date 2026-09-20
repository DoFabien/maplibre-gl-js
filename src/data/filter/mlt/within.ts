import {GEOMETRY_TYPE, type FeatureTable} from '@maplibre/mlt';
import {forEachFeatureGeometryPart} from '../../bucket/columnar/geometry_traversal.ts';
import VectorUtils from '../../bucket/columnar/vectorUtils.ts';

export type CanonicalWithinTileID = {z: number; x: number; y: number};
export type WithinGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;

type BBox = [number, number, number, number];
type ProjectedPoint = [number, number];
type ProjectedPolygon = ProjectedPoint[][];
type ProjectedPolygons = ProjectedPolygon[];

const EVALUATION_EXTENT = 8192;
const MIN_COORDINATE = -16384;
const MAX_COORDINATE = 16383;

function emptyBBox(): BBox {
    return [Infinity, Infinity, -Infinity, -Infinity];
}

function updateBBox(bbox: BBox, x: number, y: number): void {
    bbox[0] = Math.min(bbox[0], x);
    bbox[1] = Math.min(bbox[1], y);
    bbox[2] = Math.max(bbox[2], x);
    bbox[3] = Math.max(bbox[3], y);
}

function boxWithinBox(inner: BBox, outer: BBox): boolean {
    return inner[0] > outer[0] && inner[2] < outer[2] && inner[1] > outer[1] && inner[3] < outer[3];
}

function projectPosition(position: GeoJSON.Position, canonical: CanonicalWithinTileID): ProjectedPoint {
    const mercatorX = (180 + position[0]) / 360;
    const mercatorY = (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (position[1] * Math.PI) / 360))) / 360;
    const worldSize = Math.pow(2, canonical.z) * EVALUATION_EXTENT;
    return [Math.round(mercatorX * worldSize), Math.round(mercatorY * worldSize)];
}

function projectPolygon(coordinates: GeoJSON.Position[][], canonical: CanonicalWithinTileID, bbox: BBox): ProjectedPolygon {
    return coordinates.map((ring) => ring.map((position) => {
        const point = projectPosition(position, canonical);
        updateBBox(bbox, point[0], point[1]);
        return point;
    }));
}

function pointOnBoundary(x: number, y: number, start: ProjectedPoint, end: ProjectedPoint): boolean {
    const x1 = x - start[0];
    const y1 = y - start[1];
    const x2 = x - end[0];
    const y2 = y - end[1];
    return x1 * y2 - x2 * y1 === 0 && x1 * x2 <= 0 && y1 * y2 <= 0;
}

function pointWithinPolygon(x: number, y: number, polygon: ProjectedPolygon): boolean {
    let inside = false;
    for (const ring of polygon) {
        for (let index = 0; index < ring.length - 1; index++) {
            const start = ring[index];
            const end = ring[index + 1];
            if (pointOnBoundary(x, y, start, end)) return false;
            if (
                (start[1] > y) !== (end[1] > y) &&
                x < ((end[0] - start[0]) * (y - start[1])) / (end[1] - start[1]) + start[0]
            ) {
                inside = !inside;
            }
        }
    }
    return inside;
}

function pointWithinPolygons(x: number, y: number, polygons: ProjectedPolygons): boolean {
    return polygons.some((polygon) => pointWithinPolygon(x, y, polygon));
}

function pointsOnDifferentSides(
    firstX: number,
    firstY: number,
    secondX: number,
    secondY: number,
    edgeStartX: number,
    edgeStartY: number,
    edgeEndX: number,
    edgeEndY: number
): boolean {
    const edgeX = edgeEndX - edgeStartX;
    const edgeY = edgeEndY - edgeStartY;
    const firstDeterminant = (firstX - edgeStartX) * edgeY - edgeX * (firstY - edgeStartY);
    const secondDeterminant = (secondX - edgeStartX) * edgeY - edgeX * (secondY - edgeStartY);
    return (firstDeterminant > 0 && secondDeterminant < 0) || (firstDeterminant < 0 && secondDeterminant > 0);
}

function segmentsIntersect(
    firstStartX: number,
    firstStartY: number,
    firstEndX: number,
    firstEndY: number,
    secondStart: ProjectedPoint,
    secondEnd: ProjectedPoint
): boolean {
    const firstVectorX = firstEndX - firstStartX;
    const firstVectorY = firstEndY - firstStartY;
    const secondVectorX = secondEnd[0] - secondStart[0];
    const secondVectorY = secondEnd[1] - secondStart[1];
    if (secondVectorX * firstVectorY - secondVectorY * firstVectorX === 0) return false;

    return pointsOnDifferentSides(firstStartX, firstStartY, firstEndX, firstEndY, secondStart[0], secondStart[1], secondEnd[0], secondEnd[1]) &&
        pointsOnDifferentSides(secondStart[0], secondStart[1], secondEnd[0], secondEnd[1], firstStartX, firstStartY, firstEndX, firstEndY);
}

function segmentIntersectsPolygon(startX: number, startY: number, endX: number, endY: number, polygon: ProjectedPolygon): boolean {
    for (const ring of polygon) {
        for (let index = 0; index < ring.length - 1; index++) {
            if (segmentsIntersect(startX, startY, endX, endY, ring[index], ring[index + 1])) return true;
        }
    }
    return false;
}

function normalizeFeatureCoordinate(value: number, scale: number): number {
    return Math.max(MIN_COORDINATE, Math.min(MAX_COORDINATE, Math.round(value * scale)));
}

function shiftXToPolygon(x: number, polygonBBox: BBox, worldSize: number): number {
    if (x >= polygonBBox[0] && x <= polygonBBox[2]) return x;

    const halfWorldSize = worldSize * 0.5;
    let shift = x - polygonBBox[0] > halfWorldSize
        ? -worldSize
        : polygonBBox[0] - x > halfWorldSize
            ? worldSize
            : 0;
    if (shift === 0) {
        shift = x - polygonBBox[2] > halfWorldSize
            ? -worldSize
            : polygonBBox[2] - x > halfWorldSize
                ? worldSize
                : 0;
    }
    return x + shift;
}

export function normalizeWithinGeometry(geojson: GeoJSON.GeoJSON): WithinGeometry | undefined {
    if (geojson.type === 'Polygon' || geojson.type === 'MultiPolygon') return geojson;
    if (geojson.type === 'Feature') {
        const geometry = geojson.geometry;
        return geometry?.type === 'Polygon' || geometry?.type === 'MultiPolygon' ? geometry : undefined;
    }
    if (geojson.type !== 'FeatureCollection') return undefined;

    const polygons: GeoJSON.Position[][][] = [];
    for (const feature of geojson.features) {
        const geometry = feature.geometry;
        if (geometry?.type === 'Polygon') polygons.push(geometry.coordinates);
        if (geometry?.type === 'MultiPolygon') polygons.push(...geometry.coordinates);
    }
    return polygons.length > 0 ? {type: 'MultiPolygon', coordinates: polygons} : undefined;
}

export class ColumnarWithinEvaluator {
    private readonly polygons: ProjectedPolygons;
    private readonly polygonBBox: BBox;
    private readonly worldSize: number;
    private readonly tileShiftX: number;
    private readonly tileShiftY: number;

    constructor(geometry: WithinGeometry, canonical: CanonicalWithinTileID) {
        this.polygonBBox = emptyBBox();
        this.polygons = geometry.type === 'Polygon'
            ? [projectPolygon(geometry.coordinates, canonical, this.polygonBBox)]
            : geometry.coordinates.map((polygon) => projectPolygon(polygon, canonical, this.polygonBBox));
        this.worldSize = Math.pow(2, canonical.z) * EVALUATION_EXTENT;
        this.tileShiftX = canonical.x * EVALUATION_EXTENT;
        this.tileShiftY = canonical.y * EVALUATION_EXTENT;
    }

    evaluate(featureTable: FeatureTable, featureIndex: number): boolean {
        const geometryType = featureTable.geometryVector.geometryType(featureIndex);
        if (geometryType === GEOMETRY_TYPE.POINT || geometryType === GEOMETRY_TYPE.MULTIPOINT) {
            return this.pointsWithin(featureTable, featureIndex);
        }
        if (geometryType === GEOMETRY_TYPE.LINESTRING || geometryType === GEOMETRY_TYPE.MULTILINESTRING) {
            return this.linesWithin(featureTable, featureIndex);
        }
        return false;
    }

    private featureVertexX(featureTable: FeatureTable, vertexIndex: number): number {
        const scale = EVALUATION_EXTENT / featureTable.extent;
        return normalizeFeatureCoordinate(VectorUtils.getVertexX(featureTable.geometryVector, vertexIndex), scale) + this.tileShiftX;
    }

    private featureVertexY(featureTable: FeatureTable, vertexIndex: number): number {
        const scale = EVALUATION_EXTENT / featureTable.extent;
        return normalizeFeatureCoordinate(VectorUtils.getVertexY(featureTable.geometryVector, vertexIndex), scale) + this.tileShiftY;
    }

    private pointsWithin(featureTable: FeatureTable, featureIndex: number): boolean {
        const bbox = emptyBBox();
        forEachFeatureGeometryPart(featureTable, featureIndex, (_partIndex, start, end) => {
            for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                const x = this.featureVertexX(featureTable, vertexIndex);
                const y = this.featureVertexY(featureTable, vertexIndex);
                updateBBox(bbox, shiftXToPolygon(x, this.polygonBBox, this.worldSize), y);
            }
        });
        if (!boxWithinBox(bbox, this.polygonBBox)) return false;

        let within = true;
        forEachFeatureGeometryPart(featureTable, featureIndex, (_partIndex, start, end) => {
            for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                const x = shiftXToPolygon(this.featureVertexX(featureTable, vertexIndex), this.polygonBBox, this.worldSize);
                const y = this.featureVertexY(featureTable, vertexIndex);
                if (!pointWithinPolygons(x, y, this.polygons)) within = false;
            }
        });
        return within;
    }

    private linesWithin(featureTable: FeatureTable, featureIndex: number): boolean {
        const rawBBox = emptyBBox();
        forEachFeatureGeometryPart(featureTable, featureIndex, (_partIndex, start, end) => {
            for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                updateBBox(rawBBox, this.featureVertexX(featureTable, vertexIndex), this.featureVertexY(featureTable, vertexIndex));
            }
        });
        const shiftToPolygon = rawBBox[2] - rawBBox[0] <= this.worldSize * 0.5;
        const lineBBox = emptyBBox();
        forEachFeatureGeometryPart(featureTable, featureIndex, (_partIndex, start, end) => {
            for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                const rawX = this.featureVertexX(featureTable, vertexIndex);
                const y = this.featureVertexY(featureTable, vertexIndex);
                updateBBox(lineBBox, shiftToPolygon ? shiftXToPolygon(rawX, this.polygonBBox, this.worldSize) : rawX, y);
            }
        });
        if (!boxWithinBox(lineBBox, this.polygonBBox)) return false;

        let featureWithin = true;
        forEachFeatureGeometryPart(featureTable, featureIndex, (_partIndex, start, end) => {
            let partWithin = false;
            for (const polygon of this.polygons) {
                let polygonContainsPart = true;
                let previousX: number | undefined;
                let previousY: number | undefined;
                for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
                    const rawX = this.featureVertexX(featureTable, vertexIndex);
                    const x = shiftToPolygon ? shiftXToPolygon(rawX, this.polygonBBox, this.worldSize) : rawX;
                    const y = this.featureVertexY(featureTable, vertexIndex);
                    if (!pointWithinPolygon(x, y, polygon)) polygonContainsPart = false;
                    if (previousX !== undefined && previousY !== undefined && segmentIntersectsPolygon(previousX, previousY, x, y, polygon)) {
                        polygonContainsPart = false;
                    }
                    previousX = x;
                    previousY = y;
                }
                if (polygonContainsPart) {
                    partWithin = true;
                    break;
                }
            }
            if (!partWithin) featureWithin = false;
        });
        return featureWithin;
    }
}
