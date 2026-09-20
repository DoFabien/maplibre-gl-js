import {createBucketDependencies} from '../../../../test/unit/lib/tile.ts';
import {describe, expect, test} from 'vitest';
import Point from '@mapbox/point-geometry';
import {featureFilter} from '@maplibre/maplibre-gl-style-spec';
import {
    createConstGeometryVector,
    createStringFlatVector,
    FeatureTable,
    GEOMETRY_TYPE,
    IntFlatVector,
    TopologyVector,
    type Vector,
} from '@maplibre/mlt';
import {FillStyleLayer} from '../../../style/style_layer/fill_style_layer';
import {LineStyleLayer} from '../../../style/style_layer/line_style_layer';
import {FillBucket} from '../fill_bucket';
import {LineBucket} from '../line_bucket';
import {ColumnarFillBucket} from './columnar_fill_bucket';
import {ColumnarLineBucket} from './columnar_line_bucket';
import {createPopulateOptions} from '../../../../test/unit/lib/tile';
import {CanonicalTileID} from '../../../tile/tile_id';
import {SubdivisionGranularityExpression, SubdivisionGranularitySetting} from '../../../render/subdivision_granularity_settings';

import type {BucketParameters, IndexedFeature} from '../../bucket';
import type {ZoomHistory} from '../../../style/zoom_history';
import type {EvaluationParameters} from '../../../style/evaluation_parameters';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';

type PolygonFeatureInput = {
    id: number;
    rings: Array<Array<[number, number]>>;
    properties: Record<string, unknown>;
};

type LineFeatureInput = {
    id: number;
    line: Array<[number, number]>;
    properties: Record<string, unknown>;
};

function createFillLayer(layout?: Record<string, any>, paint?: Record<string, any>): FillStyleLayer {
    const layer = new FillStyleLayer({
        id: 'fill-layer',
        type: 'fill',
        layout,
        paint
    } as LayerSpecification, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

function createLineLayer(layout?: Record<string, any>, paint?: Record<string, any>): LineStyleLayer {
    const layer = new LineStyleLayer({
        id: 'line-layer',
        type: 'line',
        layout,
        paint
    } as LayerSpecification, {});
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

function createPolygonFeatureTable(features: PolygonFeatureInput[], propertyVectors: Vector[]): FeatureTable {
    const partOffsets = new Uint32Array(features.length + 1);
    const ringOffsets: number[] = [0];
    const vertexBuffer: number[] = [];
    let ringCount = 0;
    let vertexCount = 0;

    for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
        partOffsets[featureIndex] = ringCount;
        for (const ring of features[featureIndex].rings) {
            for (const [x, y] of ring) {
                vertexBuffer.push(x, y);
                vertexCount++;
            }
            ringCount++;
            ringOffsets.push(vertexCount);
        }
    }
    partOffsets[features.length] = ringCount;

    return new FeatureTable(
        'test',
        createConstGeometryVector(
            features.length,
            GEOMETRY_TYPE.POLYGON,
            new TopologyVector(new Uint32Array(0), partOffsets, new Uint32Array(ringOffsets)),
            null,
            new Int32Array(vertexBuffer)
        ),
        new IntFlatVector('id', new Int32Array(features.map(feature => feature.id)), features.length),
        propertyVectors
    );
}

function createLineFeatureTable(features: LineFeatureInput[], propertyVectors: Vector[]): FeatureTable {
    const partOffsets = new Uint32Array(features.length + 1);
    const vertexBuffer: number[] = [];
    let vertexCount = 0;

    for (let featureIndex = 0; featureIndex < features.length; featureIndex++) {
        partOffsets[featureIndex] = vertexCount;
        for (const [x, y] of features[featureIndex].line) {
            vertexBuffer.push(x, y);
            vertexCount++;
        }
    }
    partOffsets[features.length] = vertexCount;

    return new FeatureTable(
        'test',
        createConstGeometryVector(
            features.length,
            GEOMETRY_TYPE.LINESTRING,
            new TopologyVector(null, partOffsets, null),
            null,
            new Int32Array(vertexBuffer)
        ),
        new IntFlatVector('id', new Int32Array(features.map(feature => feature.id)), features.length),
        propertyVectors
    );
}

function createNumberPropertyVector(name: string, values: number[]): Vector {
    return {
        name,
        size: values.length,
        getValue: (index: number) => values[index]
    } as Vector;
}

function createLegacyPolygonFeatures(features: PolygonFeatureInput[]): IndexedFeature[] {
    return features.map((feature, index) => ({
        feature: {
            id: feature.id,
            type: 3,
            properties: feature.properties,
            extent: 4096,
            loadGeometry: () => feature.rings.map(ring => ring.map(([x, y]) => new Point(x, y)))
        },
        id: feature.id,
        index,
        sourceLayerIndex: 0
    } as IndexedFeature));
}

function createLegacyLineFeatures(features: LineFeatureInput[]): IndexedFeature[] {
    return features.map((feature, index) => ({
        feature: {
            id: feature.id,
            type: 2,
            properties: feature.properties,
            extent: 4096,
            loadGeometry: () => [feature.line.map(([x, y]) => new Point(x, y))]
        },
        id: feature.id,
        index,
        sourceLayerIndex: 0
    } as IndexedFeature));
}

function structArrayBytes(array: {arrayBuffer: ArrayBuffer; length: number; bytesPerElement: number}): number[] {
    return Array.from(new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement));
}

function getPaintArrayBytes(bucket: {programConfigurations: any}, layerId: string, property: string): number[] {
    const binder = bucket.programConfigurations.get(layerId).binders[property];
    return structArrayBytes(binder.paintVertexArray);
}

function getPaintArrayValues(bucket: {programConfigurations: any}, layerId: string, property: string): number[] {
    const binder = bucket.programConfigurations.get(layerId).binders[property];
    const array = binder.paintVertexArray;
    return Array.from(new Float32Array(array.arrayBuffer, 0, array.length * (array.bytesPerElement / Float32Array.BYTES_PER_ELEMENT)));
}

function compressRuns(values: number[]): number[] {
    return values.filter((value, index) => index === 0 || value !== values[index - 1]);
}

function compareFillBuckets(legacy: FillBucket, columnar: ColumnarFillBucket) {
    expect(legacy.layoutVertexArray.length).toBeGreaterThan(0);
    expect(columnar.layoutVertexArray.length).toBeGreaterThan(0);
    expect(legacy.indexArray.length).toBeGreaterThan(0);
    expect(columnar.indexArray.length).toBeGreaterThan(0);
    expect(legacy.indexArray2.length).toBeGreaterThan(0);
    expect(columnar.indexArray2.length).toBeGreaterThan(0);
    expect(legacy.programConfigurations._featureMap.ids).toEqual(columnar.programConfigurations._featureMap.ids);
    expect(compressRuns(getPaintArrayValues(legacy as any, legacy.layerIds[0], 'fill-opacity')))
        .toEqual(compressRuns(getPaintArrayValues(columnar as any, columnar.layerIds[0], 'fill-opacity')));
}

function compareLineBuckets(legacy: LineBucket, columnar: ColumnarLineBucket) {
    expect(legacy.layoutVertexArray).toHaveLength(columnar.layoutVertexArray.length);
    expect(structArrayBytes(legacy.layoutVertexArray as any)).toEqual(structArrayBytes(columnar.layoutVertexArray as any));
    expect(structArrayBytes(legacy.indexArray as any)).toEqual(structArrayBytes(columnar.indexArray as any));
    expect(legacy.segments.get()).toEqual(columnar.segments.get());
    expect(structArrayBytes(legacy.layoutVertexArray2 as any)).toEqual(structArrayBytes(columnar.layoutVertexArray2 as any));
    expect(legacy.lineClipsArray).toEqual(columnar.lineClipsArray);
    expect(legacy.maxLineLength).toBe(columnar.maxLineLength);
    expect(getPaintArrayBytes(legacy as any, legacy.layerIds[0], 'line-width'))
        .toEqual(getPaintArrayBytes(columnar as any, columnar.layerIds[0], 'line-width'));
}

describe('Columnar bucket parity', () => {
    const canonical = new CanonicalTileID(0, 0, 0);
    const populateOptions = createPopulateOptions([]);

    test.each([{zoom: 0, pattern: false}, {zoom: 3, pattern: true}])('fill subdivides polygon interiors and outlines at canonical zoom $zoom (pattern: $pattern)', ({zoom, pattern}) => {
        const features: PolygonFeatureInput[] = [{id: 1, properties: {}, rings: [
            [[150, 200], [3900, 100], [3800, 3900], [100, 3700], [150, 200]],
            [[1000, 900], [900, 2800], [2800, 2900], [2900, 1000], [1000, 900]]
        ]}];
        const layer = createFillLayer(undefined, pattern ? {'fill-pattern': 'pattern'} : undefined);
        const options = createPopulateOptions(['pattern']);
        options.subdivisionGranularity = new SubdivisionGranularitySetting({
            ...SubdivisionGranularitySetting.noSubdivision, fill: new SubdivisionGranularityExpression(32, 1)
        });
        const tile = new CanonicalTileID(zoom, 0, 0);
        const legacy = new FillBucket({layers: [layer], zoom, overscaling: 1} as BucketParameters<FillStyleLayer>);
        const columnar = new ColumnarFillBucket({layers: [layer], zoom, overscaling: 1} as BucketParameters<FillStyleLayer>);
        legacy.populate(createLegacyPolygonFeatures(features), options, tile);
        columnar.populate(createPolygonFeatureTable(features, []), options, tile);
        expect(legacy.layoutVertexArray.length === 0).toBe(pattern);
        expect(columnar.layoutVertexArray.length === 0).toBe(pattern);
        if (pattern) {
            const positions = {pattern: {tlbr: [0, 0, 16, 16], pixelRatio: 1}} as any;
            legacy.addFeatures(createBucketDependencies(options, tile, positions));
            columnar.addFeatures(createBucketDependencies(options, tile, positions));
        }
        expect(legacy.layoutVertexArray.length).toBeGreaterThan(10);
        expect(structArrayBytes(columnar.layoutVertexArray)).toEqual(structArrayBytes(legacy.layoutVertexArray));
        expect(structArrayBytes(columnar.indexArray)).toEqual(structArrayBytes(legacy.indexArray));
        expect(structArrayBytes(columnar.indexArray2)).toEqual(structArrayBytes(legacy.indexArray2));
        expect(columnar.segments.get()).toEqual(legacy.segments.get());
        expect(columnar.segments2.get()).toEqual(legacy.segments2.get());
    });

    test.each([{zoom: 0, polygon: false, dashed: false}, {zoom: 3, polygon: false, dashed: true}, {zoom: 0, polygon: true, dashed: false}])(
        'line subdivides at canonical zoom $zoom (polygon: $polygon, deferred dashes: $dashed)', ({zoom, polygon, dashed}) => {
            const inputs: LineFeatureInput[] = [
                {id: 1, line: [[100, 200], [3900, 3500]], properties: {width: 3, mapbox_clip_start: 0.1, mapbox_clip_end: 0.8}},
                {id: 2, line: [[100, 200], [100, 200], [800, 2900], [1200, 2700], [1800, 900], [2000, 1500], [2400, 1100], [3000, 1300], [3900, 200], [100, 200]], properties: {width: 2, mapbox_clip_start: 0.2, mapbox_clip_end: 0.9}}
            ];
            const features = inputs.filter(feature => !polygon || feature.id === 2);
            const properties = ['width', 'mapbox_clip_start', 'mapbox_clip_end'].map(name => createNumberPropertyVector(name, features.map(feature => feature.properties[name] as number)));
            const polygons = features.map(feature => ({...feature, rings: [feature.line]}));
            const layer = createLineLayer({'line-cap': 'square'}, {'line-width': ['get', 'width'], ...(dashed ? {'line-dasharray': ['case', ['has', 'width'], ['literal', [2, 1]], ['literal', [1, 2]]]} : {})});
            const options = createPopulateOptions([]);
            options.subdivisionGranularity = new SubdivisionGranularitySetting({
                ...SubdivisionGranularitySetting.noSubdivision, line: new SubdivisionGranularityExpression(32, 1)
            });
            const tile = new CanonicalTileID(zoom, 0, 0);
            const legacy = new LineBucket({layers: [layer], zoom, overscaling: 1} as BucketParameters<LineStyleLayer>);
            const columnar = new ColumnarLineBucket({layers: [layer], zoom, overscaling: 1} as BucketParameters<LineStyleLayer>);
            legacy.populate(polygon ? createLegacyPolygonFeatures(polygons) : createLegacyLineFeatures(features), options, tile);
            columnar.populate(polygon ? createPolygonFeatureTable(polygons, properties) : createLineFeatureTable(features, properties), options, tile);
            expect(legacy.layoutVertexArray.length === 0).toBe(dashed);
            expect(columnar.layoutVertexArray.length === 0).toBe(dashed);
            if (dashed) {
                const positions = {'2,1,false': {y: 0, height: 16, width: 256}};
                legacy.addFeatures(createBucketDependencies(options, tile, {}, positions));
                columnar.addFeatures(createBucketDependencies(options, tile, {}, positions));
            }
            compareLineBuckets(legacy, columnar);
        });

    test('fill bucket matches legacy output for filter, sort and data-driven paint', () => {
        expect.hasAssertions();
        const features: PolygonFeatureInput[] = [
            {
                id: 1,
                rings: [[[0, 0], [12, 0], [12, 12], [0, 12]]],
                properties: {kind: 'keep', sort: 2, opacity: 8}
            },
            {
                id: 2,
                rings: [[[20, 0], [28, 0], [24, 8]]],
                properties: {kind: 'skip', sort: 0, opacity: 2}
            },
            {
                id: 3,
                rings: [[[40, 0], [48, 0], [48, 8], [40, 8]]],
                properties: {kind: 'keep', sort: 1, opacity: 4}
            }
        ];
        const featureTable = createPolygonFeatureTable(features, [
            createStringFlatVector(features.map(feature => feature.properties.kind as string), 'kind'),
            new IntFlatVector('sort', new Int32Array(features.map(feature => feature.properties.sort as number)), features.length),
            new IntFlatVector('opacity', new Int32Array(features.map(feature => feature.properties.opacity as number)), features.length),
        ]);
        const layer = createFillLayer(
            {'fill-sort-key': ['get', 'sort']},
            {'fill-opacity': ['get', 'opacity']}
        );
        layer.filter = ['==', 'kind', 'keep'] as any;
        layer._featureFilter = featureFilter(layer.filter, 'layers[fill-parity].filter');

        const legacyBucket = new FillBucket({layers: [layer]} as BucketParameters<FillStyleLayer>);
        const columnarBucket = new ColumnarFillBucket({layers: [layer]} as BucketParameters<FillStyleLayer>);

        legacyBucket.populate(createLegacyPolygonFeatures(features), populateOptions, canonical);
        columnarBucket.populate(featureTable, populateOptions, canonical);

        compareFillBuckets(legacyBucket, columnarBucket);
    });

    test('line bucket matches legacy output for filter, sort and data-driven paint', () => {
        expect.hasAssertions();
        const features: LineFeatureInput[] = [
            {
                id: 11,
                line: [[0, 0], [10, 10], [20, 8]],
                properties: {kind: 'keep', sort: 2, width: 5}
            },
            {
                id: 12,
                line: [[0, 20], [10, 24], [20, 30]],
                properties: {kind: 'skip', sort: 0, width: 2}
            },
            {
                id: 13,
                line: [[0, 40], [8, 48], [18, 42]],
                properties: {kind: 'keep', sort: 1, width: 3}
            }
        ];
        const featureTable = createLineFeatureTable(features, [
            createStringFlatVector(features.map(feature => feature.properties.kind as string), 'kind'),
            new IntFlatVector('sort', new Int32Array(features.map(feature => feature.properties.sort as number)), features.length),
            new IntFlatVector('width', new Int32Array(features.map(feature => feature.properties.width as number)), features.length),
        ]);
        const layer = createLineLayer(
            {'line-sort-key': ['get', 'sort']},
            {'line-width': ['get', 'width']}
        );
        layer.filter = ['==', 'kind', 'keep'] as any;
        layer._featureFilter = featureFilter(layer.filter, 'layers[line-parity].filter');

        const legacyBucket = new LineBucket({layers: [layer]} as BucketParameters<LineStyleLayer>);
        const columnarBucket = new ColumnarLineBucket({layers: [layer]} as BucketParameters<LineStyleLayer>);

        legacyBucket.populate(createLegacyLineFeatures(features), populateOptions, canonical);
        columnarBucket.populate(featureTable, populateOptions, canonical);

        compareLineBuckets(legacyBucket, columnarBucket);
    });

    test('line bucket matches legacy output for clipped line-gradient data', () => {
        expect.hasAssertions();
        const features: LineFeatureInput[] = [
            {
                id: 21,
                line: [[0, 0], [10, 0], [20, 10]],
                properties: {kind: 'keep', sort: 2, width: 5, mapbox_clip_start: 0.25, mapbox_clip_end: 0.75}
            },
            {
                id: 22,
                line: [[0, 20], [10, 24], [20, 30]],
                properties: {kind: 'skip', sort: 0, width: 2, mapbox_clip_start: 0.1, mapbox_clip_end: 0.3}
            },
            {
                id: 23,
                line: [[0, 40], [8, 48], [18, 42]],
                properties: {kind: 'keep', sort: 1, width: 3, mapbox_clip_start: 0.4, mapbox_clip_end: 0.9}
            }
        ];
        const featureTable = createLineFeatureTable(features, [
            createStringFlatVector(features.map(feature => feature.properties.kind as string), 'kind'),
            new IntFlatVector('sort', new Int32Array(features.map(feature => feature.properties.sort as number)), features.length),
            new IntFlatVector('width', new Int32Array(features.map(feature => feature.properties.width as number)), features.length),
            createNumberPropertyVector('mapbox_clip_start', features.map(feature => feature.properties.mapbox_clip_start as number)),
            createNumberPropertyVector('mapbox_clip_end', features.map(feature => feature.properties.mapbox_clip_end as number)),
        ]);
        const layer = createLineLayer(
            {'line-sort-key': ['get', 'sort']},
            {
                'line-width': ['get', 'width'],
                'line-gradient': [
                    'interpolate',
                    ['linear'],
                    ['line-progress'],
                    0,
                    '#000000',
                    1,
                    '#ffffff'
                ]
            }
        );
        layer.filter = ['==', 'kind', 'keep'] as any;
        layer._featureFilter = featureFilter(layer.filter, 'layers[line-gradient-parity].filter');

        const legacyBucket = new LineBucket({layers: [layer]} as BucketParameters<LineStyleLayer>);
        const columnarBucket = new ColumnarLineBucket({layers: [layer]} as BucketParameters<LineStyleLayer>);

        legacyBucket.populate(createLegacyLineFeatures(features), populateOptions, canonical);
        columnarBucket.populate(featureTable, populateOptions, canonical);

        compareLineBuckets(legacyBucket, columnarBucket);
    });
});
