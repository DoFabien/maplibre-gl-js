import {GEOMETRY_TYPE, GeometryTopologyCursor, GpuVector, type FeatureTable} from '@maplibre/mlt';
import {EXTENT} from '../../extent';
import {SegmentVector} from '../../segment';
import {isMltMaterializationStatsActive, recordMltMaterialization} from '../../../util/mlt_materialization_stats';

import type {FeatureIndexBBox} from '../../feature_index';
import type {FillLayoutArray, LineIndexArray, TriangleIndexArray} from '../../array_types.g';

const cursors = new WeakMap<GpuVector, GeometryTopologyCursor>();

/**
 * Appends an MLT mesh directly to the final fill arrays, with no Earcut, flattened
 * coordinate array or intermediate triangle list. MLT triangle offsets count
 * triangles; indices address vertices relative to the start of each feature.
 * Outlines remain required for antialiasing and per-polygon query bounds.
 *
 * The caller must exclude subdivision, poles and overzoom. Nonintegral scaling,
 * clamping, oversized features and unusable mesh indices return undefined before
 * writing anything, allowing the existing numeric outline path to take over.
 * An empty result means a valid feature with no triangles, not a fallback.
 */
export function appendPretriangulatedFill(
    table: FeatureTable,
    featureIndex: number,
    vertices: FillLayoutArray,
    triangles: TriangleIndexArray,
    lines: LineIndexArray,
    triangleSegments: SegmentVector,
    lineSegments: SegmentVector,
): FeatureIndexBBox[] | undefined {
    const geometry = table.geometryVector;
    const scale = EXTENT / table.extent;
    if (!(geometry instanceof GpuVector) || !geometry.topologyVector || !Number.isInteger(scale) || scale < 1) return;
    const offsets = geometry.triangleOffsets;
    const indices = geometry.indexBuffer;
    if (offsets?.length !== table.numFeatures + 1 || offsets[0] !== 0 || offsets[offsets.length - 1] * 3 !== indices.length) return;
    const firstTriangle = offsets[featureIndex];
    const lastTriangle = offsets[featureIndex + 1];
    if (lastTriangle < firstTriangle || lastTriangle * 3 > indices.length) return;
    if (firstTriangle === lastTriangle) return [];

    let cursor = cursors.get(geometry);
    if (!cursor) {
        cursor = new GeometryTopologyCursor(geometry);
        cursors.set(geometry, cursor);
    }
    cursor.seek(featureIndex);
    if (!cursor.partCount) return;
    const firstVertex = cursor.selectPart(0).start;
    const lastVertex = cursor.selectPart(cursor.partCount - 1).end;
    const vertexCount = lastVertex - firstVertex;
    const coordinates = geometry.vertexBuffer;
    if (vertexCount <= 0 || vertexCount >= SegmentVector.MAX_VERTEX_ARRAY_LENGTH || lastVertex * 2 > coordinates.length) return;
    for (let index = firstTriangle * 3; index < lastTriangle * 3; index++) {
        if (indices[index] < 0 || indices[index] >= vertexCount) return;
    }
    for (let offset = firstVertex * 2; offset < lastVertex * 2; offset++) {
        const value = coordinates[offset] * scale;
        if (value < -16384 || value > 16383) return;
    }
    if (cursor.geometryType !== GEOMETRY_TYPE.POLYGON && cursor.geometryType !== GEOMETRY_TYPE.MULTIPOLYGON) return;
    let usableOutlines = true;
    cursor.forEachPart((_part, start, end, close) => {
        let signedArea = 0;
        if (!close || end - start < 3 || start < firstVertex || end > lastVertex) {
            usableOutlines = false;
            return;
        }
        for (let vertex = start, previous = end - 1; vertex < end; previous = vertex++) {
            signedArea += (coordinates[previous * 2] - coordinates[vertex * 2]) *
                (coordinates[previous * 2 + 1] + coordinates[vertex * 2 + 1]);
        }
        usableOutlines &&= signedArea !== 0;
    });
    if (!usableOutlines) return;

    const triangleSegment = triangleSegments.prepareSegment(vertexCount, vertices, triangles);
    const lineSegment = lineSegments.prepareSegment(vertexCount, vertices, lines);
    const triangleBase = triangleSegment.vertexLength;
    const lineBase = lineSegment.vertexLength;
    vertices.reserve(vertices.length + vertexCount);
    for (let offset = firstVertex * 2; offset < lastVertex * 2; offset += 2) {
        vertices.emplaceBack(coordinates[offset] * scale, coordinates[offset + 1] * scale);
    }
    triangles.reserve(triangles.length + lastTriangle - firstTriangle);
    for (let index = firstTriangle * 3; index < lastTriangle * 3; index += 3) {
        const a = indices[index];
        const b = indices[index + 1];
        const c = indices[index + 2];
        const offsetA = (firstVertex + a) * 2;
        const offsetB = (firstVertex + b) * 2;
        const offsetC = (firstVertex + c) * 2;
        const cross = (coordinates[offsetB] - coordinates[offsetA]) * (coordinates[offsetC + 1] - coordinates[offsetA + 1]) -
            (coordinates[offsetB + 1] - coordinates[offsetA + 1]) * (coordinates[offsetC] - coordinates[offsetA]);
        triangles.emplaceBack(triangleBase + a, triangleBase + (cross > 0 ? c : b), triangleBase + (cross > 0 ? b : c));
    }

    const bboxes: FeatureIndexBBox[] = [];
    const firstLine = lines.length;
    lines.reserve(lines.length + vertexCount);
    cursor.forEachPart((_part, start, end, _close, polygon) => {
        let bbox = bboxes[polygon];
        bbox ||= bboxes[polygon] = [Infinity, Infinity, -Infinity, -Infinity];
        for (let vertex = start; vertex < end; vertex++) {
            const x = coordinates[vertex * 2] * scale;
            const y = coordinates[vertex * 2 + 1] * scale;
            bbox[0] = Math.min(bbox[0], x);
            bbox[1] = Math.min(bbox[1], y);
            bbox[2] = Math.max(bbox[2], x);
            bbox[3] = Math.max(bbox[3], y);
            if (vertex + 1 < end) lines.emplaceBack(lineBase + vertex - firstVertex, lineBase + vertex + 1 - firstVertex);
        }
        if (end > start && (coordinates[start * 2] !== coordinates[(end - 1) * 2] || coordinates[start * 2 + 1] !== coordinates[(end - 1) * 2 + 1])) {
            lines.emplaceBack(lineBase + end - 1 - firstVertex, lineBase + start - firstVertex);
        }
    });
    triangleSegment.vertexLength += vertexCount;
    triangleSegment.primitiveLength += lastTriangle - firstTriangle;
    lineSegment.vertexLength += vertexCount;
    lineSegment.primitiveLength += lines.length - firstLine;
    if (isMltMaterializationStatsActive()) {
        recordMltMaterialization('pretriangulatedFillFeatures');
        recordMltMaterialization('pretriangulatedFillTriangles', lastTriangle - firstTriangle);
    }
    return bboxes;
}
