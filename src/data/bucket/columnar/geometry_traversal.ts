import {createGeometryPartIndex, GEOMETRY_TYPE, type FeatureTable, type GeometryPartIndex} from '@maplibre/mlt';
import Point from '@mapbox/point-geometry';

const partIndexes = new WeakMap<FeatureTable, GeometryPartIndex>();

function getPartIndex(featureTable: FeatureTable): GeometryPartIndex {
    let partIndex = partIndexes.get(featureTable);
    if (!partIndex) {
        partIndex = createGeometryPartIndex(featureTable.geometryVector);
        partIndexes.set(featureTable, partIndex);
    }
    return partIndex;
}

/**
 * Loads the geometry of a feature as vector tile features load theirs, in tile extent units: each part a ring
 * of points, the rings of polygons closed.
 */
export function loadFeatureGeometry(
    featureTable: FeatureTable,
    featureIndex: number,
    scaleFactor = 1,
): Point[][] {
    const geometryVector = featureTable.geometryVector;
    const mortonGeometry = 'mortonSettings' in geometryVector && geometryVector.mortonSettings
        ? geometryVector
        : undefined;
    const vertexOffsets = !mortonGeometry && 'vertexOffsets' in geometryVector
        ? geometryVector.vertexOffsets
        : undefined;
    const vertexBuffer = geometryVector.vertexBuffer;
    const geometryType = geometryVector.geometryType(featureIndex);
    const close = geometryType === GEOMETRY_TYPE.POLYGON || geometryType === GEOMETRY_TYPE.MULTIPOLYGON;
    const {featureParts, partVertices} = getPartIndex(featureTable);
    const geometry: Point[][] = [];

    for (let partIndex = featureParts[featureIndex]; partIndex < featureParts[featureIndex + 1]; partIndex++) {
        const start = partVertices[partIndex];
        const end = partVertices[partIndex + 1];
        const part = new Array<Point>(close && end > start ? end - start + 1 : end - start);
        for (let vertexIndex = start; vertexIndex < end; vertexIndex++) {
            let x: number;
            let y: number;
            if (mortonGeometry) {
                [x, y] = mortonGeometry.getVertex(vertexIndex);
            } else {
                const offset = (vertexOffsets ? vertexOffsets[vertexIndex] : vertexIndex) * 2;
                x = vertexBuffer[offset];
                y = vertexBuffer[offset + 1];
            }
            part[vertexIndex - start] = new Point(x * scaleFactor, y * scaleFactor);
        }
        if (close && end > start) {
            part[part.length - 1] = new Point(part[0].x, part[0].y);
        }
        geometry.push(part);
    }
    return geometry;
}
