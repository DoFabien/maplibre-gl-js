import {describe, expect, test} from 'vitest';
import Point from '@mapbox/point-geometry';
import {createConstGeometryVector, FeatureTable, GEOMETRY_TYPE, IntFlatVector, TopologyVector} from '@maplibre/mlt';
import {HeatmapStyleLayer} from '../../../style/style_layer/heatmap_style_layer.ts';
import {EvaluationParameters} from '../../../style/evaluation_parameters.ts';
import {CanonicalTileID} from '../../../tile/tile_id.ts';
import {HeatmapBucket} from '../heatmap_bucket.ts';
import {ColumnarCircleBucket} from './columnar_circle_bucket.ts';
import {createPopulateOptions} from '../../../../test/unit/lib/tile.ts';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../../../util/mlt_materialization_stats.ts';
import {deserialize, serialize} from '../../../util/web_worker_transfer.ts';

import type {StructArray} from '../../../util/struct_array.ts';
import type {IndexedFeature} from '../../bucket.ts';

const canonical = new CanonicalTileID(0, 0, 0);

function pointTable(): FeatureTable {
    return new FeatureTable('points', createConstGeometryVector(
        2, GEOMETRY_TYPE.MULTIPOINT, new TopologyVector(new Uint32Array([0, 3, 4]), null, null),
        null, new Int32Array([1024, 1024, 2048, 2048, -100, 100, 3072, 3072])),
    new IntFlatVector('id', new Int32Array([1, 2]), 2), [
        new IntFlatVector('radius', new Int32Array([5, 9]), 2),
        new IntFlatVector('weight', new Int32Array([1, 3]), 2),
    ]);
}

function referenceFeatures(): IndexedFeature[] {
    return [
        {id: 1, radius: 5, weight: 1, points: [[1024, 1024], [2048, 2048], [-100, 100]]},
        {id: 2, radius: 9, weight: 3, points: [[3072, 3072]]},
    ].map((row, index) => ({id: row.id, index, sourceLayerIndex: 0, feature: {
        id: row.id, type: 1, extent: 4096, properties: {radius: row.radius, weight: row.weight},
        loadGeometry: () => [row.points.map(([x, y]) => new Point(x, y))],
    }}));
}

function bytes(array: StructArray): Uint8Array {
    return new Uint8Array(array.arrayBuffer, 0, array.length * array.bytesPerElement);
}

function paintArray(bucket: HeatmapBucket | ColumnarCircleBucket<HeatmapStyleLayer>, property: string): StructArray {
    return (bucket.programConfigurations.get('heatmap').binders[property] as unknown as {paintVertexArray: StructArray}).paintVertexArray;
}

describe('columnar heatmap mesh and paint', () => {
    test.each([1, 3, 5, 7] as const)('matches native multipoints, clipping and paint at granularity %s', granularity => {
        const layer = new HeatmapStyleLayer({id: 'heatmap', type: 'heatmap', source: 'source', 'source-layer': 'points', paint: {
            'heatmap-radius': ['get', 'radius'],
            'heatmap-weight': ['case', ['>', ['get', 'weight'], 1], ['/', ['get', 'weight'], 4], 0.5],
        }}, {});
        layer.recalculate(new EvaluationParameters(0), []);
        const options = {layers: [layer], zoom: 0, overscaling: 1, index: 0};
        const native = layer.createBucket({...options, encoding: 'mvt'});
        const columnar = layer.createBucket({...options, encoding: 'mlt'});
        expect(native).toBeInstanceOf(HeatmapBucket);
        expect(columnar).toBeInstanceOf(ColumnarCircleBucket);
        const populate = createPopulateOptions([]);
        populate.subdivisionGranularity = {...populate.subdivisionGranularity, circle: granularity};
        (native as HeatmapBucket).populate(referenceFeatures(), populate, canonical);
        const stats = createMltMaterializationStats({strict: true});
        const restore = activateMltMaterializationStats(stats);
        try {
            (columnar as ColumnarCircleBucket<HeatmapStyleLayer>).populate(pointTable(), createPopulateWithGranularity(granularity), canonical);
        } finally {
            restore();
        }
        expect(bytes(columnar.layoutVertexArray)).toEqual(bytes(native.layoutVertexArray));
        expect(bytes(columnar.indexArray)).toEqual(bytes(native.indexArray));
        expect(columnar.segments.get()).toEqual(native.segments.get());
        expect(columnar.layoutVertexArray).toHaveLength(3 * (granularity + 1) ** 2);
        for (const property of ['heatmap-radius', 'heatmap-weight']) expect(bytes(paintArray(columnar, property))).toEqual(bytes(paintArray(native, property)));
        for (const counter of stats.forbiddenCounters) expect(stats.counters[counter]).toBe(0);
    });

    test('updates actual transferred paint values without a vector tile layer', () => {
        const layer = new HeatmapStyleLayer({id: 'heatmap', type: 'heatmap', source: 'source', 'source-layer': 'points', paint: {
            'heatmap-radius': ['case', ['boolean', ['feature-state', 'active'], false], ['get', 'radius'], 1],
            'heatmap-weight': ['case', ['boolean', ['feature-state', 'active'], false], ['get', 'weight'], 0],
        }}, {});
        layer.recalculate(new EvaluationParameters(0), []);
        const bucket = layer.createBucket({layers: [layer], zoom: 0, overscaling: 1, index: 0, encoding: 'mlt'}) as ColumnarCircleBucket<HeatmapStyleLayer>;
        const stats = createMltMaterializationStats({strict: true});
        const restore = activateMltMaterializationStats(stats);
        try {
            bucket.populate(pointTable(), createPopulateOptions([]), canonical);
            const transferred = deserialize(serialize(bucket)) as typeof bucket;
            transferred.layers = [layer];
            transferred.stateDependentLayers = [layer];
            expect(transferred.canUpdateFeatureStateWithoutVtLayer()).toBe(true);
            expect(new Float32Array(paintArray(transferred, 'heatmap-radius').arrayBuffer, 0, 12)).toEqual(new Float32Array(12).fill(1));
            transferred.update([{id: '1', state: {active: true}}], undefined, {});
            expect(new Float32Array(paintArray(transferred, 'heatmap-radius').arrayBuffer, 0, 12)).toEqual(new Float32Array([5, 5, 5, 5, 5, 5, 5, 5, 1, 1, 1, 1]));
            expect(new Float32Array(paintArray(transferred, 'heatmap-weight').arrayBuffer, 0, 12)).toEqual(new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0]));
            transferred.update([{id: '1', state: {active: false}}], undefined, {});
            expect(new Float32Array(paintArray(transferred, 'heatmap-radius').arrayBuffer, 0, 12)).toEqual(new Float32Array(12).fill(1));
        } finally {
            restore();
        }
        for (const counter of stats.forbiddenCounters) expect(stats.counters[counter]).toBe(0);
    });
});

function createPopulateWithGranularity(circle: 1 | 3 | 5 | 7) {
    const options = createPopulateOptions([]);
    options.subdivisionGranularity = {...options.subdivisionGranularity, circle};
    return options;
}
