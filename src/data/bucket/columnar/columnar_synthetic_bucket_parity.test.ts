import {describe, expect, test} from 'vitest';
import {featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {CanonicalTileID} from '../../../tile/tile_id';
import {createPopulateOptions} from '../../../../test/unit/lib/tile';
import {
    createSyntheticLegacyLineFeatures,
    createSyntheticLegacyPointFeatures,
    createSyntheticLegacyPolygonFeatures,
    createSyntheticLineFeatureTable,
    createSyntheticPointFeatureTable,
    createSyntheticPolygonFeatureTable,
    syntheticLineLayer,
    syntheticPointLayer,
    syntheticPolygonLayer,
} from '../../../../test/unit/lib/mlt_synthetic';
import {LineStyleLayer} from '../../../style/style_layer/line_style_layer';
import {FillStyleLayer} from '../../../style/style_layer/fill_style_layer';
import {CircleStyleLayer} from '../../../style/style_layer/circle_style_layer';
import {FillExtrusionStyleLayer} from '../../../style/style_layer/fill_extrusion_style_layer';
import {LineBucket} from '../line_bucket';
import {FillBucket} from '../fill_bucket';
import {CircleBucket} from '../circle_bucket';
import {FillExtrusionBucket} from '../fill_extrusion_bucket';
import {ColumnarLineBucket} from './columnar_line_bucket';
import {ColumnarFillBucket} from './columnar_fill_bucket';
import {ColumnarCircleBucket} from './columnar_circle_bucket';
import {ColumnarFillExtrusionBucket} from './columnar_fill_extrusion_bucket';
import {deserialize, serialize} from '../../../util/web_worker_transfer';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../../../util/mlt_materialization_stats.ts';

import type {BucketParameters} from '../../bucket';
import type {ZoomHistory} from '../../../style/zoom_history';
import type {EvaluationParameters} from '../../../style/evaluation_parameters';

function recalculate<T extends {recalculate: (parameters: EvaluationParameters, availableImages: string[]) => void}>(layer: T): T {
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

function applyFilter<T extends {filter: any; _featureFilter: any}>(layer: T, filterSpecification: any): T {
    layer.filter = filterSpecification;
    layer._featureFilter = featureFilter(filterSpecification, 'layers[columnar-synthetic-parity].filter');
    return layer;
}

function createLineLayer(layout?: Record<string, any>, paint?: Record<string, any>): LineStyleLayer {
    return recalculate(new LineStyleLayer({
        id: 'synthetic-line',
        source: 'source',
        'source-layer': syntheticLineLayer,
        type: 'line',
        layout,
        paint
    }, {}));
}

function createFillLayer(layout?: Record<string, any>, paint?: Record<string, any>): FillStyleLayer {
    return recalculate(new FillStyleLayer({
        id: 'synthetic-fill',
        source: 'source',
        'source-layer': syntheticPolygonLayer,
        type: 'fill',
        layout,
        paint
    }, {}));
}

function createCircleLayer(layout?: Record<string, any>, paint?: Record<string, any>): CircleStyleLayer {
    return recalculate(new CircleStyleLayer({
        id: 'synthetic-circle',
        source: 'source',
        'source-layer': syntheticPointLayer,
        type: 'circle',
        layout,
        paint
    }, {}));
}

function createFillExtrusionLayer(paint?: Record<string, any>): FillExtrusionStyleLayer {
    return recalculate(new FillExtrusionStyleLayer({
        id: 'synthetic-fill-extrusion',
        source: 'source',
        'source-layer': syntheticPolygonLayer,
        type: 'fill-extrusion',
        paint
    }, {}));
}

function structArrayBytes(array: {arrayBuffer: ArrayBuffer; length: number; bytesPerElement: number}): number[] {
    return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}

function expectPaintBytesEqual(legacy: {programConfigurations: any}, columnar: {programConfigurations: any}, layerId: string, property: string): void {
    const legacyBinder = legacy.programConfigurations.get(layerId).binders[property];
    const columnarBinder = columnar.programConfigurations.get(layerId).binders[property];
    expect(structArrayBytes(columnarBinder.paintVertexArray)).toEqual(structArrayBytes(legacyBinder.paintVertexArray));
}

/** Fails at the first materialization while leaving reference feature construction uninstrumented. */
function populateStrictly(populate: () => void): void {
    const deactivate = activateMltMaterializationStats(createMltMaterializationStats({strict: true}));
    try {
        populate();
    } finally {
        deactivate();
    }
}

describe('synthetic MLT columnar bucket parity', () => {
    const canonical = new CanonicalTileID(0, 0, 0);

    test.each([
        {name: 'constant paint', layout: undefined},
        {name: 'computed layout and sort', layout: {
            'line-join': ['case', ['==', ['get', 'kind'], 'primary'], 'round', 'bevel'],
            'line-sort-key': ['-', ['get', 'sort']],
        }},
    ])('line $name keeps properties columnar and preserves geometry buffers', ({layout}) => {
        const layer = createLineLayer(layout, {'line-width': 2});
        const legacy = new LineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);
        const columnar = new ColumnarLineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);
        legacy.populate(createSyntheticLegacyLineFeatures(), createPopulateOptions([]), canonical);
        populateStrictly(() => columnar.populate(createSyntheticLineFeatureTable(), createPopulateOptions([]), canonical));

        expect(columnar.layoutVertexArray.length).toBeGreaterThan(0);
        expect(structArrayBytes(columnar.layoutVertexArray as any)).toEqual(structArrayBytes(legacy.layoutVertexArray as any));
        expect(structArrayBytes(columnar.indexArray as any)).toEqual(structArrayBytes(legacy.indexArray as any));
    });

    test('line bucket matches legacy for multi-part lines, clips, sorting and data-driven paint', () => {
        const layer = applyFilter(createLineLayer(
            {'line-sort-key': ['get', 'sort']},
            {
                'line-width': ['get', 'width'],
                'line-color': ['case', ['==', ['get', 'kind'], 'primary'], '#ff0000', '#0000ff'],
                'line-opacity': ['/', ['get', 'opacity'], 10],
                'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#000000', 1, '#ffffff']
            }
        ), ['==', ['get', 'kind'], 'primary']);
        const legacyBucket = new LineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);
        const columnarBucket = new ColumnarLineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);

        legacyBucket.populate(createSyntheticLegacyLineFeatures(), createPopulateOptions([]), canonical);
        columnarBucket.populate(createSyntheticLineFeatureTable(), createPopulateOptions([]), canonical);

        expect(structArrayBytes(columnarBucket.layoutVertexArray as any)).toEqual(structArrayBytes(legacyBucket.layoutVertexArray as any));
        expect(structArrayBytes(columnarBucket.indexArray as any)).toEqual(structArrayBytes(legacyBucket.indexArray as any));
        expect(structArrayBytes(columnarBucket.layoutVertexArray2 as any)).toEqual(structArrayBytes(legacyBucket.layoutVertexArray2 as any));
        expect(columnarBucket.segments.get()).toEqual(legacyBucket.segments.get());
        expect(columnarBucket.lineClipsArray).toEqual(legacyBucket.lineClipsArray);
        expect(columnarBucket.maxLineLength).toBe(legacyBucket.maxLineLength);
        expectPaintBytesEqual(legacyBucket, columnarBucket, layer.id, 'line-width');
        expectPaintBytesEqual(legacyBucket, columnarBucket, layer.id, 'line-color');
        expectPaintBytesEqual(legacyBucket, columnarBucket, layer.id, 'line-opacity');
    });

    test('line match paint expressions use columnar paint arrays', () => {
        const layer = applyFilter(createLineLayer(undefined, {
            'line-width': 10,
            'line-color': [
                'match',
                ['get', 'kind'],
                'primary', '#ff0000',
                'secondary', '#0000ff',
                '#00ff00'
            ]
        }), ['match', ['get', 'kind'], ['primary', 'secondary'], true, false]);
        const legacyBucket = new LineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);
        const columnarBucket = new ColumnarLineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);

        legacyBucket.populate(createSyntheticLegacyLineFeatures(), createPopulateOptions([]), canonical);
        columnarBucket.populate(createSyntheticLineFeatureTable(), createPopulateOptions([]), canonical);

        expect((columnarBucket as any).programConfigurations.canPopulateColumnarPaintArrays((columnarBucket as any).getPaintPropertyColumn)).toBe(true);
        expectPaintBytesEqual(legacyBucket, columnarBucket, layer.id, 'line-color');
    });

    test('complex source paint expressions read columns without property objects', () => {
        const layer = createLineLayer(undefined, {
            'line-width': ['+', ['*', ['number', ['get', 'width']], 2], ['%', ['get', 'rank'], 2]],
            'line-opacity': ['min', 1, ['coalesce', ['/', ['get', 'opacity'], 10], 0.5]],
            'line-color': [
                'case',
                [
                    'all',
                    ['has', 'kind'],
                    ['in', ['get', 'kind'], ['literal', ['primary', 'service']]],
                    ['!', ['==', ['get', 'rank'], 999]],
                ],
                ['to-color', ['concat', '#', ['match', ['get', 'kind'], 'primary', 'ff0000', '00ff00']]],
                ['to-color', '#0000ff'],
            ],
        });
        const legacyBucket = new LineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);
        const columnarBucket = new ColumnarLineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);
        const binders = (columnarBucket as any).programConfigurations.get(layer.id).binders;
        expect(Object.fromEntries(['line-width', 'line-opacity', 'line-color'].map((property) => [property, !!binders[property].columnarEvaluator]))).toEqual({
            'line-width': true,
            'line-opacity': true,
            'line-color': true,
        });
        legacyBucket.populate(createSyntheticLegacyLineFeatures(), createPopulateOptions([]), canonical);
        const stats = createMltMaterializationStats({strict: true});
        const deactivate = activateMltMaterializationStats(stats);

        try {
            columnarBucket.populate(createSyntheticLineFeatureTable(), createPopulateOptions([]), canonical);
        } finally {
            deactivate();
        }

        expect((columnarBucket as any).programConfigurations.canPopulateColumnarPaintArrays((columnarBucket as any).getPaintPropertyColumn)).toBe(true);
        expect(stats.counters.propertyObjects).toBe(0);
        expect(stats.counters.propertyProxyMisses).toBe(0);
        expectPaintBytesEqual(legacyBucket, columnarBucket, layer.id, 'line-width');
        expectPaintBytesEqual(legacyBucket, columnarBucket, layer.id, 'line-opacity');
        expectPaintBytesEqual(legacyBucket, columnarBucket, layer.id, 'line-color');
    });

    test('fill bucket matches legacy for polygon holes, sort and data-driven paint', () => {
        const layer = applyFilter(createFillLayer(
            {'fill-sort-key': ['get', 'sort']},
            {
                'fill-color': ['case', ['==', ['get', 'kind'], 'park'], '#00ff00', '#ff0000'],
                'fill-opacity': ['/', ['get', 'opacity'], 10]
            }
        ), ['!=', ['get', 'kind'], 'outside']);
        const legacyBucket = new FillBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<FillStyleLayer>);
        const columnarBucket = new ColumnarFillBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<FillStyleLayer>);

        legacyBucket.populate(createSyntheticLegacyPolygonFeatures(), createPopulateOptions([]), canonical);
        columnarBucket.populate(createSyntheticPolygonFeatureTable(), createPopulateOptions([]), canonical);

        expect(columnarBucket.layoutVertexArray.length).toBeGreaterThan(0);
        expect(columnarBucket.indexArray.length).toBeGreaterThan(0);
        expect(columnarBucket.indexArray2.length).toBeGreaterThan(0);
        expect(legacyBucket.layoutVertexArray.length).toBeGreaterThan(0);
        expect(legacyBucket.indexArray.length).toBeGreaterThan(0);
        expect(legacyBucket.indexArray2.length).toBeGreaterThan(0);
        expectPaintBytesEqual(legacyBucket, columnarBucket, layer.id, 'fill-color');
        expectPaintBytesEqual(legacyBucket, columnarBucket, layer.id, 'fill-opacity');
    });

    test('circle bucket matches legacy for point filters, sorting and data-driven paint', () => {
        const layer = applyFilter(createCircleLayer(
            {'circle-sort-key': ['get', 'sort']},
            {
                'circle-radius': ['get', 'radius'],
                'circle-color': ['case', ['==', ['get', 'category'], 'poi'], '#ff0000', '#0000ff'],
                'circle-opacity': ['/', ['get', 'radius'], 12]
            }
        ), ['!=', ['get', 'category'], 'hidden']);
        const legacyBucket = new CircleBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<CircleStyleLayer>);
        const columnarBucket = new ColumnarCircleBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<CircleStyleLayer>);

        legacyBucket.populate(createSyntheticLegacyPointFeatures(), createPopulateOptions([]), canonical);
        columnarBucket.populate(createSyntheticPointFeatureTable(), createPopulateOptions([]), canonical);

        expect(structArrayBytes(columnarBucket.layoutVertexArray as any)).toEqual(structArrayBytes(legacyBucket.layoutVertexArray as any));
        expect(structArrayBytes(columnarBucket.indexArray as any)).toEqual(structArrayBytes(legacyBucket.indexArray as any));
        expect(columnarBucket.segments.get()).toEqual(legacyBucket.segments.get());
        expectPaintBytesEqual(legacyBucket, columnarBucket, layer.id, 'circle-radius');
        expectPaintBytesEqual(legacyBucket, columnarBucket, layer.id, 'circle-color');
        expectPaintBytesEqual(legacyBucket, columnarBucket, layer.id, 'circle-opacity');
    });

    test('fill-extrusion bucket matches legacy for polygon height/base expressions', () => {
        const layer = applyFilter(createFillExtrusionLayer({
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-base': ['get', 'base']
        }), ['>=', ['get', 'height'], 6]);
        const legacyBucket = new FillExtrusionBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<FillExtrusionStyleLayer>);
        const columnarBucket = new ColumnarFillExtrusionBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<FillExtrusionStyleLayer>);

        legacyBucket.populate(createSyntheticLegacyPolygonFeatures(), createPopulateOptions([]), canonical);
        columnarBucket.populate(createSyntheticPolygonFeatureTable(), createPopulateOptions([]), canonical);

        expect(columnarBucket.layoutVertexArray).toHaveLength(legacyBucket.layoutVertexArray.length);
        expect(columnarBucket.centroidVertexArray).toHaveLength(legacyBucket.centroidVertexArray.length);
        expect(columnarBucket.indexArray.length).toBeGreaterThan(0);
        expect(legacyBucket.indexArray.length).toBeGreaterThan(0);
        expect(columnarBucket.segments.get()).toHaveLength(legacyBucket.segments.get().length);
        expectPaintBytesEqual(legacyBucket, columnarBucket, layer.id, 'fill-extrusion-height');
        expectPaintBytesEqual(legacyBucket, columnarBucket, layer.id, 'fill-extrusion-base');
    });

    test('fill-extrusion columnar bucket survives worker transfer with geometry buffers', () => {
        const layer = applyFilter(createFillExtrusionLayer({
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-base': ['get', 'base']
        }), ['>=', ['get', 'height'], 6]);
        const bucket = new ColumnarFillExtrusionBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<FillExtrusionStyleLayer>);

        bucket.populate(createSyntheticPolygonFeatureTable(), createPopulateOptions([]), canonical);
        const roundTripped = deserialize(serialize(bucket)) as ColumnarFillExtrusionBucket;

        expect(roundTripped.layoutVertexArray).toHaveLength(bucket.layoutVertexArray.length);
        expect(roundTripped.centroidVertexArray).toHaveLength(bucket.centroidVertexArray.length);
        expect(roundTripped.indexArray).toHaveLength(bucket.indexArray.length);
        expect(roundTripped.segments.get()).toEqual(bucket.segments.get());
    });

    test('line bucket collects data-driven dash and pattern dependencies like legacy', () => {
        const layer = applyFilter(createLineLayer(undefined, {
            'line-pattern': ['get', 'pattern'],
            'line-dasharray': ['case', ['==', ['get', 'dash'], 1], ['literal', [2, 1]], ['literal', [1, 2]]]
        }), ['in', ['get', 'kind'], ['literal', ['primary', 'secondary']]]);
        const legacyBucket = new LineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);
        const columnarBucket = new ColumnarLineBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<LineStyleLayer>);
        const legacyOptions = createPopulateOptions(['stripe', 'dot']);
        const columnarOptions = createPopulateOptions(['stripe', 'dot']);

        legacyBucket.populate(createSyntheticLegacyLineFeatures(), legacyOptions, canonical);
        populateStrictly(() => columnarBucket.populate(createSyntheticLineFeatureTable(), columnarOptions, canonical));

        expect(columnarOptions.patternDependencies).toEqual(legacyOptions.patternDependencies);
        expect(columnarOptions.dashDependencies).toEqual({
            '1,2,false': {dasharray: [1, 2], round: false},
            '2,1,false': {dasharray: [2, 1], round: false},
        });
    });

    test('polygon buckets collect data-driven pattern dependencies like legacy', () => {
        const fillLayer = applyFilter(createFillLayer(undefined, {
            'fill-pattern': ['get', 'pattern']
        }), ['!=', ['get', 'kind'], 'outside']);
        const fillExtrusionLayer = applyFilter(createFillExtrusionLayer({
            'fill-extrusion-pattern': ['get', 'pattern'],
            'fill-extrusion-height': ['get', 'height']
        }), ['>=', ['get', 'height'], 6]);
        const legacyFillBucket = new FillBucket({layers: [fillLayer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<FillStyleLayer>);
        const columnarFillBucket = new ColumnarFillBucket({layers: [fillLayer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<FillStyleLayer>);
        const legacyFillOptions = createPopulateOptions(['grid', 'cross']);
        const columnarFillOptions = createPopulateOptions(['grid', 'cross']);
        const legacyFillExtrusionBucket = new FillExtrusionBucket({layers: [fillExtrusionLayer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<FillExtrusionStyleLayer>);
        const columnarFillExtrusionBucket = new ColumnarFillExtrusionBucket({layers: [fillExtrusionLayer], zoom: 0, overscaling: 1, index: 0} as BucketParameters<FillExtrusionStyleLayer>);
        const legacyFillExtrusionOptions = createPopulateOptions(['grid', 'cross']);
        const columnarFillExtrusionOptions = createPopulateOptions(['grid', 'cross']);

        legacyFillBucket.populate(createSyntheticLegacyPolygonFeatures(), legacyFillOptions, canonical);
        populateStrictly(() => columnarFillBucket.populate(createSyntheticPolygonFeatureTable(), columnarFillOptions, canonical));
        legacyFillExtrusionBucket.populate(createSyntheticLegacyPolygonFeatures(), legacyFillExtrusionOptions, canonical);
        populateStrictly(() => columnarFillExtrusionBucket.populate(createSyntheticPolygonFeatureTable(), columnarFillExtrusionOptions, canonical));

        expect(columnarFillOptions.patternDependencies).toEqual(legacyFillOptions.patternDependencies);
        expect(columnarFillExtrusionOptions.patternDependencies).toEqual(legacyFillExtrusionOptions.patternDependencies);
    });
});
