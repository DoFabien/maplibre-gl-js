import type Point from '@mapbox/point-geometry';

/**
 * Random-access view over a feature geometry. Implementations may expose
 * columnar vertex buffers without first rebuilding Point[][] arrays.
 */
export interface GeometryView {
    readonly partCount: number;
    getPartLength(partIndex: number): number;
    getX(partIndex: number, pointIndex: number): number;
    getY(partIndex: number, pointIndex: number): number;
    materialize(): Point[][];
}

export type FeatureGeometry = Point[][] | GeometryView;

export function isGeometryView(geometry: FeatureGeometry): geometry is GeometryView {
    return !Array.isArray(geometry);
}

export function getGeometryPartCount(geometry: FeatureGeometry): number {
    return isGeometryView(geometry) ? geometry.partCount : geometry.length;
}

export function getGeometryPartLength(geometry: FeatureGeometry, partIndex: number): number {
    return isGeometryView(geometry) ? geometry.getPartLength(partIndex) : geometry[partIndex].length;
}

export function getGeometryX(geometry: FeatureGeometry, partIndex: number, pointIndex: number): number {
    return isGeometryView(geometry) ? geometry.getX(partIndex, pointIndex) : geometry[partIndex][pointIndex].x;
}

export function getGeometryY(geometry: FeatureGeometry, partIndex: number, pointIndex: number): number {
    return isGeometryView(geometry) ? geometry.getY(partIndex, pointIndex) : geometry[partIndex][pointIndex].y;
}

export function materializeGeometry(geometry: FeatureGeometry): Point[][] {
    return isGeometryView(geometry) ? geometry.materialize() : geometry;
}

export function someGeometryVertex(
    geometry: FeatureGeometry,
    predicate: (x: number, y: number, partIndex: number, pointIndex: number) => boolean,
): boolean {
    const partCount = getGeometryPartCount(geometry);
    for (let partIndex = 0; partIndex < partCount; partIndex++) {
        const partLength = getGeometryPartLength(geometry, partIndex);
        for (let pointIndex = 0; pointIndex < partLength; pointIndex++) {
            if (predicate(
                getGeometryX(geometry, partIndex, pointIndex),
                getGeometryY(geometry, partIndex, pointIndex),
                partIndex,
                pointIndex,
            )) {
                return true;
            }
        }
    }
    return false;
}
