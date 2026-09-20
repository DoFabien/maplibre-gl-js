import {describe, expect, test, vi} from 'vitest';
import {featureFilter, type ExpressionSpecification, type GlobalProperties} from '@maplibre/maplibre-gl-style-spec';
import {createConstGeometryVector, createNullableStringVector, FeatureTable, GEOMETRY_TYPE, IntFlatVector, TopologyVector} from '@maplibre/mlt';
import filter, {createMltFilterEvaluator, getMltFilterSupport} from './filter.ts';
import {CanonicalTileID} from '../../../tile/tile_id.ts';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {rtlWorkerPlugin} from '../../../source/rtl_text_plugin_worker.ts';
import {StyleLayerIndex} from '../../../style/style_layer_index.ts';
import {CollisionBoxArray} from '../../array_types.g.ts';
import {SymbolBucket} from '../../bucket/symbol_bucket.ts';
import {createPopulateOptions} from '../../../../test/unit/lib/tile.ts';
import {createSyntheticMltTile, syntheticLineLayer, syntheticPointLayer, syntheticPolygonLayer} from '../../../../test/unit/lib/mlt_synthetic.ts';
import {getMltFeatureTable} from '../../../source/vector_tile_mlt.ts';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../../../util/mlt_materialization_stats.ts';

const canonical = new CanonicalTileID(0, 0, 0);
const rows = [
    {name: 'Paris', rank: 1},
    {name: 'مرحبا', rank: 2},
    {name: 'नमस्ते', rank: 3},
    {name: null, rank: 4},
];

function table(): FeatureTable {
    return new FeatureTable('points',
        createConstGeometryVector(4, GEOMETRY_TYPE.POINT, new TopologyVector(null, null, null), null, new Int32Array([10, 10, 20, 20, 30, 30, 40, 40])),
        new IntFlatVector('id', new Int32Array([1, 2, 3, 4]), 4),
        [createNullableStringVector(rows.map(r => r.name), 'name'), new IntFlatVector('rank', new Int32Array([1, 2, 3, 4]), 4)]);
}

function expectParity(expression: ExpressionSpecification, globals: GlobalProperties): void {
    expect(getMltFilterSupport(expression)).toEqual({supported: true});
    const native = featureFilter(expression, 'globals parity');
    const expected = rows.flatMap((properties, index) => native.filter(globals, {type: 1, properties, id: index + 1}, canonical) ? [index] : []);
    const stats = createMltMaterializationStats({strict: true});
    const restore = activateMltMaterializationStats(stats);
    try {
        const data = table();
        const selected = filter(data, expression, undefined, canonical, globals);
        expect(Array.from({length: selected.limit}, (_, i) => selected.getIndex(i))).toEqual(expected);
        const evaluator = createMltFilterEvaluator(expression, undefined, canonical, globals);
        expect(rows.flatMap((_, i) => evaluator.matches(data, i) ? [i] : [])).toEqual(expected);
        for (const counter of stats.forbiddenCounters) expect(stats.counters[counter]).toBe(0);
    } finally {
        restore();
    }
}

describe('MLT filter runtime globals', () => {
    test.each(['circle', 'heatmap', 'line', 'fill', 'fill-extrusion', 'symbol'] as const)('%s bucket uses effective zoom and script globals', type => {
        const sourceLayer = type === 'line' ? syntheticLineLayer : type === 'fill' || type === 'fill-extrusion' ? syntheticPolygonLayer : syntheticPointLayer;
        const data = getMltFeatureTable(createSyntheticMltTile().layers[sourceLayer]);
        const index = new StyleLayerIndex([{
            id: 'globals', type, source: 'source', 'source-layer': sourceLayer,
            filter: ['all', ['==', ['zoom'], 3], ['is-supported-script', 'Paris']],
            ...(type === 'symbol' ? {layout: {'text-field': 'A', 'text-font': ['Test']}} : {}),
        } as any]);
        const layer = index.familiesBySource.source[sourceLayer][0][0];
        for (const zoom of [0, 3]) {
            layer.recalculate(new EvaluationParameters(zoom), []);
            const bucket = layer.createBucket({layers: [layer], zoom, overscaling: 8, pixelRatio: 1, index: 0, encoding: 'mlt', collisionBoxArray: new CollisionBoxArray(), sourceLayerIndex: 0, sourceID: 'source'});
            const stats = createMltMaterializationStats({strict: true});
            const restore = activateMltMaterializationStats(stats);
            try {
                bucket.populate(data, createPopulateOptions([]), canonical);
                const selected = bucket instanceof SymbolBucket ? bucket.features.length : (bucket as any).featureIndexSelectionVector.limit;
                expect(selected).toBe(zoom === 3 ? data.numFeatures : 0);
            } finally {
                restore();
            }
            for (const counter of stats.forbiddenCounters) expect(stats.counters[counter]).toBe(0);
        }
    });

    test.each([
        {name: 'without callback', globals: {zoom: 3}},
        {name: 'custom callback', globals: {zoom: 3, isSupportedScript: (value: string) => value === 'Paris'}},
    ])('matches native script evaluation $name including errors and short circuiting', ({globals}) => {
        const expressions: ExpressionSpecification[] = [
            ['is-supported-script', ['get', 'name']],
            ['!', ['is-supported-script', ['get', 'name']]],
            ['==', ['is-supported-script', ['get', 'name']], false],
            ['is-supported-script', ['string', ['get', 'rank']]],
            ['is-supported-script', ['to-string', ['get', 'rank']]],
            ['any', true, ['is-supported-script', ['get', 'missing']]],
            ['all', false, ['is-supported-script', ['get', 'missing']]],
            ['let', 'valid', ['is-supported-script', ['get', 'name']], ['case', ['var', 'valid'], true, false]],
            ['case', ['==', ['get', 'rank'], 4], false, ['is-supported-script', ['get', 'name']]],
        ];
        for (const expression of expressions) expectParity(expression, globals);
    });

    test('uses the effective zoom in scalar expressions and nested scopes', () => {
        for (const zoom of [0, 3, 4.5]) {
            for (const expression of [
                ['>=', ['zoom'], 3],
                ['==', ['get', 'rank'], ['zoom']],
                ['let', 'z', ['zoom'], ['all', ['>', ['var', 'z'], 1], ['<', ['get', 'rank'], ['var', 'z']]]],
                ['case', ['>=', ['zoom'], 3], ['is-supported-script', ['get', 'name']], false],
            ] as ExpressionSpecification[]) expectParity(expression, {zoom, isSupportedScript: value => value === 'Paris'});
        }
    });

    test.each(['unavailable', 'loaded'] as const)('uses actual EvaluationParameters with RTL plugin %s', status => {
        const pluginStatus = vi.spyOn(rtlWorkerPlugin, 'getRTLTextPluginStatus').mockReturnValue(status);
        try {
            expectParity(['is-supported-script', ['get', 'name']], new EvaluationParameters(3));
        } finally {
            pluginStatus.mockRestore();
        }
    });

    test('rejects invalid argument types and preserves the explicit distance gap', () => {
        for (const expression of [
            ['is-supported-script', 1],
            ['is-supported-script'],
            ['zoom', 1],
            ['<', ['distance', {type: 'Point', coordinates: [0, 0]}], 1000],
        ]) expect(getMltFilterSupport(expression as ExpressionSpecification).supported).toBe(false);
    });
});
