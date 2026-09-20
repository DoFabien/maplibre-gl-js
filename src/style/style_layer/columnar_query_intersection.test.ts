import {describe, expect, test} from 'vitest';
import Point from '@mapbox/point-geometry';
import {mat4} from 'gl-matrix';
import {FillStyleLayer} from './fill_style_layer.ts';
import {LineStyleLayer} from './line_style_layer.ts';
import {FillExtrusionStyleLayer} from './fill_extrusion_style_layer.ts';
import {HeatmapStyleLayer} from './heatmap_style_layer.ts';
import {EvaluationParameters} from '../evaluation_parameters.ts';
import {MercatorTransform} from '../../geo/projection/mercator_transform.ts';
import {UnwrappedTileID, type CanonicalTileID} from '../../tile/tile_id.ts';

import type {GeometryView} from '../../util/geometry_view.ts';
import type {VectorTileFeatureLike} from '@maplibre/vt-pbf';

class ArrayBackedGeometryView implements GeometryView {
    materializeCalls = 0;

    constructor(private readonly geometry: Point[][], private readonly allowMaterialization = false) {}

    get partCount(): number {
        return this.geometry.length;
    }

    getPartLength(partIndex: number): number {
        return this.geometry[partIndex].length;
    }

    getX(partIndex: number, pointIndex: number): number {
        return this.geometry[partIndex][pointIndex].x;
    }

    getY(partIndex: number, pointIndex: number): number {
        return this.geometry[partIndex][pointIndex].y;
    }

    materialize(): Point[][] {
        this.materializeCalls++;
        if (!this.allowMaterialization) {
            throw new Error('query intersection must not materialize the geometry view');
        }
        return this.geometry;
    }
}

const transform = new MercatorTransform();
transform.resize(512, 512);
const feature = {
    type: 3,
    id: 1,
    extent: 8192,
    properties: {},
    loadGeometry: () => {
        throw new Error('query intersection must not load feature geometry');
    },
} as VectorTileFeatureLike;
const commonParams = {
    feature,
    featureState: {},
    zoom: 0,
    transform,
    pixelsToTileUnits: 1,
    pixelPosMatrix: mat4.create(),
    unwrappedTileID: new UnwrappedTileID(0, {z: 0, x: 0, y: 0} as CanonicalTileID),
    getElevation: undefined,
};

function recalculate<T extends FillStyleLayer | LineStyleLayer | FillExtrusionStyleLayer>(layer: T): T {
    layer.recalculate(new EvaluationParameters(0), []);
    return layer;
}

describe('style layer columnar query intersections', () => {
    test('heatmap intersects columnar vertices without materializing them', () => {
        const layer = new HeatmapStyleLayer({id: 'heatmap', type: 'heatmap', source: 'source', paint: {'heatmap-radius': 10}}, {});
        layer.recalculate(new EvaluationParameters(0), []);
        const geometry = [[new Point(10, 10), new Point(20, 20)]];
        const view = new ArrayBackedGeometryView(geometry);
        for (const [point, expected] of [[new Point(12, 12), true], [new Point(100, 100), false]] as const) {
            const params = {...commonParams, queryGeometry: [point]};
            expect(layer.queryIntersectsFeature({...params, geometry})).toBe(expected);
            expect(layer.queryIntersectsFeature({...params, geometry: view})).toBe(expected);
        }
        expect(view.materializeCalls).toBe(0);
    });

    test('fill consumes polygon coordinates directly', () => {
        const layer = recalculate(new FillStyleLayer({
            id: 'fill',
            type: 'fill',
            source: 'source',
            paint: {},
        }, {}));
        const geometry = [[
            new Point(0, 0),
            new Point(10, 0),
            new Point(10, 10),
            new Point(0, 10),
            new Point(0, 0),
        ]];
        const view = new ArrayBackedGeometryView(geometry);
        const params = {...commonParams, queryGeometry: [new Point(5, 5)]};

        expect(layer.queryIntersectsFeature({...params, geometry})).toBe(true);
        expect(layer.queryIntersectsFeature({...params, geometry: view})).toBe(true);
        expect(view.materializeCalls).toBe(0);
    });

    test('line consumes vertex ranges directly when line-offset is zero', () => {
        const layer = recalculate(new LineStyleLayer({
            id: 'line',
            type: 'line',
            source: 'source',
            paint: {'line-width': 4},
        }, {}));
        const geometry = [[new Point(0, 0), new Point(10, 0)]];
        const view = new ArrayBackedGeometryView(geometry);
        const params = {...commonParams, queryGeometry: [new Point(5, 1)]};

        expect(layer.queryIntersectsFeature({...params, geometry})).toBe(true);
        expect(layer.queryIntersectsFeature({...params, geometry: view})).toBe(true);
        expect(view.materializeCalls).toBe(0);
    });

    test('line materializes only the explicit non-zero line-offset fallback', () => {
        const layer = recalculate(new LineStyleLayer({
            id: 'line-offset',
            type: 'line',
            source: 'source',
            paint: {'line-width': 4, 'line-offset': 2},
        }, {}));
        const geometry = [[new Point(0, 0), new Point(10, 0)]];
        const view = new ArrayBackedGeometryView(geometry, true);

        layer.queryIntersectsFeature({
            ...commonParams,
            queryGeometry: [new Point(5, 3)],
            geometry: view,
        });

        expect(view.materializeCalls).toBe(1);
    });

    test('fill extrusion projects columnar vertices directly', () => {
        const layer = recalculate(new FillExtrusionStyleLayer({
            id: 'extrusion',
            type: 'fill-extrusion',
            source: 'source',
            paint: {'fill-extrusion-base': 0, 'fill-extrusion-height': 10},
        }, {}));
        const geometry = [[
            new Point(0, 0),
            new Point(10, 0),
            new Point(10, 10),
            new Point(0, 10),
            new Point(0, 0),
        ]];
        const view = new ArrayBackedGeometryView(geometry);
        const params = {...commonParams, queryGeometry: [new Point(5, 5)]};
        const pointResult = layer.queryIntersectsFeature({...params, geometry});

        expect(pointResult).not.toBe(false);
        expect(layer.queryIntersectsFeature({...params, geometry: view})).toBe(pointResult);
        expect(view.materializeCalls).toBe(0);
    });
});
