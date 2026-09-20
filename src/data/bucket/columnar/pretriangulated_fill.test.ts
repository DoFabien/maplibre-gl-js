import {readFileSync, writeFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';
import {decodeTile, FeatureTable, GEOMETRY_TYPE, GpuVector} from '@maplibre/mlt';
import {createConstGpuVector} from '@maplibre/mlt/dist/vector/geometry/constGpuVector';
import {FillStyleLayer} from '../../../style/style_layer/fill_style_layer';
import {EvaluationParameters} from '../../../style/evaluation_parameters';
import {CanonicalTileID} from '../../../tile/tile_id';
import {SubdivisionGranularityExpression, SubdivisionGranularitySetting} from '../../../render/subdivision_granularity_settings';
import {activateMltMaterializationStats, createMltMaterializationStats} from '../../../util/mlt_materialization_stats';
import {SegmentVector} from '../../segment';
import {createPopulateOptions} from '../../../../test/unit/lib/tile';
import {ColumnarFillBucket} from './columnar_fill_bucket';

function bucket(overscaling = 1): ColumnarFillBucket {
    const layer = new FillStyleLayer({id: 'fill', type: 'fill', source: 'source'}, {});
    layer.recalculate(new EvaluationParameters(14), []);
    return new ColumnarFillBucket({layers: [layer], zoom: 14, overscaling, index: 0} as any);
}

/** A valid square with the other diagonal than Earcut uses, proving consumption of supplied indices. */
function square(extent = 8192, indices = [0, 1, 2, 0, 2, 3]): FeatureTable {
    return new FeatureTable('square', createConstGpuVector(1, GEOMETRY_TYPE.POLYGON,
        new Uint32Array([0, indices.length / 3]), new Uint32Array(indices),
        new Int32Array([10, 10, 20, 10, 20, 20, 10, 20]),
        {geometryOffsets: undefined, partOffsets: new Uint32Array([0, 1]), ringOffsets: new Uint32Array([0, 4])}), undefined, [], extent);
}

/** Resolves final segment-relative indices to tile coordinates, without depending on vertex packing. */
function primitives(result: ColumnarFillBucket, outline: boolean): number[][] {
    const array = outline ? result.indexArray2 : result.indexArray;
    const segments = outline ? result.segments2 : result.segments;
    const arity = outline ? 2 : 3;
    const values: number[][] = [];
    for (const segment of segments.get()) for (let i = 0; i < segment.primitiveLength; i++) {
        const primitive: number[] = [];
        for (let j = 0; j < arity; j++) {
            const vertex = segment.vertexOffset + array.uint16[(segment.primitiveOffset + i) * arity + j];
            primitive.push(result.layoutVertexArray.int16[vertex * 2], result.layoutVertexArray.int16[vertex * 2 + 1]);
        }
        values.push(primitive);
    }
    return values;
}

function area(result: ColumnarFillBucket): number {
    return primitives(result, false).reduce((sum, [ax, ay, bx, by, cx, cy]) => sum + Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)), 0);
}

describe('pretriangulated MLT fills', () => {
    test('writes supplied triangles, winding and closed outlines without Earcut or input mutation', () => {
        const table = square();
        const originalIndices = (table.geometryVector as GpuVector).indexBuffer.slice();
        const result = bucket();
        const stats = createMltMaterializationStats({strict: true});
        const restore = activateMltMaterializationStats(stats);
        try {
            result.populate(table, createPopulateOptions([]), new CanonicalTileID(14, 8802, 5374));
            expect(primitives(result, false)).toEqual([[10, 10, 20, 20, 20, 10], [10, 10, 10, 20, 20, 20]]);
            expect(primitives(result, true)).toEqual([[10, 10, 20, 10], [20, 10, 20, 20], [20, 20, 10, 20], [10, 20, 10, 10]]);
            expect(result.featureIndexBBoxes).toEqual([[10, 10, 20, 20]]);
            expect((table.geometryVector as GpuVector).indexBuffer).toEqual(originalIndices);
            expect(stats.counters.pretriangulatedFillFeatures).toBe(1);
            expect(stats.counters.pretriangulatedFillTriangles).toBe(2);
            const reference = bucket(2);
            reference.populate(table, createPopulateOptions([]), new CanonicalTileID(14, 8802, 5374));
            expect(primitives(result, false)).not.toEqual(primitives(reference, false));
        } finally { restore(); }
    });

    test.each(['rounding', 'clamping', 'indices', 'offsets', 'overzoom', 'globe', 'poles', 'large', 'degenerate'])(
        'retains numeric triangulation for %s without partial mesh writes', reason => {
            const table = square(reason === 'rounding' ? 16384 : reason === 'clamping' ? 8 : 8192,
                reason === 'indices' ? [0, 1, 9, 0, 2, 3] : undefined);
            if (reason === 'offsets') (table.geometryVector as GpuVector).triangleOffsets[1] = 10;
            if (reason === 'degenerate') table.geometryVector.vertexBuffer.set([10, 10, 20, 10, 30, 10, 40, 10]);
            const options = createPopulateOptions([]);
            if (reason === 'globe') options.subdivisionGranularity = new SubdivisionGranularitySetting({
                ...SubdivisionGranularitySetting.noSubdivision, fill: new SubdivisionGranularityExpression(512, 1)});
            const canonical = new CanonicalTileID(14, 8802, reason === 'poles' ? 0 : 5374);
            const maximum = SegmentVector.MAX_VERTEX_ARRAY_LENGTH;
            if (reason === 'large') SegmentVector.MAX_VERTEX_ARRAY_LENGTH = 4;
            const result = bucket(reason === 'overzoom' ? 2 : 1);
            const reference = bucket(2);
            const stats = createMltMaterializationStats({strict: true});
            const restore = activateMltMaterializationStats(stats);
            try {
                result.populate(table, options, canonical);
                reference.populate(table, options, canonical);
                expect(primitives(result, false)).toEqual(primitives(reference, false));
                expect(primitives(result, true)).toEqual(primitives(reference, true));
                expect(result.featureIndexBBoxes).toEqual(reference.featureIndexBBoxes);
                expect(stats.counters.pretriangulatedFillFeatures).toBe(0);
            } finally { restore(); SegmentVector.MAX_VERTEX_ARRAY_LENGTH = maximum; }
        });

    test('keeps triangle and outline indices relative to each new 16-bit segment', () => {
        const maximum = SegmentVector.MAX_VERTEX_ARRAY_LENGTH;
        SegmentVector.MAX_VERTEX_ARRAY_LENGTH = 7;
        const result = bucket();
        const stats = createMltMaterializationStats({strict: true});
        const restore = activateMltMaterializationStats(stats);
        try {
            for (const delta of [0, 30, 60]) {
                const table = square();
                for (let i = 0; i < table.geometryVector.vertexBuffer.length; i++) table.geometryVector.vertexBuffer[i] += delta;
                result.populate(table, createPopulateOptions([]), new CanonicalTileID(14, 8802, 5374));
            }
            expect(result.segments.get().map(segment => segment.vertexOffset)).toEqual([0, 4, 8]);
            expect(result.segments2.get().map(segment => segment.vertexOffset)).toEqual([0, 4, 8]);
            expect(primitives(result, false).filter((_value, i) => i % 2 === 0).map(value => value[0])).toEqual([10, 40, 70]);
            expect(primitives(result, true).filter((_value, i) => i % 4 === 0).map(value => value[0])).toEqual([10, 40, 70]);
            expect(stats.counters.pretriangulatedFillFeatures).toBe(3);
        } finally { restore(); SegmentVector.MAX_VERTEX_ARRAY_LENGTH = maximum; }
    });

    test.each(['14-8802-5374', '14-8802-5375', '14-8803-5374', '14-8803-5375'])(
        'preserves areas, outlines and bounds from Java-encoded %s meshes', name => {
            const tables = decodeTile(new Uint8Array(readFileSync(`test/integration/assets/tiles/mlt/gl-js/${name}.mlt`)));
            const [, x, y] = name.split('-').map(Number);
            const stats = createMltMaterializationStats({strict: true});
            const restore = activateMltMaterializationStats(stats);
            try {
                let expectedFeatures = 0;
                const buffers: Array<{layer: string; before: ReturnType<typeof bufferSize>; after: ReturnType<typeof bufferSize>}> = [];
                for (const table of tables.filter(table => table.geometryVector instanceof GpuVector)) {
                    const offsets = (table.geometryVector as GpuVector).triangleOffsets;
                    expectedFeatures += Array.from(offsets).slice(1).filter((value, index) => value > offsets[index]).length;
                    const direct = bucket();
                    const reference = bucket(2);
                    const canonical = new CanonicalTileID(14, x, y);
                    direct.populate(table, createPopulateOptions([]), canonical);
                    reference.populate(table, createPopulateOptions([]), canonical);
                    expect(area(direct), table.name).toBe(area(reference));
                    expect(primitives(direct, true), table.name).toEqual(primitives(reference, true));
                    expect(direct.featureIndexBBoxes, table.name).toEqual(reference.featureIndexBBoxes);
                    buffers.push({layer: table.name, before: bufferSize(reference), after: bufferSize(direct)});
                }
                expect(expectedFeatures).toBeGreaterThan(0);
                expect(stats.counters.pretriangulatedFillFeatures).toBe(expectedFeatures);
                if (process.env.MLT_PRETRIANGULATED_BUFFER_OUTPUT) writeFileSync(`${process.env.MLT_PRETRIANGULATED_BUFFER_OUTPUT}/${name}.json`,
                    JSON.stringify({name, buffers, counters: stats.counters}, null, 2), {flag: 'wx'});
            } finally { restore(); }
        });
});

/** Exact used geometry bytes sent to upload, excluding paint arrays, spare capacity and GPU driver overhead. */
function bufferSize(result: ColumnarFillBucket) {
    return {vertices: result.layoutVertexArray.length, triangles: result.indexArray.length, lines: result.indexArray2.length,
        bytes: result.layoutVertexArray.length * result.layoutVertexArray.bytesPerElement +
            result.indexArray.length * result.indexArray.bytesPerElement + result.indexArray2.length * result.indexArray2.bytesPerElement};
}
