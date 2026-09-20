import Point from '@mapbox/point-geometry';
import {polygonIntersectsBufferedPointCoordinates} from '../util/intersection_tests.ts';
import {materializeGeometry, someGeometryVertex, type FeatureGeometry} from '../util/geometry_view.ts';

import type {PossiblyEvaluatedPropertyValue} from './properties.ts';
import type {StyleLayer} from '../style/style_layer.ts';
import type {CircleBucket} from '../data/bucket/circle_bucket.ts';
import type {LineBucket} from '../data/bucket/line_bucket.ts';
import type {IReadonlyTransform, GetElevation} from '../geo/transform_interface.ts';
import type {UnwrappedTileID} from '../tile/tile_id.ts';

export function getMaximumPaintValue(
    property: string,
    layer: StyleLayer,
    bucket: CircleBucket<any> | LineBucket
): number {
    const value = ((layer.paint as any).get(property) as PossiblyEvaluatedPropertyValue<any>).value;
    if (value.kind === 'constant') {
        return value.value;
    } else {
        return bucket.programConfigurations.get(layer.id).getMaxValue(property);
    }
}

export function translateDistance(translate: [number, number]): number {
    return Math.sqrt(translate[0] * translate[0] + translate[1] * translate[1]);
}

/**
 * @internal
 * Translates a geometry by a certain pixels in tile coordinates
 * @param queryGeometry - The geometry to translate in tile coordinates
 * @param translate - The translation in pixels
 * @param translateAnchor - The anchor of the translation
 * @param bearing - The bearing of the map
 * @param pixelsToTileUnits - The scale factor from pixels to tile units
 * @returns the translated geometry in tile coordinates
 */
export function translate(queryGeometry: Point[],
    translate: [number, number],
    translateAnchor: 'viewport' | 'map',
    bearing: number,
    pixelsToTileUnits: number): Point[] {
    if (!translate[0] && !translate[1]) {
        return queryGeometry;
    }
    const pt = Point.convert(translate)._mult(pixelsToTileUnits);

    if (translateAnchor === 'viewport') {
        pt._rotate(-bearing);
    }

    const translated: Point[] = [];
    for (const point of queryGeometry) {
        translated.push(point.sub(pt));
    }
    return translated;
}

/**
 * Filter out consecutive duplicate points from a line
 */
function _stripDuplicates(ring: Point[]): Point[] {
    const filteredRing: Point[] = [];
    for (let index = 0; index < ring.length; index++) {
        const point = ring[index];
        const prevPoint = filteredRing.at(-1);
        if (index === 0 || (prevPoint && !(point.equals(prevPoint)))) {
            filteredRing.push(point);
        }
    }
    return filteredRing;
}

export function offsetLine(geometry: FeatureGeometry, offset: number): Point[][] {
    const rings = materializeGeometry(geometry);
    const newRings: Point[][] = [];
    for (const rawRing of rings) {
        const ring = _stripDuplicates(rawRing);
        const newRing: Point[] = [];
        for (let index = 0; index < ring.length; index++) {
            const point = ring[index];
            const prevPoint = ring[index - 1];
            const nextPoint = ring[index + 1];
            // perpendicular unit vectors (outward unit normal vector):
            // these indicate which direction the segments should be offset in
            const unitNormalAB: Point = index === 0 ? new Point(0, 0) : point.sub(prevPoint)._unit()._perp();
            const unitNormalBC: Point = index === ring.length - 1 ? new Point(0, 0) : nextPoint.sub(point)._unit()._perp();
            // unit bisector direction
            const bisectorDir = unitNormalAB._add(unitNormalBC)._unit();
            const cosHalfAngle = bisectorDir.x * unitNormalBC.x + bisectorDir.y * unitNormalBC.y;
            if (cosHalfAngle !== 0) {
                bisectorDir._mult(1 / cosHalfAngle);
            }
            newRing.push(bisectorDir._mult(offset)._add(point));
        }
        newRings.push(newRing);
    }
    return newRings;
}

type CircleIntersectionTestParams = {
    queryGeometry: Point[];
    size: number;
    transform: IReadonlyTransform;
    unwrappedTileID: UnwrappedTileID;
    getElevation: GetElevation | undefined;
    pitchAlignment?: 'map' | 'viewport';
    pitchScale?: 'map' | 'viewport';
};

function intersectionTestMapMap({queryGeometry, size}: CircleIntersectionTestParams, x: number, y: number): boolean {
    return polygonIntersectsBufferedPointCoordinates(queryGeometry, x, y, size);
}

function intersectionTestMapViewport({queryGeometry, size, transform, unwrappedTileID, getElevation}: CircleIntersectionTestParams, x: number, y: number): boolean {
    const w = transform.projectTileCoordinates(x, y, unwrappedTileID, getElevation?.(x, y)).signedDistanceFromCamera;
    const adjustedSize = size * (w / transform.cameraToCenterDistance);
    return polygonIntersectsBufferedPointCoordinates(queryGeometry, x, y, adjustedSize);
}

function intersectionTestViewportMap({queryGeometry, size, transform, unwrappedTileID, getElevation}: CircleIntersectionTestParams, x: number, y: number): boolean {
    const projected = transform.projectTileCoordinates(x, y, unwrappedTileID, getElevation?.(x, y));
    const adjustedSize = size * (transform.cameraToCenterDistance / projected.signedDistanceFromCamera);
    const screenX = (projected.point.x * 0.5 + 0.5) * transform.width;
    const screenY = (-projected.point.y * 0.5 + 0.5) * transform.height;
    return polygonIntersectsBufferedPointCoordinates(queryGeometry, screenX, screenY, adjustedSize);
}

function intersectionTestViewportViewport({queryGeometry, size, transform, unwrappedTileID, getElevation}: CircleIntersectionTestParams, x: number, y: number): boolean {
    const projected = transform.projectTileCoordinates(x, y, unwrappedTileID, getElevation?.(x, y)).point;
    const screenX = (projected.x * 0.5 + 0.5) * transform.width;
    const screenY = (-projected.y * 0.5 + 0.5) * transform.height;
    return polygonIntersectsBufferedPointCoordinates(queryGeometry, screenX, screenY, size);
}

export function circleIntersection({
    queryGeometry,
    size,
    transform,
    unwrappedTileID,
    getElevation,
    pitchAlignment = 'map',
    pitchScale = 'map'
}: CircleIntersectionTestParams, geometry: FeatureGeometry): boolean {
    const intersectionTest = pitchAlignment === 'map'
        ? (pitchScale === 'map' ? intersectionTestMapMap : intersectionTestMapViewport)
        : (pitchScale === 'map' ? intersectionTestViewportMap : intersectionTestViewportViewport);

    const param = {queryGeometry, size, transform, unwrappedTileID, getElevation} as CircleIntersectionTestParams;
    return someGeometryVertex(geometry, (x, y) => intersectionTest(param, x, y));
}

function projectPoint(tilePoint: Point, transform: IReadonlyTransform, unwrappedTileID: UnwrappedTileID, getElevation: GetElevation | undefined): Point {
    // Convert `tilePoint` from tile coordinates to clip coordinates.
    const clipPoint = transform.projectTileCoordinates(tilePoint.x, tilePoint.y, unwrappedTileID, getElevation?.(tilePoint.x, tilePoint.y)).point;
    // Convert `clipPoint` from clip coordinates into pixel/screen coordinates.
    return new Point(
        (clipPoint.x * 0.5 + 0.5) * transform.width,
        (-clipPoint.y * 0.5 + 0.5) * transform.height
    );
}

export function projectQueryGeometry(queryGeometry: Point[], transform: IReadonlyTransform, unwrappedTileID: UnwrappedTileID, getElevation: GetElevation | undefined): Point[] {
    return queryGeometry.map((p) => {
        return projectPoint(p, transform, unwrappedTileID, getElevation);
    });
}
