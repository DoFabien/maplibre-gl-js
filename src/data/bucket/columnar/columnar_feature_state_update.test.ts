import {describe, expect, test, vi} from 'vitest';
import {
    createConstGeometryVector,
    FeatureTable,
    GEOMETRY_TYPE,
    IntFlatVector,
    TopologyVector,
} from '@maplibre/mlt';
import {ColumnarCircleBucket} from './columnar_circle_bucket';
import {ColumnarFillBucket} from './columnar_fill_bucket';
import {ColumnarFillExtrusionBucket} from './columnar_fill_extrusion_bucket';
import {ColumnarFeatureStateData} from './columnar_feature_state_data';
import {SymbolBucket} from '../symbol_bucket';
import {CollisionBoxArray} from '../../array_types.g';
import {CircleStyleLayer} from '../../../style/style_layer/circle_style_layer';
import {FillExtrusionStyleLayer} from '../../../style/style_layer/fill_extrusion_style_layer';
import {FillStyleLayer} from '../../../style/style_layer/fill_style_layer';
import {SymbolStyleLayer} from '../../../style/style_layer/symbol_style_layer';

import type {BucketParameters} from '../../bucket';
import type {ZoomHistory} from '../../../style/zoom_history';
import type {EvaluationParameters} from '../../../style/evaluation_parameters';

function recalculate<T extends CircleStyleLayer | FillStyleLayer | FillExtrusionStyleLayer | SymbolStyleLayer>(layer: T): T {
    layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
    return layer;
}

function createFeatureTable(geometryType: GEOMETRY_TYPE): FeatureTable {
    return new FeatureTable(
        'test',
        createConstGeometryVector(
            1,
            geometryType,
            new TopologyVector(null, new Uint32Array([0, 1]), null),
            null,
            new Int32Array([0, 0])
        ),
        new IntFlatVector('id', new Int32Array([7]), 1),
        [
            new IntFlatVector('value', new Int32Array([11]), 1)
        ]
    );
}

describe('columnar feature-state paint updates', () => {
    const cases: Array<{
        name: string;
        layer: () => any;
        bucket: (layer: any) => any;
        geometryType: GEOMETRY_TYPE;
    }> = [
        {
            name: 'fill',
            layer: () => recalculate(new FillStyleLayer({
                id: 'fill',
                type: 'fill',
                paint: {'fill-opacity': ['case', ['boolean', ['feature-state', 'active'], false], ['get', 'value'], 1]}
            } as any, {})),
            bucket: (layer: FillStyleLayer) => new ColumnarFillBucket({layers: [layer]} as BucketParameters<FillStyleLayer>),
            geometryType: GEOMETRY_TYPE.POLYGON,
        },
        {
            name: 'circle',
            layer: () => recalculate(new CircleStyleLayer({
                id: 'circle',
                type: 'circle',
                paint: {'circle-radius': ['case', ['boolean', ['feature-state', 'active'], false], ['get', 'value'], 1]}
            } as any, {})),
            bucket: (layer: CircleStyleLayer) => new ColumnarCircleBucket({layers: [layer]} as BucketParameters<CircleStyleLayer>),
            geometryType: GEOMETRY_TYPE.POINT,
        },
        {
            name: 'fill-extrusion',
            layer: () => recalculate(new FillExtrusionStyleLayer({
                id: 'fill-extrusion',
                type: 'fill-extrusion',
                paint: {'fill-extrusion-height': ['case', ['boolean', ['feature-state', 'active'], false], ['get', 'value'], 1]}
            } as any, {})),
            bucket: (layer: FillExtrusionStyleLayer) => new ColumnarFillExtrusionBucket({layers: [layer]} as BucketParameters<FillExtrusionStyleLayer>),
            geometryType: GEOMETRY_TYPE.POLYGON,
        },
    ];

    test.each(cases)('$name uses FeatureTable feature providers for paint updates', ({layer, bucket, geometryType}) => {
        const styleLayer = layer();
        const columnarBucket = bucket(styleLayer);
        const featureTable = createFeatureTable(geometryType);
        const vtLayer = {
            featureTable,
            feature: vi.fn(() => {
                throw new Error('Unexpected vector tile feature materialization');
            })
        };
        columnarBucket.stateDependentLayers = [styleLayer];
        const updatePaintArrays = vi.spyOn(columnarBucket.programConfigurations, 'updatePaintArrays')
            .mockImplementation((_states, _vtLayer, _layers, _options, featureProvider) => {
                expect(featureProvider).toBeDefined();
                const paintFeatureProvider = featureProvider as (index: number) => {id: unknown; properties: Record<string, unknown>};
                const feature = paintFeatureProvider(0);
                expect(feature.id).toBe(7);
                expect(feature.properties.value).toBe(11);
            });

        columnarBucket.update([{id: '7', state: {active: true}}], vtLayer, {});

        expect(updatePaintArrays).toHaveBeenCalled();
        expect(vtLayer.feature).not.toHaveBeenCalled();
    });

    test('symbol uses transferred columnar state data for paint updates', () => {
        const styleLayer = recalculate(new SymbolStyleLayer({
            id: 'symbol',
            type: 'symbol',
            layout: {
                'text-field': ['get', 'label'],
                'text-font': ['literal', ['Test']],
            },
            paint: {'text-opacity': ['case', ['boolean', ['feature-state', 'active'], false], ['get', 'value'], 1]}
        } as any, {}));
        const bucket = new SymbolBucket({
            layers: [styleLayer],
            zoom: 0,
            overscaling: 1,
            collisionBoxArray: new CollisionBoxArray(),
            sourceLayerIndex: 0,
            sourceID: 'source',
            encoding: 'mlt'
        } as BucketParameters<SymbolStyleLayer>);
        bucket.createArrays();
        const featureTable = new FeatureTable(
            'test',
            createConstGeometryVector(
                1,
                GEOMETRY_TYPE.POINT,
                new TopologyVector(null, null, null),
                null,
                new Int32Array([0, 0])
            ),
            new IntFlatVector('id', new Int32Array([7]), 1),
            [
                new IntFlatVector('value', new Int32Array([11]), 1)
            ]
        );
        const vtLayer = {
            featureTable,
            feature: vi.fn(() => {
                throw new Error('Unexpected vector tile feature materialization');
            })
        };
        bucket.stateDependentLayers = [styleLayer];
        bucket.text.programConfigurations._featureMap.add(7, 0, 0, 1);
        const stateData = ColumnarFeatureStateData.create(
            featureTable,
            bucket.text.programConfigurations._featureMap,
            new Set(['value']),
            () => 7,
        );
        bucket.text.programConfigurations.columnarFeatureStateData = stateData;
        const stateFeature = stateData.getFeatureProvider()(0);
        expect(stateFeature.id).toBe(7);
        expect(stateFeature.properties.value).toBe(11);
        const getFeatureProvider = vi.spyOn(stateData, 'getFeatureProvider');
        const updateTextPaintArrays = vi.spyOn(bucket.text.programConfigurations, 'updatePaintArrays');
        const updateIconPaintArrays = vi.spyOn(bucket.icon.programConfigurations, 'updatePaintArrays')
            .mockImplementation(() => {});

        bucket.update([{id: 'missing', state: {active: true}}], vtLayer as any, {});

        expect(updateTextPaintArrays).toHaveBeenCalled();
        expect(updateTextPaintArrays.mock.calls[0][1]).toBeUndefined();
        expect(updateTextPaintArrays.mock.calls[0][4]).toBeUndefined();
        expect(updateIconPaintArrays).toHaveBeenCalled();
        expect(getFeatureProvider).toHaveBeenCalled();
        expect(vtLayer.feature).not.toHaveBeenCalled();
    });
});
